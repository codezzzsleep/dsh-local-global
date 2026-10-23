/**
 * The Global plugins against the real dsh tool registry (`@deepseek-ai/dsh-tools`
 * `ToolRuntime`, loaded into a plain cordis context): the guard, the integrity
 * barrier, and the pause lifecycle are exercised through `ctx.tools.execute`,
 * not through hand-built calls.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'lg-integration-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Obj = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function boot(options: { scope?: Obj | ((workspace: string) => Obj) | null; integrity?: Obj | null; roleFile?: boolean } = {}) {
  vi.resetModules()
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const scope = await import('../src/scope.js')
  const integrity = await import('../src/integrity.js')
  const repo = await import('../src/repo.js')
  const { lgState } = await import('../src/state.js')

  const dir = mkdtempSync(join(root, 'case-'))
  const workspace = join(dir, 'workspace')
  mkdirSync(join(workspace, 'drafts'), { recursive: true })
  if (options.roleFile !== false) writeFileSync(join(workspace, 'LG-ROLE.md'), 'You are Global.\n')
  writeFileSync(join(workspace, 'drafts', 'note.txt'), 'note\n')
  const hashFile = join(dir, 'config.sha256')

  const ctx = new Context() as Obj
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime, {})
  const cwds = new WeakMap<object, string>()
  ctx.provide('workingDirectory', {
    get: (session: Obj) => cwds.get(session) ?? session.header.cwd,
  })
  ctx.provide('profileContext', { name: 'lg-global-test' })
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'lg-global' }],
    inspectCompositions: () => [{ id: 'lg-global' }],
    acquireScope: async () => ({ key: undefined, [Symbol.asyncDispose]: async () => {} }),
  })
  await sleep(50)

  const disposers: (() => void)[] = []
  const tool = (name: string): (() => void) => {
    const dispose = ctx.tools.register({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: { ran: { type: 'string' } } }, render: () => [{ type: 'text', text: `ran ${name}` }] },
      execute: async () => ({ ran: name }),
    })
    disposers.push(dispose)
    return dispose
  }
  for (const name of ['read', 'write', 'glob', 'grep', 'working_directory', 'lg_repo_log']) tool(name)

  const scopeConfig = typeof options.scope === 'function' ? options.scope(workspace) : options.scope
  if (options.scope !== null) ctx.plugin(scope, scopeConfig ?? { workspace })
  if (options.integrity !== null) ctx.plugin(integrity, options.integrity ?? { configHashFile: hashFile })
  await sleep(100)

  let n = 0
  const agent = { session: { header: { cwd: workspace } } }
  const call = async (name: string, args: unknown = {}, who: unknown = agent): Promise<{ isError?: boolean; text: string }> => {
    const result = await ctx.tools.execute({ callId: `c${String(n++)}`, name, arguments: args, signal: new AbortController().signal, ...(who === undefined ? {} : { agent: who }) })
    return { isError: result.isError, text: result.content.map((block: Obj) => block.text ?? '').join('\n') }
  }
  const created = async (who: unknown = agent): Promise<void> => {
    await ctx.serial('agent/created', { agent: who, source: 'startup' })
  }
  return { ctx, scope, integrity, repo, lgState, dir, workspace, hashFile, agent, call, created, tool, cwds, disposers, Context }
}

afterEach(() => {
  vi.resetModules()
})

describe('integrity barrier (item 5, IN-1)', () => {
  it('refuses every tool until the session has been checked, then serves it', async () => {
    const h = await boot()
    // PS-1: nothing has verified the composition yet.
    expect((await h.call('read', { file_path: 'drafts/note.txt' })).text).toContain('lg-global paused: not-verified')
    await h.created()
    expect(h.lgState.paused).toBe(false)
    const ok = await h.call('read', { file_path: 'drafts/note.txt' })
    expect(ok).toMatchObject({ isError: false, text: 'ran read' })
  })

  it('does not serve a session whose own check has not run, even when the process is verified', async () => {
    const h = await boot()
    await h.created()
    const other = { session: { header: { cwd: h.workspace } } }
    expect((await h.call('read', { file_path: 'drafts/note.txt' }, other)).text).toContain('integrity check for this session has not completed')
    // Its own check completes before dsh releases its first turn.
    await h.created(other)
    expect((await h.call('read', { file_path: 'drafts/note.txt' }, other)).isError).toBe(false)
  })

  it('pauses before the first call when a shell is visible to the session', async () => {
    const h = await boot()
    h.tool('shell')
    await h.created()
    const refused = await h.call('read', { file_path: 'drafts/note.txt' })
    expect(refused.text).toContain('lg-global paused: tool-whitelist')
    expect(refused.text).toContain('shell')
  })

  it('pauses when the session starts outside the workspace', async () => {
    const h = await boot()
    const stray = { session: { header: { cwd: h.dir } } }
    await h.created(stray)
    expect((await h.call('read', { file_path: 'drafts/note.txt' }, stray)).text).toContain('lg-global paused: session-cwd')
  })

  it('a pause raised after verification blocks sessions created later', async () => {
    const h = await boot()
    await h.created()
    h.lgState.pause('config-hash', 'simulated')
    const late = { session: { header: { cwd: h.workspace } } }
    expect((await h.call('read', { file_path: 'drafts/note.txt' }, late)).text).toContain('paused: config-hash')
  })
})

describe('call-time allow-list and pause (item 3)', () => {
  it.each(['exec', 'shell', 'sh', 'python', 'Bash', 'jobs', 'lg_shell', 'lg_apply_patch', 'run_code'])('refuses %s and pauses until re-checked', async (name) => {
    const h = await boot()
    await h.created()
    const refused = await h.call(name, {})
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/not an allowed Global tool|execution or derivation/)
    const after = await h.call('read', { file_path: 'drafts/note.txt' })
    expect(after.text).toContain('lg-global paused: tool-whitelist')
    // PS-2: only lg_integrity_check works, and a clean re-check lifts the pause (nothing visible is wrong).
    const report = await h.call('lg_integrity_check')
    expect(report.text).toMatch(/^PASS/)
    expect((await h.call('read', { file_path: 'drafts/note.txt' })).isError).toBe(false)
  })

  it('pauses when a shell appears later and lifts once it is gone', async () => {
    const h = await boot()
    await h.created()
    const dispose = h.tool('terminal_run')
    const report = await h.call('lg_integrity_check')
    expect(report.text).toMatch(/^PAUSED/)
    expect(report.text).toContain('not allowed: terminal_run')
    dispose()
    expect((await h.call('lg_integrity_check')).text).toMatch(/^PASS/)
  })
})

describe('writing tools are held to the write roots end to end (item 2)', () => {
  it('refuses lg_evidence_session over the role file through the real pipeline', async () => {
    const h = await boot()
    h.tool('lg_evidence_session')
    await h.created()
    const refused = await h.call('lg_evidence_session', { out: 'LG-ROLE.md' })
    expect(refused.text).toContain('protected path')
    expect(readFileSync(join(h.workspace, 'LG-ROLE.md'), 'utf8')).toBe('You are Global.\n')
    expect((await h.call('lg_evidence_session', { out: 'drafts/evidence.jsonl' })).isError).toBe(false)
  })

  it('follows the working directory the service tracks, not the creation cwd', async () => {
    const h = await boot()
    await h.created()
    h.cwds.set(h.agent.session, h.workspace)
    expect((await h.call('write', { file_path: 'LG-ROLE.md', content: 'x' })).text).toContain('protected path')
    h.cwds.set(h.agent.session, join(h.workspace, 'drafts'))
    expect((await h.call('write', { file_path: 'x.txt', content: 'x' })).isError).toBe(false)
  })
})

describe('configuration errors pause instead of throwing (item 5)', () => {
  it('lg-scope with a bad config loads, refuses everything, and stays paused with the reason', async () => {
    const h = await boot({ scope: {} })
    await h.created()
    const refused = await h.call('read', { file_path: 'x' })
    expect(refused.text).toContain('lg-global paused')
    expect(h.lgState.list().map((reason: Obj) => reason.code)).toContain('scope-config')
    expect(h.lgState.paused).toBe(true)
    // PS-2: the report tool stays reachable, and says why.
    const report = await h.call('lg_integrity_check')
    expect(report.text).toContain('scope-config')
    expect(h.lgState.paused).toBe(true)
  })

  it('lg-scope with a write root outside the workspace pauses instead of throwing', async () => {
    const h = await boot({ scope: { workspace: '/tmp', writeRoots: ['/etc'] } })
    expect(h.lgState.list().map((reason: Obj) => reason.code)).toContain('scope-config')
  })

  it('lg-repo with a bad config registers its tools, refuses them with the reason, and pauses', async () => {
    const h = await boot()
    h.ctx.plugin(h.repo, { remote: 'ssh://git@github.com/o/r.git' })
    await sleep(200)
    expect(h.lgState.list().map((reason: Obj) => reason.code)).toContain('repo-config')
    await h.created()
    const refused = await h.call('lg_repo_log', {})
    expect(refused.text).toContain('lg-global paused')
    const report = await h.call('lg_integrity_check')
    expect(report.text).toContain('repo-config')
    expect(report.text).toMatch(/^PAUSED/)
  })

  it('lg-integrity with no workspace loads and reports why it cannot verify', async () => {
    const h = await boot({ scope: null, integrity: {} })
    await h.created()
    expect(h.lgState.paused).toBe(true)
    expect(h.lgState.list().map((reason: Obj) => reason.code)).toContain('integrity-config')
  })
})

describe('self-test (item 5)', () => {
  it('passes with the guard registered', async () => {
    const h = await boot()
    const result = await h.integrity.selfTest(h.ctx, h.lgState.component('scope'), h.integrity.resolveIntegrityConfig({ workspace: h.workspace }))
    expect(result).toMatchObject({ name: 'scope-selftest', pass: true })
  })

  it('fails when no guard refuses the canary', async () => {
    const h = await boot({ scope: null, integrity: null })
    const scope = h.scope.resolveScopeConfig({ workspace: h.workspace })
    const result = await h.integrity.selfTest(h.ctx, scope, h.integrity.resolveIntegrityConfig({ workspace: h.workspace }))
    expect(result.pass).toBe(false)
    expect(result.detail).toContain('did not refuse a canary call')
  })

  it('fails when lg-scope and lg-integrity disagree about the allowed tools', async () => {
    const h = await boot()
    const result = await h.integrity.selfTest(h.ctx, h.lgState.component('scope'), h.integrity.resolveIntegrityConfig({ workspace: h.workspace, allowedTools: ['read'] }))
    expect(result.pass).toBe(false)
    expect(result.detail).toContain('disagree')
  })

  it('fails when the rules would allow reading the local working directory', async () => {
    const h = await boot()
    const wide = h.scope.resolveScopeConfig({ workspace: h.workspace })
    const result = await h.integrity.selfTest(h.ctx, wide, h.integrity.resolveIntegrityConfig({ workspace: h.workspace, localWorkdir: join(h.workspace, 'drafts') }))
    expect(result.pass).toBe(false)
    expect(result.detail).toContain('would allow reading')
  })
})

describe('effective-configuration hash (spec item 5)', () => {
  it('records a baseline on first run, then pauses on change until a Human records the new hash', async () => {
    const h = await boot()
    await h.created()
    const baseline = readFileSync(h.hashFile, 'utf8').trim()
    expect(baseline).toMatch(/^[0-9a-f]{64}$/)
    expect(h.lgState.listWarnings().map((w: Obj) => w.code)).toContain('config-hash')
    expect((await h.call('read', { file_path: 'drafts/note.txt' })).isError).toBe(false)

    // The effective scope configuration changes (a write root is added).
    h.lgState.setComponent('scope', { ...h.lgState.component('scope'), writeRoots: [join(h.workspace, 'drafts'), join(h.workspace, 'more')] })
    const paused = await h.call('lg_integrity_check')
    expect(paused.text).toMatch(/^PAUSED/)
    expect(paused.text).toContain('config-hash')
    expect((await h.call('read', { file_path: 'drafts/note.txt' })).text).toContain('paused: config-hash')

    // Re-checking without a Human decision does not lift it.
    expect((await h.call('lg_integrity_check')).text).toMatch(/^PAUSED/)

    const now = /now ([0-9a-f]{64})/.exec(paused.text)?.[1]
    expect(now).toBeDefined()
    writeFileSync(h.hashFile, `${String(now)}\n`)
    expect((await h.call('lg_integrity_check')).text).toMatch(/^PASS/)
    expect((await h.call('read', { file_path: 'drafts/note.txt' })).isError).toBe(false)
  })

  it('canonicalises key order and ignores undefined', async () => {
    const { configHash } = await import('../src/integrity.js')
    expect(configHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(configHash({ b: { d: [1, 2], c: 2 }, a: 1, z: undefined }))
    expect(configHash({ a: 1 })).not.toBe(configHash({ a: 2 }))
  })
})

describe('role file (item 6)', () => {
  it('probes the configured role file, not a hardcoded LG-ROLE.md', async () => {
    const h = await boot({ scope: (workspace) => ({ workspace, roleFile: 'MY-ROLE.md' }) })
    // LG-ROLE.md exists, MY-ROLE.md does not: the probe must follow the configuration.
    await h.created()
    const paused = await h.call('lg_integrity_check')
    expect(paused.text).toMatch(/^PAUSED: .*role-file/)
    expect(paused.text).toContain('MY-ROLE.md')
    writeFileSync(join(h.workspace, 'MY-ROLE.md'), 'custom\n')
    expect((await h.call('lg_integrity_check')).text).toMatch(/^PASS/)
    expect(h.ctx.get('lgRoleFile')).toBe(join(h.workspace, 'MY-ROLE.md'))
  })

  it('checks the file, emptiness, and agreement with lg-role', async () => {
    const h = await boot()
    const { checkRoleFile } = h.integrity
    const file = join(h.workspace, 'LG-ROLE.md')
    expect(checkRoleFile({ roleFile: file }, undefined)).toMatchObject({ pass: true })
    expect(checkRoleFile({ roleFile: file }, file)).toMatchObject({ pass: true })
    expect(checkRoleFile({ roleFile: join(h.workspace, 'MISSING.md') }, undefined)).toMatchObject({ pass: false })
    expect(checkRoleFile({ roleFile: file }, join(h.workspace, 'OTHER.md'))).toMatchObject({ pass: false })
    expect(checkRoleFile(undefined, undefined)).toMatchObject({ pass: false })
    writeFileSync(file, '  \n')
    expect(checkRoleFile({ roleFile: file }, undefined)).toMatchObject({ pass: false, detail: expect.stringContaining('empty') })
  })

  it('lg-role contributes the file at assembly and refuses, paused, once it is unreadable', async () => {
    const h = await boot()
    const role = await import('../src/role.js')
    let provider: (() => string) | undefined
    const fake = {
      get: (name: string) => (name === 'lgWorkspace' ? h.workspace : undefined),
      effect: (fn: () => unknown) => fn(),
      systemPrompt: {
        section: (section: { text: () => string }) => {
          provider = section.text
          return () => {}
        },
      },
    }
    role.apply(fake as never, { roleFile: 'LG-ROLE.md' })
    expect(provider?.()).toBe('You are Global.\n')
    expect(h.lgState.component('role')).toEqual({ roleFile: join(h.workspace, 'LG-ROLE.md') })
    rmSync(join(h.workspace, 'LG-ROLE.md'))
    expect(() => provider?.()).toThrow(/cannot read/)
    expect(h.lgState.list().map((reason: Obj) => reason.code)).toContain('role-file')
    writeFileSync(join(h.workspace, 'LG-ROLE.md'), 'back\n')
    expect(provider?.()).toBe('back\n')
  })
})

describe('web_fetch provider pin (item 12)', () => {
  it('passes when pinned to http, and pauses when not', async () => {
    const h = await boot()
    let pinned: string | undefined = 'http'
    h.ctx.provide('web', { config: { fetchProvider: { get: () => pinned } } })
    await h.created()
    expect((await h.call('lg_integrity_check')).text).toMatch(/^PASS/)
    pinned = undefined
    const report = await h.call('lg_integrity_check')
    expect(report.text).toMatch(/^PAUSED/)
    expect(report.text).toContain('web-fetch-provider')
    pinned = 'deepseek-fetch-api'
    expect((await h.call('lg_integrity_check')).text).toContain('must be pinned to http')
    pinned = 'http'
    expect((await h.call('lg_integrity_check')).text).toMatch(/^PASS/)
  })
})

describe('repository checks are part of every run (item 6, 5)', () => {
  async function withRepo() {
    const h = await boot()
    const { runGit } = h.repo
    const work = join(h.dir, 'work')
    const remote = join(h.dir, 'remote.git')
    await runGit(['init', '--quiet', '--initial-branch', 'main', work])
    await runGit(['init', '--quiet', '--bare', '--initial-branch', 'main', remote])
    writeFileSync(join(work, 'a.txt'), 'a\n')
    await runGit(['add', '.'], { cwd: work })
    await runGit(['commit', '--quiet', '-m', 'one'], { cwd: work, env: identity })
    await runGit(['push', '--quiet', remote, 'main'], { cwd: work, allowFile: true })
    let verdict: 'denied' | 'writable' | 'inconclusive' = 'denied'
    const afterSync = vi.fn(async (agent: unknown) => {
      const integrity = h.ctx.get('lgIntegrity')
      const report = await integrity.run({ agent, pushProbe: false })
      if (!report.clean) throw new Error(report.failures.join('; '))
    })
    const runtime = new h.repo.RepoRuntime({
      state: h.lgState,
      resolve: () => ({ config: { remote, branch: 'main', mirrorDir: join(h.workspace, 'repo.git') } }),
      allowFile: true,
      probe: async () => ({ verdict, exitCode: null, detail: `stub ${verdict}` }),
      afterSync,
    })
    h.ctx.provide('lgRepo', runtime)
    await runtime.start()
    await h.created()
    return { h, runtime, remote, afterSync, setVerdict: (next: typeof verdict) => (verdict = next) }
  }

  it('lifts a mirror-config pause when lg_integrity_check finds the config clean again', async () => {
    const { h, runtime } = await withRepo()
    expect(h.lgState.paused).toBe(false)
    const mirrorDir = join(h.workspace, 'repo.git')
    await h.repo.runGit(['config', '--local', 'http.extraHeader', 'X: 1'], { cwd: mirrorDir })
    const paused = await h.call('lg_integrity_check')
    expect(paused.text).toMatch(/^PAUSED: .*mirror-config/)
    expect((await h.call('read', { file_path: 'drafts/note.txt' })).text).toContain('mirror-config')
    await expect(runtime.sync()).rejects.toThrow(/refusing to sync/)
    await h.repo.runGit(['config', '--local', '--unset', 'http.extraHeader'], { cwd: mirrorDir })
    expect((await h.call('lg_integrity_check')).text).toMatch(/^PASS/)
    expect((await h.call('read', { file_path: 'drafts/note.txt' })).isError).toBe(false)
  })

  it('lifts a push-probe pause only after a fresh probe is denied again', async () => {
    const { h, setVerdict } = await withRepo()
    setVerdict('writable')
    expect((await h.call('lg_integrity_check')).text).toMatch(/^PAUSED: .*push-probe/)
    expect((await h.call('read', { file_path: 'drafts/note.txt' })).text).toContain('push-probe')
    setVerdict('denied')
    expect((await h.call('lg_integrity_check')).text).toMatch(/^PASS/)
  })

  it('treats an inconclusive probe as a warning, not a pause', async () => {
    const { h, setVerdict } = await withRepo()
    setVerdict('inconclusive')
    const report = await h.call('lg_integrity_check')
    expect(report.text).toMatch(/^PASS/)
    expect(report.text).toContain('warn push-probe')
  })

  it('lifts a session-cwd pause once the session is back inside the workspace', async () => {
    const { h } = await withRepo()
    h.cwds.set(h.agent.session, h.dir)
    expect((await h.call('lg_integrity_check')).text).toMatch(/^PAUSED: .*session-cwd/)
    h.cwds.set(h.agent.session, h.workspace)
    expect((await h.call('lg_integrity_check')).text).toMatch(/^PASS/)
  })

  it('runs the integrity checks after every sync', async () => {
    const { h, runtime, afterSync } = await withRepo()
    const result = await runtime.sync(h.agent)
    expect(result.equal).toBe(true)
    expect(afterSync).toHaveBeenCalledTimes(1)
    expect(afterSync).toHaveBeenCalledWith(h.agent)
  })

  it('pauses when the mirror cannot be created (mirror-init failure is not just logged)', async () => {
    const h = await boot()
    const { RepoRuntime } = h.repo
    const blocked = join(h.dir, 'blocker')
    writeFileSync(blocked, 'a file where a directory must go')
    const runtime = new RepoRuntime({
      state: h.lgState,
      resolve: () => ({ config: { remote: 'https://example.invalid/r.git', branch: 'main', mirrorDir: join(blocked, 'repo.git') } }),
      probe: async () => ({ verdict: 'denied', exitCode: null, detail: 'x' }),
    })
    h.ctx.provide('lgRepo', runtime)
    await runtime.start()
    expect(h.lgState.list().map((reason: Obj) => reason.code)).toContain('mirror-init')
    await h.created()
    expect((await h.call('read', { file_path: 'drafts/note.txt' })).text).toContain('mirror-init')
  })
})
