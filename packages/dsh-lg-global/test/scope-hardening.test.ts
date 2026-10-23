import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PATH_RULES,
  checkPath,
  createScopeRuntime,
  isInside,
  isPrivateAddress,
  resolveScopeConfig,
  resolveToolPath,
  type SessionCwds,
} from '../src/scope.js'
import { checkTools } from '../src/integrity.js'
import { GuardState } from '../src/state.js'
import { DEFAULT_ALLOWED_TOOLS } from '../src/tools.js'

const root = mkdtempSync(join(tmpdir(), 'lg-scope-hardening-'))
const workspace = join(root, 'workspace')
const outside = join(root, 'outside')
mkdirSync(join(workspace, 'drafts', 'sub'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(workspace, 'LG-ROLE.md'), 'role\n')
writeFileSync(join(workspace, 'drafts', 'note.txt'), 'inside\n')
writeFileSync(join(root, 'top-secret.txt'), 'outside the workspace\n')
symlinkSync(outside, join(workspace, 'escape-link'))
symlinkSync(join(workspace, 'drafts'), join(workspace, 'inside-link'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const config = resolveScopeConfig({ workspace })

function guardFor(cwds: SessionCwds | (() => SessionCwds), overrides: Partial<Parameters<typeof resolveScopeConfig>[0]> = {}) {
  const state = new GuardState()
  state.markVerified()
  const agent = { session: { header: { cwd: workspace } } }
  state.markAgentReady(agent)
  const scope = resolveScopeConfig({ workspace, ...overrides })
  const runtime = createScopeRuntime({ config: scope, state, cwds: typeof cwds === 'function' ? cwds : () => cwds })
  let n = 0
  const call = (name: string, args: unknown = {}, who: unknown = agent) => runtime.guard({ name, arguments: args, callId: `call-${String(n++)}`, agent: who })
  return { state, agent, runtime, call }
}

describe('isPrivateAddress (item 8)', () => {
  it.each([
    '::7f00:1',
    '::127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    '::ffff:0:7f00:1',
    '::a00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    '2002:a00:1::1',
    '2002:c0a8:101::',
    'fe80::1',
    'fe90::1',
    'febf::1',
    'fec0::1',
    'fd00::1',
    'fc00::1',
    'ff02::1',
    '::',
    '::1',
    '2001:db8::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '::5efe:7f00:1',
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
  ])('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each([
    '8.8.8.8',
    '140.82.112.3',
    '100.63.255.255',
    '100.128.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '198.17.255.255',
    '198.20.0.1',
    '2606:4700::1111',
    '2002:808:808::',
    '64:ff9b::808:808',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
  ])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false)
  })
})

describe('path resolution matches how dsh-fs-local resolves (item 4)', () => {
  it('walks symlinks physically: <ws>/escape-link/../top-secret.txt is outside', () => {
    const spelled = `${workspace}/escape-link/../top-secret.txt`
    expect(resolveToolPath(workspace, spelled)).toBe(join(root, 'top-secret.txt'))
    expect(checkPath(config, 'read', spelled, workspace)).toContain('escapes the Global workspace')
    expect(isInside(workspace, spelled)).toBe(false)
  })

  it('treats a .. through an inside symlink physically too', () => {
    // inside-link -> drafts, so inside-link/.. is the workspace, not drafts' lexical parent twice removed.
    expect(checkPath(config, 'read', `${workspace}/inside-link/../LG-ROLE.md`, workspace)).toBeUndefined()
    expect(checkPath(config, 'write', `${workspace}/inside-link/../LG-ROLE.md`, workspace)).toContain('may not write')
  })

  it('does not stop at 64 ancestors: a deep missing path through an escaping symlink is outside', () => {
    const deep = `${workspace}/escape-link/${'d/'.repeat(80)}file.txt`
    expect(checkPath(config, 'write', deep, workspace)).toContain('escapes the Global workspace')
    expect(checkPath(config, 'read', deep, workspace)).toContain('escapes the Global workspace')
    expect(isInside(workspace, deep)).toBe(false)
    const deepInside = `${workspace}/drafts/${'d/'.repeat(80)}file.txt`
    expect(checkPath(config, 'write', deepInside, workspace)).toBeUndefined()
  })

  it('refuses a missing directory crossed by .. exactly as the tool would', () => {
    expect(checkPath(config, 'read', `${workspace}/drafts/missing/../note.txt`, workspace)).toContain('cannot be resolved')
  })

  it('rejects empty paths and NUL bytes', () => {
    expect(checkPath(config, 'read', 'a\0b', workspace)).toContain('cannot be resolved')
    expect(() => resolveToolPath(workspace, '')).toThrow()
  })
})

