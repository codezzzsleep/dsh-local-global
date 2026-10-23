import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  RepoMirror,
  Secret,
  classifyPushFailure,
  gitEnv,
  mirrorConfigViolations,
  probePushDenied,
  resolveRepoConfig,
  runGit,
} from '../src/repo.js'
import { GuardState } from '../src/state.js'

const identity = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@invalid',
}

const root = mkdtempSync(join(tmpdir(), 'lg-repo-hardening-'))
const outsideFile = join(root, 'outside-secret.txt')
let remote: string
let mirror: RepoMirror
let state: GuardState
let first = ''
let second = ''
const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41])

beforeAll(async () => {
  writeFileSync(outsideFile, 'TOP SECRET OUTSIDE THE REPOSITORY\n')
  const work = join(root, 'work')
  remote = join(root, 'remote.git')
  await runGit(['init', '--quiet', '--initial-branch', 'main', work])
  await runGit(['init', '--quiet', '--bare', '--initial-branch', 'main', remote])
  writeFileSync(join(work, 'a.txt'), 'hello\n')
  writeFileSync(join(work, 'bin.dat'), binary)
  writeFileSync(join(work, 'utf8.txt'), 'héllo € \ufffd literal\n')
  writeFileSync(join(work, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\n')]))
  await runGit(['add', '.'], { cwd: work })
  await runGit(['commit', '--quiet', '-m', 'first'], { cwd: work, env: identity })
  first = (await runGit(['rev-parse', 'HEAD'], { cwd: work })).stdout.trim()
  writeFileSync(join(work, 'a.txt'), 'hello world\n')
  await runGit(['commit', '--quiet', '-am', 'second'], { cwd: work, env: identity })
  second = (await runGit(['rev-parse', 'HEAD'], { cwd: work })).stdout.trim()
  await runGit(['push', '--quiet', remote, 'main'], { cwd: work, allowFile: true })
  state = new GuardState()
  mirror = new RepoMirror({ remote, branch: 'main', mirrorDir: join(root, 'mirror.git') }, { allowFile: true, state })
  await mirror.sync()
})

afterAll(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(root, { recursive: true, force: true })
})

describe('git argument injection (item 1)', () => {
  it('refuses a revision that looks like an option, and never reads outside the repository', async () => {
    await expect(mirror.diff('--no-index', outsideFile, '/dev/null')).rejects.toThrow(/must not start with "-"/)
    await expect(mirror.diff(first, '--no-index')).rejects.toThrow(/must not start with "-"/)
  })

  it('cannot be made to write a file through --output', async () => {
    const target = join(root, 'written-by-injection.txt')
    await expect(mirror.diff(`--output=${target}`, second)).rejects.toThrow()
    await expect(mirror.show(`--output=${target}`, 'a.txt')).rejects.toThrow()
    await expect(mirror.log(`--output=${target}`)).rejects.toThrow(/limit/)
    expect(existsSync(target)).toBe(false)
  })

  it('refuses paths that are options, absolute, or climb out', async () => {
    for (const bad of ['-x.txt', '--output=x', '/etc/passwd', '../outside-secret.txt', 'a/../../x', 'C:\\x', '..']) {
      await expect(mirror.diff(first, second, bad)).rejects.toThrow()
      await expect(mirror.show(second, bad)).rejects.toThrow()
    }
  })

  it('refuses revisions with whitespace or control characters and non-commits', async () => {
    await expect(mirror.diff('HEAD --output=x', second)).rejects.toThrow(/whitespace/)
    await expect(mirror.diff('main\u0000', second)).rejects.toThrow()
    await expect(mirror.show(`${second}:a.txt`, 'a.txt')).rejects.toThrow(/not a commit/)
    await expect(mirror.diff('does-not-exist', second)).rejects.toThrow(/not a commit/)
  })

  it('still diffs, logs and shows through legitimate arguments', async () => {
    const diff = await mirror.diff(first, second)
    expect(diff).toContain('+hello world')
    expect(await mirror.diff('main~1', 'main', 'a.txt')).toContain('-hello')
    expect(await mirror.diff(first, second, 'bin.dat')).toBe('')
    const log = await mirror.log(5)
    expect(log.map((entry) => entry.sha)).toEqual([second, first])
    expect((await mirror.show(second, 'a.txt')).text).toBe('hello world\n')
    expect((await mirror.show('main', 'a.txt')).text).toBe('hello world\n')
  })

  it('validates the log limit', async () => {
    for (const bad of [0, -1, 1.5, 1001, '5', Number.NaN]) await expect(mirror.log(bad)).rejects.toThrow(/limit/)
  })
})

describe('lg_repo_show is byte-exact', () => {
  it('returns valid UTF-8 as text, including a literal U+FFFD and a BOM', async () => {
    const plain = await mirror.show(second, 'utf8.txt')
    expect(plain).toMatchObject({ encoding: 'utf8', text: 'héllo € \ufffd literal\n' })
    expect(plain.bytes).toBe(Buffer.byteLength('héllo € \ufffd literal\n'))
    const bom = await mirror.show(second, 'bom.txt')
    expect(bom.encoding).toBe('utf8')
    expect(Buffer.from(bom.text, 'utf8')).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\n')]))
  })

  it('returns non-UTF-8 as explicit base64 that decodes to the original bytes', async () => {
    const result = await mirror.show(second, 'bin.dat')
    expect(result.encoding).toBe('base64')
    expect(result.bytes).toBe(binary.length)
    expect(Buffer.from(result.text, 'base64')).toEqual(binary)
  })
})

describe('mirror config check (RP-5, item 9)', () => {
  async function freshMirror(): Promise<{ mirror: RepoMirror; dir: string; state: GuardState }> {
    const dir = mkdtempSync(join(root, 'cfg-'))
    const local = new GuardState()
    const m = new RepoMirror({ remote, branch: 'main', mirrorDir: join(dir, 'mirror.git') }, { allowFile: true, state: local })
    expect(await m.ensure()).toEqual([])
    return { mirror: m, dir, state: local }
  }

  it('accepts exactly what the plugin writes', async () => {
    const { mirror: m } = await freshMirror()
    expect(await mirrorConfigViolations(m.config.mirrorDir, { remote })).toEqual([])
  })

  it('compares subsections case-sensitively: remote.ORIGIN.pushurl is a different key', async () => {
    const { mirror: m, state: local } = await freshMirror()
    await runGit(['config', '--local', 'remote.ORIGIN.pushurl', 'https://evil.invalid/x.git'], { cwd: m.config.mirrorDir })
    expect(await mirrorConfigViolations(m.config.mirrorDir, { remote })).toEqual(['remote.ORIGIN.pushurl'])
    expect(await m.ensure()).toEqual(['remote.ORIGIN.pushurl'])
    expect(local.paused).toBe(true)
    expect(local.denial()).toContain('mirror-config')
    await expect(m.sync()).rejects.toThrow(/refusing to sync/)
  })

  it('treats section and variable names case-insensitively but still checks the value', async () => {
    const { mirror: m } = await freshMirror()
    await runGit(['config', '--local', 'REMOTE.origin.PUSHURL', 'https://evil.invalid/x.git'], { cwd: m.config.mirrorDir })
    // `set-url --push` in ensure() repairs the value; a second entry cannot be repaired away.
    await runGit(['config', '--local', '--add', 'remote.origin.pushurl', 'https://evil.invalid/y.git'], { cwd: m.config.mirrorDir })
    const violations = await mirrorConfigViolations(m.config.mirrorDir, { remote })
    expect(violations.some((entry) => entry.startsWith('remote.origin.pushurl'))).toBe(true)
  })

  it('rejects an arbitrary http.proxy and a rewritten remote url', async () => {
    const { mirror: m } = await freshMirror()
    await runGit(['config', '--local', 'http.proxy', 'http://evil.invalid:3128'], { cwd: m.config.mirrorDir })
    expect(await mirrorConfigViolations(m.config.mirrorDir, { remote })).toEqual(['http.proxy (unexpected value)'])
    expect(await mirrorConfigViolations(m.config.mirrorDir, { remote, httpProxy: 'http://evil.invalid:3128' })).toEqual([])
    await runGit(['config', '--local', '--unset', 'http.proxy'], { cwd: m.config.mirrorDir })
    await runGit(['config', '--local', '--add', 'remote.origin.url', 'https://evil.invalid/x.git'], { cwd: m.config.mirrorDir })
    expect(await mirrorConfigViolations(m.config.mirrorDir, { remote })).toEqual(['remote.origin.url (set twice)'])
  })

  it('flags unknown keys such as http.extraHeader', async () => {
    const { mirror: m } = await freshMirror()
    await runGit(['config', '--local', 'http.extraHeader', 'X: 1'], { cwd: m.config.mirrorDir })
    expect(await mirrorConfigViolations(m.config.mirrorDir, { remote })).toEqual(['http.extraheader'])
  })
})

describe('push probe classification (item 7)', () => {
  it('classifies on git stderr only, not on the URL or command', () => {
    const remoteUrl = 'https://nonexistent.invalid/read-only.git'
    const dns = "fatal: unable to access 'https://nonexistent.invalid/read-only.git/': Could not resolve host: nonexistent.invalid"
    expect(classifyPushFailure(dns, remoteUrl)).toBe('inconclusive')
    expect(classifyPushFailure("fatal: unable to access 'https://denied.example/r.git/': Could not resolve host: denied.example", 'https://denied.example/r.git')).toBe('inconclusive')
    expect(classifyPushFailure("fatal: unable to access 'https://x/': Failed to connect to x port 443: Connection refused", 'https://x/')).toBe('inconclusive')
    expect(classifyPushFailure('', remoteUrl)).toBe('inconclusive')
  })

  it('recognises the spec markers', () => {
    const url = 'https://github.com/o/r.git'
    for (const stderr of [
      "remote: Permission to o/r.git denied to someone.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
      "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'remote: Invalid username or password.\nfatal: Authentication failed for ...',
      'remote: this repository is read-only',
      'Permission denied (publickey).',
    ]) {
      expect(classifyPushFailure(stderr, url)).toBe('denied')
    }
  })

  it('reports an unresolvable host as inconclusive even when the URL says read-only', async () => {
    const config = resolveRepoConfig({ remote: 'https://nonexistent.invalid/read-only.git', branch: 'main', mirrorDir: join(root, 'unused.git') })
    expect((await probePushDenied(config)).verdict).toBe('inconclusive')
  }, 60_000)
})

describe('Global channel-write credential (GD-4, item 7)', () => {
  const token = 'ghp_SUPERSECRETTOKEN0123456789'
  const seen: IncomingHttpHeaders[] = []
  let server: ReturnType<typeof createServer>
  let port = 0

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers)
      res.statusCode = 403
      res.setHeader('content-type', 'text/plain')
      res.end('Permission to code.git denied')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('runs the probe with the credential, still gets denied, and never leaks the token', async () => {
    const config = resolveRepoConfig({
      remote: `http://127.0.0.1:${String(port)}/owner/code.git`,
      branch: 'main',
      mirrorDir: join(root, 'unused2.git'),
      channelToken: token,
    })
    const probe = await probePushDenied(config)
    expect(probe.verdict).toBe('denied')
    const auth = seen.map((headers) => headers['authorization']).find((value) => value !== undefined)
    expect(auth).toBe(`Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`)
    expect(probe.detail).not.toContain(token)
    expect(probe.detail).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'))
    expect(JSON.stringify(config)).not.toContain(token)
    expect(String(config.channelToken)).toBe('[redacted]')
  }, 60_000)

  it('stays anonymous without the credential', async () => {
    seen.length = 0
    const config = resolveRepoConfig({ remote: `http://127.0.0.1:${String(port)}/owner/code.git`, branch: 'main', mirrorDir: join(root, 'unused3.git') })
    expect((await probePushDenied(config)).verdict).toBe('denied')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((headers) => headers['authorization'] === undefined)).toBe(true)
  }, 60_000)

  it('reads the token from an environment variable and refuses a missing one', () => {
    vi.stubEnv('LG_TEST_CHANNEL_TOKEN', token)
    const config = resolveRepoConfig({ remote: 'https://github.com/o/r.git', mirrorDir: join(root, 'u.git'), channelTokenEnv: 'LG_TEST_CHANNEL_TOKEN' })
    expect(config.channelToken).toBeInstanceOf(Secret)
    expect(config.channelToken?.reveal()).toBe(token)
    vi.unstubAllEnvs()
    expect(() => resolveRepoConfig({ remote: 'https://github.com/o/r.git', mirrorDir: join(root, 'u.git'), channelTokenEnv: 'LG_TEST_MISSING_TOKEN' })).toThrow(/not set/)
  })
})

