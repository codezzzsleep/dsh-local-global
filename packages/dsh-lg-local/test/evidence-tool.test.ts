import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { actionFingerprint } from '@local-global/lg-protocol'

import { apply as applyActionGate } from '../src/action-gate.js'
import { apply, topicDir, versionState, resolveEvidenceConfig } from '../src/evidence.js'
import { apply as applyProtect } from '../src/protect.js'
import { agentIn, fakeCtx, git, repo, tmp } from './fake-ctx.js'

interface Added {
  path: string
  digest: string
  commit: string
  rawFiles: number
  producedByTool: boolean
  exitCode: number
  worktreeDirty: boolean
}
interface Checked {
  current: string
  manifests: { topic: string; stale: boolean; reasons: string[]; dirtyAtCreation: boolean }[]
}

/** A repo with the evidence plugin applied to `<repo>/evidence`. */
function setup(extra: Record<string, unknown> = {}, services: Record<string, unknown> = {}) {
  const dir = repo({ 'src/code.txt': 'v1\n' })
  const fake = fakeCtx(services)
  apply(fake.ctx, { evidenceRoot: join(dir, 'evidence'), ...extra })
  const add = async (args: Record<string, unknown>): Promise<Added> =>
    (await fake.tool('lg_evidence_add').execute({ claim: 'it works', environment: 'real', raw: [], result: 'ok', ...args }, { agent: agentIn(dir) })) as Added
  const check = async (): Promise<Checked> => (await fake.tool('lg_evidence_check').execute({}, { agent: agentIn(dir) })) as Checked
  const stale = (): string[] => (fake.services.get('lgEvidence') as { staleTopics(): string[] }).staleTopics()
  const commitAll = (message = 'more'): void => {
    git(dir, 'add', '-A')
    git(dir, 'commit', '--quiet', '-m', message)
  }
  return { dir, fake, add, check, stale, commitAll }
}

const manifestOf = (path: string): Record<string, unknown> & { raw: { path: string; sha256: string; bytes: number; producedByTool?: { exitCode: number } }[] } =>
  JSON.parse(readFileSync(path, 'utf8')) as never

