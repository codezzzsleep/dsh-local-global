import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentIn, fakeCtx } from '../../dsh-lg-local/test/fake-ctx.js'
import { apply as applyEvidence } from '../../dsh-lg-local/src/evidence.js'
import { createWorld, git, refusal, validDirective, type World } from './m4-world.js'

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(async () => {
  await w.close()
})

/** Local's real evidence tool, run in Local's worktree, so the manifests are the ones Local really writes. */
function localEvidence(): (args: Record<string, unknown>) => Promise<{ path: string; digest: string; worktreeDirty: boolean }> {
  const fake = fakeCtx()
  applyEvidence(fake.ctx, { evidenceRoot: join(w.work, 'evidence') })
  return async (args) =>
    (await fake.tool('lg_evidence_add').execute({ claim: 'it works', environment: 'real', raw: [], result: 'ok', command: 'echo ran', ...args }, { agent: agentIn(w.work) })) as never
}

/** Commit what Local wrote (evidence only, unless the caller changed code) and push it. */
async function publish(message = 'evidence'): Promise<string> {
  await git(w.work, 'add', '-A')
  await git(w.work, 'commit', '--quiet', '-m', message)
  await git(w.work, 'push', '--quiet', w.remote, 'main')
  return await git(w.work, 'rev-parse', 'HEAD')
}

const manifestPath = (topic: string): string => `evidence/${topic}/manifest.json`
const stopArgs = (final: string, paths: Record<string, string[]>): Record<string, unknown> => ({
  final_commit: final,
  acceptance: Object.entries(paths).map(([id, evidence]) => ({ id, evidence })),
})
const stops = async (): Promise<number> => (await w.global.snapshot()).messages.filter((message) => message.type === 'STOP').length