describe('remote policy (RP-3, item 10)', () => {
  const base = { branch: 'main', mirrorDir: '/tmp/lg-test-mirror.git' }

  it('accepts https and the repository sandbox loopback form', () => {
    expect(resolveRepoConfig({ ...base, remote: 'https://github.com/o/r.git' }).remote).toBe('https://github.com/o/r.git')
    expect(resolveRepoConfig({ ...base, remote: 'http://127.0.0.1:8123/o/r.git' }).remote).toBe('http://127.0.0.1:8123/o/r.git')
  })

  it('refuses everything else', () => {
    for (const remote of [
      'http://127.0.0.1/o/r.git',
      'http://localhost:8123/o/r.git',
      'http://example.com/o/r.git',
      'http://127.0.0.1.evil.test:8123/r.git',
      'http://user@127.0.0.1:8123/r.git',
      'https://@github.com/o/r.git',
      'https://user:pw@github.com/o/r.git',
      'ssh://git@github.com/o/r.git',
      'git@github.com:o/r.git',
      'file:///srv/r.git',
      '/srv/r.git',
      'ext::sh -c id',
    ]) {
      expect(() => resolveRepoConfig({ ...base, remote }), remote).toThrow()
    }
  })

  it('refuses a branch that could be read as an option or a revision operator', () => {
    for (const branch of ['--output=x', '-b', 'a..b', 'a b', 'x.lock', '/x', 'a//b', '@{u}']) {
      expect(() => resolveRepoConfig({ ...base, remote: 'https://github.com/o/r.git', branch }), branch).toThrow()
    }
  })

  it('denies the file transport unless a test opts in explicitly', async () => {
    const clone = join(root, 'file-clone')
    await expect(runGit(['clone', '--quiet', remote, clone])).rejects.toThrow(/not allowed|transport/i)
    await runGit(['clone', '--quiet', remote, clone], { allowFile: true })
    expect(existsSync(join(clone, 'a.txt'))).toBe(true)
  })
})