describe('EV-1 / EV-2: lg_evidence_add runs the command and binds a version', () => {
  it('runs in the session directory, records exit status and hashes, and distinguishes commit from digest', async () => {
    const { dir, add } = setup()
    const result = await add({ topic: 'T/real', command: 'echo hello && pwd' })
    expect(result.producedByTool).toBe(true)
    const manifest = manifestOf(result.path)
    expect(manifest['commit']).toBe(git(dir, 'rev-parse', 'HEAD').trim())
    expect(manifest['digest']).toBe(git(dir, 'rev-parse', 'HEAD^{tree}').trim())
    expect(manifest['digest']).not.toBe(manifest['commit'])
    expect(manifest['digestKind']).toBe('tree')
    expect(manifest['worktreeDirty']).toBe(false)
    const rawFile = manifest.raw[0]
    expect(readFileSync(rawFile?.path ?? '', 'utf8')).toContain('hello')
    expect(readFileSync(rawFile?.path ?? '', 'utf8')).toContain(dir.replace('/private', ''))
    expect(rawFile?.producedByTool?.exitCode).toBe(0)
    expect(rawFile?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a missing raw file, and a real claim with only model-provided files', async () => {
    const { dir, add } = setup()
    await expect(add({ topic: 'T/missing', command: 'true', raw: ['nope.txt'] })).rejects.toThrow(/does not exist/)
    writeFileSync(join(dir, 'own.txt'), 'model wrote this\n')
    const simulated = await add({ topic: 'T/sim', environment: 'simulated', command: 'touch should-not-run', raw: ['own.txt'] })
    expect(simulated.producedByTool).toBe(false)
    expect(existsSync(join(dir, 'should-not-run'))).toBe(false)
  })

  it('does not record a failing run as evidence, and cleans up after it', async () => {
    const { dir, add } = setup()
    await expect(add({ topic: 'T/fail', command: 'echo broken; exit 3' })).rejects.toThrow(/status 3, expected 0/)
    expect(existsSync(join(dir, 'evidence', 'T'))).toBe(false)
    // A negative test says what it expects, and then the failure is the evidence.
    const negative = await add({ topic: 'T/neg', command: 'exit 3', expected_exit_code: 3 })
    expect(manifestOf(negative.path).raw[0]?.producedByTool?.exitCode).toBe(3)
    await expect(add({ topic: 'T/neg2', command: 'exit 0', expected_exit_code: 3 })).rejects.toThrow(/status 0, expected 3/)
  })

  it('records an uncommitted worktree instead of silently binding to HEAD', async () => {
    const { dir, add, check } = setup()
    writeFileSync(join(dir, 'src', 'code.txt'), 'v1 edited\n')
    writeFileSync(join(dir, 'new.txt'), 'untracked\n')
    const result = await add({ topic: 'T/dirty', command: 'true' })
    const manifest = manifestOf(result.path)
    expect(manifest['worktreeDirty']).toBe(true)
    expect(manifest['dirtyPaths']).toEqual(expect.arrayContaining(['src/code.txt', 'new.txt']))
    expect(String(manifest['dirtyPaths'])).not.toContain('evidence')
    // The digest is of what was actually run, not of HEAD.
    expect(manifest['digest']).not.toBe(git(dir, 'rev-parse', 'HEAD^{tree}').trim())
    expect((await check()).manifests[0]).toMatchObject({ stale: false, dirtyAtCreation: true })
  })
})

describe('EV-4: stale means the code under test changed', () => {
  it('committing the manifest itself does not make it stale', async () => {
    const { add, check, stale, commitAll } = setup()
    await add({ topic: 'T/a', command: 'echo a' })
    expect((await check()).manifests[0]).toMatchObject({ topic: 'T/a', stale: false })
    commitAll('add evidence')
    expect(await check()).toMatchObject({ manifests: [{ topic: 'T/a', stale: false, reasons: [] }] })
    // Adding a second manifest does not outdate the first.
    await add({ topic: 'T/b', command: 'echo b' })
    commitAll('add more evidence')
    expect(stale()).toEqual([])
  })

  it('changing the code, committed or not, makes it stale; reverting makes it current again', async () => {
    const { dir, add, check, stale, commitAll } = setup()
    await add({ topic: 'T/a', command: 'echo a' })
    writeFileSync(join(dir, 'src', 'code.txt'), 'v2\n')
    expect(stale()).toEqual(['T/a'])
    expect((await check()).manifests[0]?.reasons[0]).toMatch(/digest moved/)
    commitAll('code change')
    expect(stale()).toEqual(['T/a'])
    writeFileSync(join(dir, 'src', 'code.txt'), 'v1\n')
    expect(stale()).toEqual([])
    // An untracked new file is part of the code under test, too.
    writeFileSync(join(dir, 'src', 'added.txt'), 'x\n')
    expect(stale()).toEqual(['T/a'])
  })

  it('editing or deleting a raw file after the manifest makes it stale', async () => {
    const { add, check } = setup()
    const result = await add({ topic: 'T/a', command: 'echo a' })
    const file = manifestOf(result.path).raw[0]?.path ?? ''
    writeFileSync(file, 'edited after the fact\n')
    expect((await check()).manifests[0]?.reasons.join()).toMatch(/raw file changed/)
    rmSync(file)
    expect((await check()).manifests[0]?.reasons.join()).toMatch(/raw file missing/)
  })

  it('reports an unreadable manifest and an unknown digest as stale instead of throwing', async () => {
    const { dir, add, check } = setup()
    await add({ topic: 'T/a', command: 'echo a' })
    mkdirSync(join(dir, 'evidence', 'T', 'bad'), { recursive: true })
    writeFileSync(join(dir, 'evidence', 'T', 'bad', 'manifest.json'), '{ nope')
    const rows = (await check()).manifests
    expect(rows.find((row) => row.topic === 'T/bad')?.reasons[0]).toMatch(/unreadable/)
    expect(rows.find((row) => row.topic === 'T/a')?.stale).toBe(false)
  })

  it('supports a configured digest command and fails closed when it fails', async () => {
    const { add, check } = setup({ digestCommand: 'echo artifact-7' })
    const result = await add({ topic: 'T/art', command: 'true' })
    expect(manifestOf(result.path)).toMatchObject({ digest: 'artifact-7', digestKind: 'command' })
    expect((await check()).manifests[0]?.stale).toBe(false)

    const broken = setup({ digestCommand: 'exit 4' })
    await expect(broken.add({ topic: 'T/x', command: 'true' })).rejects.toThrow(/digest command failed/)
    expect(existsSync(join(broken.dir, 'evidence'))).toBe(false)
  })

  it('refuses to bind evidence when git cannot name the version', async () => {
    const fake = fakeCtx()
    const dir = tmp('nogit')
    apply(fake.ctx, { evidenceRoot: join(dir, 'evidence') })
    await expect(fake.tool('lg_evidence_add').execute({ topic: 'T/a', claim: 'c', environment: 'simulated', command: 'x', raw: [], result: 'r' }, { agent: agentIn(dir) })).rejects.toThrow(/git/)
    const status = (await fake.tool('lg_evidence_check').execute({}, { agent: agentIn(dir) })) as Checked
    expect(status.current).toMatch(/^unavailable/)
  })

  it('versionState excludes the evidence root and nothing else', () => {
    const dir = repo({ 'src/a.txt': '1\n', 'evidence/old.txt': 'x\n' })
    const config = resolveEvidenceConfig({ evidenceRoot: join(dir, 'evidence') }, dir)
    const before = versionState(config, dir)
    writeFileSync(join(dir, 'evidence', 'new.txt'), 'y\n')
    expect(versionState(config, dir)).toMatchObject({ digest: before.digest, dirty: false })
    writeFileSync(join(dir, 'src', 'a.txt'), '2\n')
    expect(versionState(config, dir)).toMatchObject({ dirty: true, dirtyPaths: ['src/a.txt'] })
    expect(versionState(config, dir).digest).not.toBe(before.digest)
  })
})

describe('EV-3 outside the raw files: the same checks as bash', () => {
  const rmCommand = (dir: string): string => `rm -rf ${join(dir, 'victim')}`

  it('does not run a C-class command without an approval', async () => {
    const { dir, add } = setup()
    mkdirSync(join(dir, 'victim'))
    await expect(add({ topic: 'T/rm', command: rmCommand(dir) })).rejects.toThrow(/rm-rf is a C-class action.*fingerprint rm-rf:/)
    expect(existsSync(join(dir, 'victim'))).toBe(true)
    expect(existsSync(join(dir, 'evidence'))).toBe(false)
  })

  it('runs it once with an approval, through the action gate’s ledger', async () => {
    const state = tmp('state')
    const dir = repo()
    mkdirSync(join(dir, 'victim'))
    const command = rmCommand(dir)
    const channel = { approvals: () => [{ decision: '0042', fingerprint: actionFingerprint('rm-rf', command) }], config: { stateDir: state, repo: 'r' } }
    const fake = fakeCtx({ lgChannel: channel })
    applyActionGate(fake.ctx, {})
    apply(fake.ctx, { evidenceRoot: join(dir, 'evidence') })
    const run = (topic: string) => fake.tool('lg_evidence_add').execute({ topic, claim: 'c', environment: 'real', command, raw: [], result: 'r' }, { agent: agentIn(dir) })
    await run('T/one')
    expect(existsSync(join(dir, 'victim'))).toBe(false)
    mkdirSync(join(dir, 'victim'))
    await expect(run('T/two')).rejects.toThrow(/C-class/)
    expect(existsSync(join(dir, 'victim'))).toBe(true)
    // The bash guard sees the same spent approval.
    expect(fake.guard('bash', { command })).toContain('C-class')
  })

  it('refuses a protected raw path and a command that names a protected path', async () => {
    const secret = tmp('secret')
    writeFileSync(join(secret, 'role.md'), 'role\n')
    const dir = repo()
    const fake = fakeCtx()
    applyProtect(fake.ctx, { protectedPaths: [secret] })
    apply(fake.ctx, { evidenceRoot: join(dir, 'evidence') })
    const run = (args: Record<string, unknown>) =>
      fake.tool('lg_evidence_add').execute({ topic: 'T/p', claim: 'c', environment: 'real', command: 'true', raw: [], result: 'r', ...args }, { agent: agentIn(dir) })
    await expect(run({ raw: [join(secret, 'role.md')] })).rejects.toThrow(/protected path/)
    await expect(run({ command: `cat ${secret}/role.md` })).rejects.toThrow(/protected path/)
    expect(existsSync(join(dir, 'evidence'))).toBe(false)
  })

  it('applies the default protected set and the default C-class rules when those plugins are absent', async () => {
    const { dir, add } = setup()
    await expect(add({ topic: 'T/x', command: 'git push --force origin main' })).rejects.toThrow(/C-class/)
    await expect(add({ topic: 'T/y', command: 'cat ~/.lg-global/workspace/LG-ROLE.md' })).rejects.toThrow(/protected path/)
    expect(existsSync(join(dir, 'evidence'))).toBe(false)
  })
})

describe('EV-5: nothing secret is recorded, and a refusal leaves nothing behind', () => {
  it('refuses a secret in the command output; writes no raw file, no manifest, no directory', async () => {
    const { dir, add } = setup()
    await expect(add({ topic: 'T/leak', command: "printf 'dsh web: http://127.0.0.1:3076/?%s=abcdefghijkl\\n' token" })).rejects.toThrow(/command output contains.*command-output\.txt was not written/)
    expect(existsSync(join(dir, 'evidence'))).toBe(false)
  })

  it('does not clobber an earlier manifest’s raw output when a re-run is refused', async () => {
    const { add } = setup()
    const first = await add({ topic: 'T/same', command: 'echo clean' })
    const file = manifestOf(first.path).raw[0]?.path ?? ''
    const before = readFileSync(file)
    await expect(add({ topic: 'T/same', command: "printf 'token=%s' abcdefghijklmnop" })).rejects.toThrow(/contains/)
    expect(readFileSync(file)).toEqual(before)
  })

  it('scans claim, command, result, controls and negative tests, not just raw files', async () => {
    const { dir, add } = setup()
    const key = 'sk-abcdefghijklmnopqrstuv'
    await expect(add({ topic: 'T/c1', command: 'true', claim: `uses ${key}` })).rejects.toThrow(/claim contains/)
    await expect(add({ topic: 'T/c2', command: `curl -H "Authorization: Bearer x" host`, environment: 'simulated' })).rejects.toThrow(/command contains/)
    await expect(add({ topic: 'T/c3', command: 'true', result: `Authorization: x` })).rejects.toThrow(/result contains/)
    await expect(add({ topic: 'T/c4', command: 'true', controls: [key] })).rejects.toThrow(/controls contains/)
    await expect(add({ topic: 'T/c5', command: 'true', negative_tests: [key] })).rejects.toThrow(/negative_tests contains/)
    expect(existsSync(join(dir, 'evidence'))).toBe(false)
  })

  it('refuses a model-provided raw file with a secret, and passes it once redacted (control)', async () => {
    const { dir, add } = setup()
    writeFileSync(join(dir, 'log.txt'), 'token=abcdefghijkl\n')
    await expect(add({ topic: 'T/log', environment: 'simulated', command: 'x', raw: ['log.txt'] })).rejects.toThrow(/log\.txt contains/)
    writeFileSync(join(dir, 'log.txt'), 'token=<REDACTED>\n')
    expect((await add({ topic: 'T/log', environment: 'simulated', command: 'x', raw: ['log.txt'] })).rawFiles).toBe(1)
  })

  it('refuses configured public domains in output and in text; passes without them', async () => {
    const { dir, add } = setup({ publicDomains: ['corp.example'] })
    await expect(add({ topic: 'T/d1', command: 'echo https://git.corp.example/x' })).rejects.toThrow(/public domain corp\.example/)
    await expect(add({ topic: 'T/d2', command: 'true', claim: 'pushed to corp.example' })).rejects.toThrow(/claim contains public domain/)
    expect(existsSync(join(dir, 'evidence'))).toBe(false)
    expect((await add({ topic: 'T/d3', command: 'echo https://localhost/x' })).rawFiles).toBe(1)
  })
})

describe('topic sanitising', () => {
  it.each(['../outside', 'a/../../b', '/tmp/abs', 'a//b', '', 'raw', 'a/raw', '.hidden', 'a/..', 'x'.repeat(201)])('refuses topic %j', async (topic) => {
    const { dir, add } = setup()
    await expect(add({ topic, command: 'true' })).rejects.toThrow(/topic/)
    expect(existsSync(join(dir, 'evidence'))).toBe(false)
    expect(existsSync(join(dir, '..', 'outside'))).toBe(false)
  })

  it('allows nested topics and refuses a symlinked directory that leads out of the evidence root', async () => {
    const { dir, add } = setup()
    expect((await add({ topic: 'M3/ev-real', command: 'true' })).path).toBe(join(dir, 'evidence', 'M3', 'ev-real', 'manifest.json'))
    const outside = tmp('outside')
    symlinkSync(outside, join(dir, 'evidence', 'escape'))
    await expect(add({ topic: 'escape/x', command: 'true' })).rejects.toThrow(/outside the evidence root/)
    expect(readdirSync(outside)).toEqual([])
    expect(() => topicDir('/srv/evidence', 'ok/fine-1.2')).not.toThrow()
  })
})

describe('RG-1 condition 3 only counts evidence from this turn', () => {
  it('lists an orphan raw directory unless it predates `since`', async () => {
    const { dir, fake } = setup()
    const raw = join(dir, 'evidence', 'T', 'old', 'raw')
    mkdirSync(raw, { recursive: true })
    writeFileSync(join(raw, 'x.txt'), 'orphan\n')
    const longAgo = new Date(Date.now() - 3_600_000)
    utimesSync(join(raw, 'x.txt'), longAgo, longAgo)
    const service = fake.services.get('lgEvidence') as { missingManifests(since?: number): string[] }
    expect(service.missingManifests()).toEqual(['T/old'])
    expect(service.missingManifests(Date.now() - 60_000)).toEqual([])
    writeFileSync(join(raw, 'y.txt'), 'new orphan\n')
    expect(service.missingManifests(Date.now() - 60_000)).toEqual(['T/old'])
  })
})