describe('relative paths follow the current working directory (item 4c)', () => {
  it('resolves LG-ROLE.md against the cwd the tool will use, not the creation cwd', () => {
    // Session was created in drafts/, then `working_directory cd` moved it to the workspace.
    const { call } = guardFor({ current: workspace, frozen: join(workspace, 'drafts') })
    expect(call('write', { file_path: 'LG-ROLE.md', content: 'x' })).toContain('protected path')
    expect(call('edit', { file_path: 'LG-ROLE.md', old_string: 'a', new_string: 'b' })).toContain('protected path')
    expect(call('write', { file_path: 'other.md', content: 'x' })).toContain('may only write inside')
    expect(call('read', { file_path: 'LG-ROLE.md' })).toBeUndefined()
  })

  it('allows a write the current cwd puts inside drafts even if the creation cwd would not', () => {
    const { call } = guardFor({ current: join(workspace, 'drafts'), frozen: workspace })
    expect(call('write', { file_path: 'new.txt', content: 'x' })).toBeUndefined()
  })

  it('denies path tools when the working directory service has no answer', () => {
    const { call } = guardFor({ frozen: workspace })
    expect(call('read', { file_path: 'drafts/note.txt' })).toContain('working directory')
  })

  it('checks `cd` and the default cwd of glob/grep', () => {
    const { call } = guardFor({ current: workspace, frozen: workspace })
    expect(call('working_directory', { cd: '../outside' })).toContain('escapes the Global workspace')
    expect(call('working_directory', { cd: 'drafts' })).toBeUndefined()
    expect(call('working_directory', {})).toBeUndefined()
    expect(call('glob', { pattern: '*' })).toBeUndefined()
    expect(call('grep', { pattern: 'x', path: '../outside' })).toContain('escapes')
  })

  it('reads each tool\'s own path argument, so an alias key cannot steer the check', () => {
    const { call } = guardFor({ current: workspace, frozen: workspace })
    // grep reads `path`; a harmless `file_path` next to a hostile `path` must not hide it.
    expect(call('grep', { pattern: 'x', file_path: 'drafts', path: join(outside) })).toContain('escapes')
    expect(call('read', { file_path: 5 })).toContain('must be a string')
    expect(call('read', {})).toContain('without a file_path')
  })
})

describe('every writing tool is held to the write roots (item 2)', () => {
  it('lists the evidence exporter as a writer', () => {
    expect(PATH_RULES['lg_evidence_session']).toMatchObject({ arg: 'out', write: true })
    expect(PATH_RULES['write']?.write).toBe(true)
    expect(PATH_RULES['edit']?.write).toBe(true)
  })

  it('denies lg_evidence_session writing the role file or anything outside drafts', () => {
    const { call } = guardFor({ current: workspace, frozen: workspace })
    expect(call('lg_evidence_session', { out: 'LG-ROLE.md' })).toContain('protected path')
    expect(call('lg_evidence_session', { out: join(workspace, 'LG-ROLE.md') })).toContain('protected path')
    expect(call('lg_evidence_session', { out: 'notes.jsonl' })).toContain('may only write inside')
    expect(call('lg_evidence_session', { out: 'drafts/evidence/session.jsonl' })).toBeUndefined()
  })

  it('checks both the current and the creation cwd for the exporter (it resolves against the latter)', () => {
    const { call } = guardFor({ current: join(workspace, 'drafts'), frozen: workspace })
    expect(call('lg_evidence_session', { out: 'LG-ROLE.md' })).toContain('protected path')
    // `ok.jsonl` is inside drafts for the current cwd but not for the creation cwd the exporter uses.
    expect(call('lg_evidence_session', { out: 'ok.jsonl' })).toContain('may only write inside')
    expect(call('lg_evidence_session', { out: 'drafts/ok.jsonl' })).toBeUndefined()
  })

  it('also sees the lexical spelling the exporter writes to', () => {
    const { call } = guardFor({ current: workspace, frozen: workspace })
    // The exporter normalises lexically: escape-link/../x becomes <ws>/x, which is outside drafts.
    expect(call('lg_evidence_session', { out: 'drafts/../LG-ROLE.md' })).toContain('protected path')
  })

  it('refuses a session id that is a path', () => {
    const { call } = guardFor({ current: workspace, frozen: workspace })
    expect(call('lg_evidence_session', { out: 'drafts/e.jsonl', session: '../../other' })).toContain('plain session id')
    expect(call('lg_evidence_session', { out: 'drafts/e.jsonl', session: 'abc-123' })).toBeUndefined()
  })

  it('never lets the role file be written, whatever the write roots are', () => {
    const wide = guardFor({ current: workspace, frozen: workspace }, { writeRoots: ['.'] })
    expect(wide.call('write', { file_path: 'LG-ROLE.md', content: 'x' })).toContain('may not write the protected path')
    expect(wide.call('edit', { file_path: 'LG-ROLE.md', old_string: 'a', new_string: 'b' })).toContain('may not write the protected path')
    expect(wide.call('lg_evidence_session', { out: 'LG-ROLE.md' })).toContain('may not write the protected path')
    expect(wide.call('write', { file_path: 'other.md', content: 'x' })).toBeUndefined()
  })

  it('resolves a symlink to the role file before deciding', () => {
    symlinkSync(join(workspace, 'LG-ROLE.md'), join(workspace, 'drafts', 'role-alias'))
    const wide = guardFor({ current: workspace, frozen: workspace })
    expect(wide.call('write', { file_path: 'drafts/role-alias', content: 'x' })).toContain('may not write the protected path')
  })

  it('protects paths other plugins register, such as the mirror', () => {
    const { call, state } = guardFor({ current: workspace, frozen: workspace }, { writeRoots: ['.'] })
    state.protect(join(workspace, 'repo.git'))
    expect(call('write', { file_path: 'repo.git/config', content: 'x' })).toContain('may not write the protected path')
  })

  it('protects a role file configured under another name', () => {
    writeFileSync(join(workspace, 'MY-ROLE.md'), 'r\n')
    const custom = guardFor({ current: workspace, frozen: workspace }, { writeRoots: ['.'], roleFile: 'MY-ROLE.md' })
    expect(custom.call('write', { file_path: 'MY-ROLE.md', content: 'x' })).toContain('may not write the protected path')
  })

  it('rejects write roots outside the workspace', () => {
    expect(() => resolveScopeConfig({ workspace, writeRoots: ['../outside'] })).toThrow(/outside the workspace/)
    expect(() => resolveScopeConfig({ workspace, writeRoots: ['/etc'] })).toThrow(/outside the workspace/)
  })
})