describe('GD-3: lg_stop', () => {
  it('sends STOP when final_commit is the remote head and every criterion has current real evidence', async () => {
    await w.call('lg_directive', validDirective())
    const add = localEvidence()
    await add({ topic: 'M4/gd1' })
    await add({ topic: 'M4/gd3' })
    const final = await publish()

    const result = await w.call('lg_stop', stopArgs(final, { 'AC-1': [manifestPath('M4/gd1')], 'AC-2': [manifestPath('M4/gd3'), manifestPath('M4/gd1')] }))
    expect(result.text).toMatch(/posted STOP as #\d{4} \(G-\d+\) at [0-9a-f]{12}; 2 criteria have current real evidence/)
    const stop = (await w.global.snapshot()).messages.find((message) => message.type === 'STOP')
    expect(stop?.sender).toBe('global')
    expect(stop?.fields['final_commit']).toBe(final)
    expect(stop?.fields['acceptance']).toEqual([
      { id: 'AC-1', evidence: [manifestPath('M4/gd1')] },
      { id: 'AC-2', evidence: [manifestPath('M4/gd3'), manifestPath('M4/gd1')] },
    ])
  })

  it('refuses when final_commit is not the remote head, even though the mirror was stale before the call', async () => {
    await w.call('lg_directive', validDirective())
    await localEvidence()({ topic: 'M4/gd1' })
    const old = await publish()
    const newer = await w.commit({ 'docs/notes.md': 'later\n' }, 'later work')
    // The mirror has not seen `newer`; lg_stop syncs first and so judges against the real remote.
    expect(await w.sync()).not.toBe(newer)
    const text = await refusal(w.call('lg_stop', stopArgs(old, { 'AC-1': [manifestPath('M4/gd1')], 'AC-2': [manifestPath('M4/gd1')] })))
    expect(text).toMatch(new RegExp(`final_commit ${old.slice(0, 12)} is not the mirror HEAD ${newer.slice(0, 12)}`))
    expect(text).toMatch(new RegExp(`final_commit ${old.slice(0, 12)} is not the remote head ${newer.slice(0, 12)}`))
    expect(await stops()).toBe(0)
    expect(await w.mirror.head()).toBe(newer)
  })

  it('refuses a final_commit that is not a full commit id', async () => {
    expect(await refusal(w.call('lg_stop', { final_commit: 'HEAD', acceptance: [] }))).toMatch(/full 40-character lowercase commit id/)
  })

  it('refuses simulated evidence, naming the criterion and the manifest', async () => {
    await w.call('lg_directive', validDirective())
    const add = localEvidence()
    await add({ topic: 'M4/real' })
    await add({ topic: 'M4/sim', environment: 'simulated', raw: [] })
    const final = await publish()
    const text = await refusal(w.call('lg_stop', stopArgs(final, { 'AC-1': [manifestPath('M4/real')], 'AC-2': [manifestPath('M4/sim')] })))
    expect(text).toContain(`AC-2: ${manifestPath('M4/sim')}: environment is "simulated", only "real" evidence counts`)
    expect(text).not.toMatch(/AC-1:/)
    expect(await stops()).toBe(0)
  })

  it('refuses stale evidence: code changed after the evidence was written', async () => {
    await w.call('lg_directive', validDirective())
    const add = localEvidence()
    await add({ topic: 'M4/gd1' })
    await add({ topic: 'M4/gd3' })
    await publish()
    const final = await w.commit({ 'src/a.txt': 'one\nchanged after the evidence\n' }, 'code change')
    const text = await refusal(w.call('lg_stop', stopArgs(final, { 'AC-1': [manifestPath('M4/gd1')], 'AC-2': [manifestPath('M4/gd3')] })))
    expect(text).toMatch(/AC-1: evidence\/M4\/gd1\/manifest\.json: stale: the manifest is for [0-9a-f]{40}, the code at [0-9a-f]{12} is [0-9a-f]{40}/)
    expect(text).toMatch(/AC-2: .*stale/)
    expect(await stops()).toBe(0)
  })

  it('accepts evidence committed after the code it describes (evidence commits do not move the digest)', async () => {
    await w.call('lg_directive', validDirective({ acceptance: [{ id: 'AC-1', text: 'GD-3: one criterion' }] }))
    await localEvidence()({ topic: 'M4/gd3' })
    await publish('evidence 1')
    await w.commit({ 'evidence/M4/README.md': 'index\n' }, 'index')
    const final = await w.commit({ 'evidence/M4/other.txt': 'more evidence\n' }, 'more evidence')
    expect((await w.call('lg_stop', stopArgs(final, { 'AC-1': [manifestPath('M4/gd3')] }))).text).toMatch(/posted STOP/)
  })

  it('refuses a manifest written on a dirty worktree', async () => {
    await w.call('lg_directive', validDirective({ acceptance: [{ id: 'AC-1', text: 'GD-3: one criterion' }] }))
    writeFileSync(join(w.work, 'src/a.txt'), 'one\nuncommitted\n')
    const added = await localEvidence()({ topic: 'M4/dirty' })
    expect(added.worktreeDirty).toBe(true)
    const final = await publish('code and evidence together')
    // The digest matches (the code was committed afterwards), but the claim was made on unrecorded state.
    expect(await refusal(w.call('lg_stop', stopArgs(final, { 'AC-1': [manifestPath('M4/dirty')] })))).toMatch(/dirty worktree/)
  })

  it('refuses a raw file that changed after the manifest, and one that is missing', async () => {
    await w.call('lg_directive', validDirective({ acceptance: [{ id: 'AC-1', text: 'GD-3: one criterion' }] }))
    await localEvidence()({ topic: 'M4/raw' })
    writeFileSync(join(w.work, 'evidence/M4/raw/raw/command-output.txt'), 'edited by hand\n')
    const tampered = await publish('tampered')
    expect(await refusal(w.call('lg_stop', stopArgs(tampered, { 'AC-1': [manifestPath('M4/raw')] })))).toMatch(/raw file changed since the manifest: M4\/raw\/raw\/command-output\.txt/)
    await git(w.work, 'rm', '-q', '-r', 'evidence/M4/raw/raw')
    const missing = await publish('removed')
    expect(await refusal(w.call('lg_stop', stopArgs(missing, { 'AC-1': [manifestPath('M4/raw')] })))).toMatch(/raw file missing at [0-9a-f]{12}: M4\/raw\/raw\/command-output\.txt/)
  })

  it('refuses a "real" manifest in which no raw file was produced by the tool, and a manifest in the old digest format', async () => {
    await w.call('lg_directive', validDirective({ acceptance: [{ id: 'AC-1', text: 'GD-3: one criterion' }] }))
    await localEvidence()({ topic: 'M4/edited' })
    const path = join(w.work, manifestPath('M4/edited'))
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { raw: { producedByTool?: unknown }[] }
    for (const raw of manifest.raw) delete raw.producedByTool
    writeFileSync(path, JSON.stringify(manifest))
    const final = await publish('edited manifest')
    expect(await refusal(w.call('lg_stop', stopArgs(final, { 'AC-1': [manifestPath('M4/edited')] })))).toMatch(/no raw file was produced by the tool itself/)

    writeFileSync(join(w.work, 'evidence/old.json'), '{}')
    await w.commit({ 'evidence/M4/old/manifest.json': JSON.stringify({ topic: 'M4/old', environment: 'real', commit: final, digest: final, raw: [], worktreeDirty: false }) })
    const head = await git(w.work, 'rev-parse', 'HEAD')
    const text = await refusal(w.call('lg_stop', stopArgs(head, { 'AC-1': [manifestPath('M4/old')] })))
    expect(text).toMatch(/digestKind is undefined; only git:tree digests can be checked/)
    expect(text).toMatch(/the manifest lists no raw files/)
  })

  it('refuses paths that are not manifests inside the evidence root, and manifests that do not exist', async () => {
    await w.call('lg_directive', validDirective({ acceptance: [{ id: 'AC-1', text: 'GD-3: one criterion' }] }))
    const final = await w.sync()
    for (const [path, pattern] of [
      ['src/a.txt', /not a manifest: expected evidence\/<topic>\/manifest\.json/],
      ['evidence/../src/a.txt', /must not contain "\.\."/],
      ['/etc/passwd', /relative to the repository root/],
      ['evidence/M4/README.md', /not a manifest/],
      ['evidence/nope/manifest.json', /no such manifest at/],
    ] as const) {
      expect(await refusal(w.call('lg_stop', stopArgs(final, { 'AC-1': [path] })))).toMatch(pattern)
    }
    expect(await refusal(w.call('lg_stop', stopArgs(final, { 'AC-1': [] })))).toMatch(/AC-1: no evidence cited/)
  })

  it('refuses an acceptance list that does not match the current DIRECTIVE', async () => {
    await w.call('lg_directive', validDirective())
    const final = await w.sync()
    const text = await refusal(w.call('lg_stop', stopArgs(final, { 'AC-1': ['evidence/x/manifest.json'], 'AC-9': ['evidence/y/manifest.json'] })))
    expect(text).toMatch(/AC-2 of DIRECTIVE v1 has no entry/)
    expect(text).toMatch(/AC-9 is not a criterion of DIRECTIVE v1/)
    expect(await refusal(w.call('lg_stop', { final_commit: final, acceptance: 'all of them' }))).toMatch(/acceptance must be a list/)
  })

  it('refuses without a DIRECTIVE, while the guard is paused, and when the sync fails', async () => {
    const final = await w.sync()
    expect(await refusal(w.call('lg_stop', stopArgs(final, {})))).toMatch(/no DIRECTIVE/)

    w.state.pause('mirror-config', 'tampered')
    expect(await refusal(w.call('lg_stop', stopArgs(final, {})))).toMatch(/lg-global paused: mirror-config/)
    w.state.resume('mirror-config')

    await w.close()
    w = await createWorld({ deps: { repo: () => ({ mirror: () => w.mirror, sync: async () => Promise.reject(new Error('remote unreachable')) }) as never } })
    expect(await refusal(w.call('lg_stop', stopArgs('a'.repeat(40), {})))).toMatch(/lg_repo_sync failed: remote unreachable/)
  })
})
