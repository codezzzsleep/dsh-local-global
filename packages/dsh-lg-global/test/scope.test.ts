import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkFetchTarget,
  checkPath,
  hostAllowed,
  isInside,
  isPrivateAddress,
  resolveScopeConfig,
} from '../src/scope.js'
import { checkPreset, checkTools, resolveIntegrityConfig, DEFAULT_ALLOWED_TOOLS } from '../src/integrity.js'

const root = mkdtempSync(join(tmpdir(), 'lg-scope-test-'))
const workspace = join(root, 'workspace')
const outside = join(root, 'outside')
mkdirSync(join(workspace, 'drafts'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(workspace, 'drafts', 'note.txt'), 'inside\n')
writeFileSync(join(outside, 'secret.txt'), 'outside\n')
try {
  symlinkSync(outside, join(workspace, 'escape-link'))
  symlinkSync(join(workspace, 'drafts'), join(workspace, 'inside-link'))
} catch {
  // Symlinks may be unavailable; the cases below then simply fail closed.
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const config = resolveScopeConfig({ workspace })

describe('isPrivateAddress', () => {
  it('flags loopback, private, and link-local IPv4', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1']) {
      expect(isPrivateAddress(address)).toBe(true)
    }
  })

  it('flags IPv6 loopback, unique-local, and link-local', () => {
    for (const address of ['::1', 'fd00::1', 'fe80::1']) expect(isPrivateAddress(address)).toBe(true)
  })

  it('accepts public addresses', () => {
    expect(isPrivateAddress('140.82.112.3')).toBe(false)
    expect(isPrivateAddress('2606:4700::1111')).toBe(false)
  })
})

describe('hostAllowed', () => {
  const allow = ['github.com']

  it('accepts the exact host and subdomains', () => {
    expect(hostAllowed('github.com', allow)).toBe(true)
    expect(hostAllowed('api.github.com', allow)).toBe(true)
  })

  it('rejects lookalikes and other hosts', () => {
    expect(hostAllowed('evil-github.com', allow)).toBe(false)
    expect(hostAllowed('github.com.evil.test', allow)).toBe(false)
    expect(hostAllowed('example.com', allow)).toBe(false)
  })
})

describe('isInside', () => {
  it('accepts the workspace and its descendants', () => {
    expect(isInside(workspace, workspace)).toBe(true)
    expect(isInside(workspace, join(workspace, 'drafts', 'note.txt'))).toBe(true)
  })

  it('rejects a sibling and a .. escape', () => {
    expect(isInside(workspace, outside)).toBe(false)
    expect(isInside(workspace, join(workspace, '..', 'outside', 'secret.txt'))).toBe(false)
  })
})

describe('checkPath', () => {
  it('denies a path outside the workspace', () => {
    expect(checkPath(config, 'read', join(outside, 'secret.txt'))).toContain('escapes the Global workspace')
  })

  it('denies a .. escape', () => {
    expect(checkPath(config, 'read', '../outside/secret.txt')).toContain('escapes the Global workspace')
  })

  it('denies a symlink that leaves the workspace', () => {
    expect(checkPath(config, 'read', join(workspace, 'escape-link', 'secret.txt'))).toContain('escapes the Global workspace')
  })

  it('allows a symlink that stays inside', () => {
    expect(checkPath(config, 'read', join(workspace, 'inside-link', 'note.txt'))).toBeUndefined()
  })

  it('allows reads inside and restricts writes to drafts', () => {
    expect(checkPath(config, 'read', 'drafts/note.txt')).toBeUndefined()
    expect(checkPath(config, 'write', 'drafts/new.txt')).toBeUndefined()
    expect(checkPath(config, 'write', 'outside-drafts.txt')).toContain('may only write inside')
  })
})

describe('checkFetchTarget', () => {
  it('rejects a non-http protocol', async () => {
    expect(await checkFetchTarget(config, 'file:///etc/passwd')).toContain('only allows http and https')
  })

  it('rejects a host outside the allowlist', async () => {
    expect(await checkFetchTarget(config, 'https://example.com/')).toContain('not in the allowlist')
  })

  it('rejects a literal private address even when allowlisted', async () => {
    const permissive = resolveScopeConfig({ workspace, allowDomains: ['127.0.0.1'] })
    expect(await checkFetchTarget(permissive, 'http://127.0.0.1/')).toContain('private address')
  })

  it('rejects an unparseable url', async () => {
    expect(await checkFetchTarget(config, 'not a url')).toContain('not a URL')
  })
})

describe('integrity checks', () => {
  it('accepts the expected preset and reports the mismatch otherwise', () => {
    expect(checkPreset({ defaultId: 'lg-global' }, 'lg-global').pass).toBe(true)
    const failed = checkPreset({ defaultId: 'standard' }, 'lg-global')
    expect(failed.pass).toBe(false)
    expect(failed.detail).toContain('defaultId=standard')
  })

  it('flags a tool outside the whitelist', () => {
    expect(checkTools([...DEFAULT_ALLOWED_TOOLS], DEFAULT_ALLOWED_TOOLS).pass).toBe(true)
    const failed = checkTools([...DEFAULT_ALLOWED_TOOLS, 'bash'], DEFAULT_ALLOWED_TOOLS)
    expect(failed.pass).toBe(false)
    expect(failed.detail).toContain('bash')
  })

  it('defaults to the documented preset and profile prefix', () => {
    const resolved = resolveIntegrityConfig({})
    expect(resolved.expectedPreset).toBe('lg-global')
    expect(resolved.profilePrefix).toBe('lg-global')
    expect(resolved.allowedTools).not.toContain('present')
  })
})
