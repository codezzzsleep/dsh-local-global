import { describe, expect, it } from 'vitest'
import { probePushDenied, proxyConfig, resolveRepoConfig } from '../src/repo.js'

const base = { remote: 'https://github.com/codezzzsleep/dsh-local-global.git', branch: 'main', mirrorDir: '/tmp/lg-test-mirror.git' }

describe('resolveRepoConfig', () => {
  it('accepts an https remote without credentials', () => {
    const config = resolveRepoConfig(base)
    expect(config.remote).toBe(base.remote)
    expect(config.branch).toBe('main')
    expect(config.httpProxy).toBeUndefined()
  })

  it('refuses ssh, git@ and file remotes', () => {
    for (const remote of ['git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git', 'file:///srv/repo.git']) {
      expect(() => resolveRepoConfig({ ...base, remote })).toThrow()
    }
  })

  it('refuses an https remote that carries a username or token', () => {
    expect(() => resolveRepoConfig({ ...base, remote: 'https://user:token@github.com/owner/repo.git' })).toThrow()
    expect(() => resolveRepoConfig({ ...base, remote: 'https://token@github.com/owner/repo.git' })).toThrow()
  })

  it('accepts an httpProxy and rejects a malformed one', () => {
    expect(resolveRepoConfig({ ...base, httpProxy: 'http://127.0.0.1:7890' }).httpProxy).toBe('http://127.0.0.1:7890')
    expect(resolveRepoConfig({ ...base, httpProxy: 'https://proxy.example:8080' }).httpProxy).toBe('https://proxy.example:8080')
    for (const bad of ['127.0.0.1:7890', 'socks5://127.0.0.1:1080', '']) {
      expect(() => resolveRepoConfig({ ...base, httpProxy: bad })).toThrow()
    }
  })
})

describe('proxyConfig', () => {
  it('is empty without a proxy and a single -c pair with one', () => {
    expect(proxyConfig(resolveRepoConfig(base))).toEqual([])
    expect(proxyConfig(resolveRepoConfig({ ...base, httpProxy: 'http://127.0.0.1:7890' }))).toEqual(['http.proxy=http://127.0.0.1:7890'])
  })
})

describe('probePushDenied', () => {
  it('reports writable against a local repository the process can write to', async () => {
    // A local path remote is refused by config validation, so the control that
    // must yield `writable` is built directly: a bare repo this process owns.
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { runGit } = await import('../src/repo.js')
    const dir = mkdtempSync(join(tmpdir(), 'lg-probe-writable-'))
    const bare = join(dir, 'bare.git')
    await runGit(['init', '--bare', '--initial-branch', 'main', bare])
    const config = { remote: bare, branch: 'main', mirrorDir: join(dir, 'ignored.git') }
    // The file transport is default-deny; this control opts in explicitly.
    const probe = await probePushDenied(config, { allowFile: true })
    expect(probe.verdict).toBe('writable')
    // Without the opt-in the same remote is refused by git, never "writable".
    const refused = await probePushDenied(config)
    expect(refused.verdict).toBe('inconclusive')
  })

  it('reports denied or inconclusive against an anonymous https remote, never writable', async () => {
    const probe = await probePushDenied(resolveRepoConfig(base))
    expect(['denied', 'inconclusive']).toContain(probe.verdict)
  }, 90_000)
})

describe('recordProbeOutcome (SPEC lg-repo / RP-6)', () => {
  it('pauses on writable', async () => {
    const { GuardState } = await import('../src/state.js')
    const { recordProbeOutcome } = await import('../src/repo.js')
    const state = new GuardState()
    state.markVerified()
    expect(recordProbeOutcome(state, { verdict: 'writable', exitCode: 0, detail: 'ok' })).toBe('pause')
    expect(state.paused).toBe(true)
    expect(state.denial()).toContain('writable')
  })

  it('passes on denied', async () => {
    const { GuardState } = await import('../src/state.js')
    const { recordProbeOutcome } = await import('../src/repo.js')
    const state = new GuardState()
    state.markVerified()
    expect(recordProbeOutcome(state, { verdict: 'denied', exitCode: null, detail: 'read only' })).toBe('pass')
    expect(state.paused).toBe(false)
    expect(state.listWarnings()).toEqual([])
  })

  it('warns but does not pause on inconclusive', async () => {
    const { GuardState } = await import('../src/state.js')
    const { recordProbeOutcome } = await import('../src/repo.js')
    const state = new GuardState()
    state.markVerified()
    expect(recordProbeOutcome(state, { verdict: 'inconclusive', exitCode: null, detail: 'timed out' })).toBe('warn')
    expect(state.paused).toBe(false)
    expect(state.listWarnings().map((w) => w.code)).toEqual(['push-probe'])
  })

  it('keeps a push-probe pause through an inconclusive run; only denied lifts it', async () => {
    const { GuardState } = await import('../src/state.js')
    const { recordProbeOutcome } = await import('../src/repo.js')
    const state = new GuardState()
    state.markVerified()
    recordProbeOutcome(state, { verdict: 'writable', exitCode: 0, detail: 'ok' })
    expect(state.paused).toBe(true)
    expect(recordProbeOutcome(state, { verdict: 'inconclusive', exitCode: null, detail: 'timed out' })).toBe('warn')
    expect(state.paused).toBe(true)
    expect(state.list().map((r) => r.code)).toContain('push-probe')
    expect(recordProbeOutcome(state, { verdict: 'denied', exitCode: null, detail: 'read only' })).toBe('pass')
    expect(state.paused).toBe(false)
  })

  it('clears a stale warning when a later run is denied', async () => {
    const { GuardState } = await import('../src/state.js')
    const { recordProbeOutcome } = await import('../src/repo.js')
    const state = new GuardState()
    state.markVerified()
    recordProbeOutcome(state, { verdict: 'inconclusive', exitCode: null, detail: 'x' })
    recordProbeOutcome(state, { verdict: 'denied', exitCode: null, detail: 'y' })
    expect(state.listWarnings()).toEqual([])
  })
})

describe('foreignMirrorKeys (RP-5)', () => {
  it('flags a key the plugin did not write and accepts its own keys', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { foreignMirrorKeys, runGit } = await import('../src/repo.js')
    const dir = mkdtempSync(join(tmpdir(), 'rp5-'))
    const bare = join(dir, 'mirror.git')
    await runGit(['init', '--bare', '--initial-branch', 'main', bare])
    await runGit(['remote', 'add', 'origin', 'https://example.invalid/r.git'], { cwd: bare })
    expect(await foreignMirrorKeys(bare)).toEqual([])
    await runGit(['config', '--local', 'http.extraHeader', 'X-Test: 1'], { cwd: bare })
    expect(await foreignMirrorKeys(bare)).toEqual(['http.extraheader'])
  })
})