describe('the call-time tool guard is an exact allow-list (item 3)', () => {
  const forbidden = ['run_code', 'exec', 'shell', 'sh', 'python', 'Bash', 'jobs', 'lg_shell', 'lg_apply_patch', 'lg_evidence_add', 'lg_evidence_check', 'present', 'Read', 'read ']

  it.each(forbidden)('refuses %s and pauses', (tool) => {
    const { call, state } = guardFor({ current: workspace, frozen: workspace })
    const reason = call(tool, {})
    expect(reason).toContain('not an allowed Global tool')
    expect(state.paused).toBe(true)
    expect(state.denial()).toContain('tool-whitelist')
  })

  it('keeps refusing the denied prefixes even if a config tried to allow them', () => {
    expect(() => resolveScopeConfig({ workspace, allowedTools: ['read', 'bash_tool'] })).toThrow(/cannot be allowed/)
    const { call } = guardFor({ current: workspace, frozen: workspace })
    for (const tool of ['bash', 'pwsh', 'terminal_run', 'job_start', 'subagent_spawn', 'task']) {
      expect(call(tool, {})).toContain('execution or derivation tool')
    }
  })

  it('allows every name on the list, including the six M4 tools', () => {
    for (const tool of ['lg_directive', 'lg_review', 'lg_decision', 'lg_draft_reset', 'lg_patch_send', 'lg_stop']) {
      expect(DEFAULT_ALLOWED_TOOLS).toContain(tool)
      const { call, state } = guardFor({ current: workspace, frozen: workspace })
      expect(call(tool, {})).toBeUndefined()
      expect(state.paused).toBe(false)
    }
  })

  it('refuses a call from a session whose integrity run has not completed, except lg_integrity_check', () => {
    const { call, state } = guardFor({ current: workspace, frozen: workspace })
    const stranger = { session: {} }
    expect(call('read', { file_path: 'drafts/note.txt' }, stranger)).toContain('has not completed')
    expect(call('read', { file_path: 'drafts/note.txt' }, null)).toContain('has not completed')
    expect(call('lg_integrity_check', {}, stranger)).toBeUndefined()
    expect(state.paused).toBe(false)
  })

  it('identifies a session by its id, so a wrapper around the same agent is still ready', () => {
    const { state, runtime } = guardFor({ current: workspace, frozen: workspace })
    state.markAgentReady({ id: 's-1', session: { id: 's-1' } })
    const wrapper = { id: 's-1', other: true }
    const reason = runtime.guard({ name: 'read', callId: 'x', arguments: { file_path: 'drafts/note.txt' }, agent: wrapper })
    expect(reason).toBeUndefined()
    expect(runtime.guard({ name: 'read', callId: 'y', arguments: { file_path: 'drafts/note.txt' }, agent: { id: 's-2' } })).toContain('has not completed')
  })

  it('never allows lg_integrity_check to be configured away', () => {
    expect(resolveScopeConfig({ workspace, allowedTools: ['read'] }).allowedTools).toContain('lg_integrity_check')
  })

  it('while paused refuses everything except lg_integrity_check', () => {
    const { call, state } = guardFor({ current: workspace, frozen: workspace })
    state.pause('push-probe', 'writable')
    expect(call('read', { file_path: 'drafts/note.txt' })).toContain('lg-global paused: push-probe')
    expect(call('lg_repo_log', {})).toContain('lg-global paused')
    expect(call('lg_integrity_check', {})).toBeUndefined()
  })

  it('the exact check rejects Local-only lg_* tools at visibility time as well', () => {
    expect(checkTools([...DEFAULT_ALLOWED_TOOLS], DEFAULT_ALLOWED_TOOLS).pass).toBe(true)
    for (const extra of ['lg_apply_patch', 'lg_evidence_add', 'lg_shell', 'exec', 'present']) {
      const result = checkTools([...DEFAULT_ALLOWED_TOOLS, extra], DEFAULT_ALLOWED_TOOLS)
      expect(result.pass, extra).toBe(false)
      expect(result.detail).toContain(extra)
    }
  })
})