describe("git's environment (RP-4)", () => {
  it('contains no HOME, SSH_AUTH_SOCK, user git config, or inherited transport settings', () => {
    vi.stubEnv('HOME', '/home/someone')
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    vi.stubEnv('GIT_SSH', '/usr/bin/ssh')
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/home/someone/.gitconfig')
    vi.stubEnv('GIT_ASKPASS', '/usr/bin/askpass')
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'core.sshCommand=evil'")
    vi.stubEnv('XDG_CONFIG_HOME', '/home/someone/.config')
    const env = gitEnv()
    vi.unstubAllEnvs()
    expect(Object.keys(env).sort()).toEqual(
      ['GIT_ALLOW_PROTOCOL', 'GIT_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'PATH', 'XDG_CONFIG_HOME'].sort(),
    )
    expect(env['HOME']).toBe('/nonexistent-lg-home')
    expect(env['XDG_CONFIG_HOME']).toBe('/nonexistent-lg-home')
    expect(env['SSH_AUTH_SOCK']).toBeUndefined()
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null')
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1')
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0')
    expect(env['GIT_ASKPASS']).toBe('/bin/false')
    expect(env['GIT_SSH_COMMAND']).toBe('/bin/false')
    expect(env['GIT_ALLOW_PROTOCOL']).toBe('https:http')
  })

  it('really runs git without the user config the parent process points at', async () => {
    const userConfig = join(root, 'user.gitconfig')
    writeFileSync(userConfig, '[user]\n\tname = Leaked User\n[alias]\n\tleak = status\n')
    vi.stubEnv('GIT_CONFIG_GLOBAL', userConfig)
    try {
      await expect(runGit(['config', '--get', 'user.name'], { cwd: root })).rejects.toThrow(/exit 1/)
      await expect(runGit(['config', '--get', 'alias.leak'], { cwd: root })).rejects.toThrow(/exit 1/)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(readFileSync(userConfig, 'utf8')).toContain('Leaked User')
  })
})