describe('network verdicts bind the call and the url (SC-8)', () => {
  const allow = { allowDomains: ['8.8.8.8', '127.0.0.1'] }

  it('refuses a call whose url was rewritten after pre-execute', async () => {
    const { runtime, agent } = guardFor({ current: workspace, frozen: workspace }, allow)
    await runtime.preExecute({ name: 'web_fetch', callId: 'c1', arguments: { url: 'https://8.8.8.8/a' } })
    const reason = runtime.guard({ name: 'web_fetch', callId: 'c1', arguments: { url: 'https://8.8.8.8/b' }, agent })
    expect(reason).toContain('does not match the requested url')
  })

  it('allows the same call and url, once', async () => {
    const { runtime, agent } = guardFor({ current: workspace, frozen: workspace }, allow)
    await runtime.preExecute({ name: 'web_fetch', callId: 'c2', arguments: { url: 'https://8.8.8.8/a' } })
    expect(runtime.guard({ name: 'web_fetch', callId: 'c2', arguments: { url: 'https://8.8.8.8/a' }, agent })).toBeUndefined()
    expect(runtime.guard({ name: 'web_fetch', callId: 'c2', arguments: { url: 'https://8.8.8.8/a' }, agent })).toContain('no network verdict')
  })

  it('refuses a call that never went through pre-execute', () => {
    const { runtime, agent } = guardFor({ current: workspace, frozen: workspace }, allow)
    expect(runtime.guard({ name: 'web_fetch', callId: 'c3', arguments: { url: 'https://8.8.8.8/a' }, agent })).toContain('no network verdict')
  })

  it('refuses a verdict recorded for another call id', async () => {
    const { runtime, agent } = guardFor({ current: workspace, frozen: workspace }, allow)
    await runtime.preExecute({ name: 'web_fetch', callId: 'other', arguments: { url: 'https://8.8.8.8/a' } })
    expect(runtime.guard({ name: 'web_fetch', callId: 'c4', arguments: { url: 'https://8.8.8.8/a' }, agent })).toContain('no network verdict')
  })

  it('refuses a private address even when its host is allowlisted', async () => {
    const { runtime, agent } = guardFor({ current: workspace, frozen: workspace }, allow)
    await runtime.preExecute({ name: 'web_fetch', callId: 'c5', arguments: { url: 'http://127.0.0.1/' } })
    expect(runtime.guard({ name: 'web_fetch', callId: 'c5', arguments: { url: 'http://127.0.0.1/' }, agent })).toContain('private address')
  })

  it('treats a bracketed IPv6 literal as an address, not a hostname to resolve', async () => {
    const { runtime, agent } = guardFor({ current: workspace, frozen: workspace }, { allowDomains: ['::1', '::ffff:7f00:1'] })
    for (const [id, url] of [
      ['c6', 'http://[::1]/'],
      ['c7', 'http://[::ffff:7f00:1]/'],
    ] as const) {
      await runtime.preExecute({ name: 'web_fetch', callId: id, arguments: { url } })
      expect(runtime.guard({ name: 'web_fetch', callId: id, arguments: { url }, agent })).toContain('private address')
    }
  })
})
