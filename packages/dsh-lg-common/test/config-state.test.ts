import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveChannelConfig } from '../src/config.js'
import { redactSecrets } from '../src/redact.js'
import { StateStore, initialState } from '../src/state.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lg-cfg-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('resolveChannelConfig', () => {
  it('turns a missing config into a clear error, not a TypeError from property access', () => {
    expect(() => resolveChannelConfig(undefined)).toThrow(/configuration is missing/u)
    expect(() => resolveChannelConfig(null)).toThrow(/"repo".*"role"/u)
  })

  it('still names the missing field when the config is partial', () => {
    expect(() => resolveChannelConfig({ role: 'local' })).toThrow(/"repo" is required/u)
    expect(() => resolveChannelConfig({ repo: 'file:///x.git' })).toThrow(/"role" is required/u)
  })

  it('refuses a repo that git would read as an option, and an unusable branch', () => {
    expect(() => resolveChannelConfig({ repo: '--upload-pack=evil', role: 'local' })).toThrow(/not an option/u)
    for (const branch of ['-x', 'a..b', 'x/', 'x.lock', '']) {
      expect(() => resolveChannelConfig({ repo: 'file:///x.git', role: 'local', branch })).toThrow(/branch/u)
    }
    expect(resolveChannelConfig({ repo: 'file:///x.git', role: 'local', branch: 'release/v1' }, dir).branch).toBe('release/v1')
  })
})

describe('redactSecrets', () => {
  it.each([
    ['https://user:pw@example.com/a/b.git', 'https://***@example.com/a/b.git'],
    ['https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r', 'https://***@github.com/o/r'],
    ['fatal: unable to access \'https://u:p%40ss@host/r.git/\': nope', "fatal: unable to access 'https://***@host/r.git/': nope"],
    ['token=abcdef0123456789', 'token=***'],
    ['Authorization: Bearer abc.def', 'Authorization: ***'],
    ['key ghp_abcdefghijklmnopqrstuvwxyz0123456789 here', 'key *** here'],
    ['github_pat_11AAAAAAA0abcdefghijklmnop_xyz', '***'],
  ])('masks %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it('leaves ordinary text and credential-free URLs alone', () => {
    const text = 'https://github.com/codezzzsleep/dsh-local-global.git and file:///tmp/channel.git'
    expect(redactSecrets(text)).toBe(text)
  })
})

describe('StateStore', () => {
  const repo = 'https://alice:s3cr3t@host.example/org/chan.git'

  it('never writes the credential to disk, and still recognises a file written with the raw URL', async () => {
    const file = join(dir, 'state.json')
    const store = new StateStore(file)
    await store.save({ ...initialState(repo, 'local'), cursor: '0007', boundSessionId: 's1' })
    expect(await readFile(file, 'utf8')).not.toContain('s3cr3t')
    expect((await store.load(repo, 'local')).cursor).toBe('0007')
    // A rotated token must not reset the cursor either.
    expect((await store.load('https://alice:newtoken@host.example/org/chan.git', 'local')).cursor).toBe('0007')

    // Older versions saved the raw URL; that file must keep working.
    await writeFile(file, JSON.stringify({ repo, role: 'local', cursor: '0009', boundSessionId: 's2', deliveredIds: ['G-0001'], halted: false, updatedAt: 'x' }))
    const loaded = await store.load(repo, 'local')
    expect(loaded).toMatchObject({ cursor: '0009', boundSessionId: 's2', deliveredIds: ['G-0001'], archived: [], reportedMismatches: [] })
    await store.save(loaded)
    expect(await readFile(file, 'utf8')).not.toContain('s3cr3t')
  })

  it('starts fresh for another repo or role', async () => {
    const file = join(dir, 'state.json')
    const store = new StateStore(file)
    await store.save({ ...initialState(repo, 'local'), cursor: '0007' })
    expect((await store.load('https://host.example/other.git', 'local')).cursor).toBe('0000')
    expect((await store.load(repo, 'global')).cursor).toBe('0000')
  })

  it('survives concurrent saves without a torn file', async () => {
    const file = join(dir, 'nested', 'state.json')
    await mkdir(join(dir, 'nested'))
    const store = new StateStore(file)
    await Promise.all(Array.from({ length: 20 }, async (_, index) => await store.save({ ...initialState(repo, 'local'), cursor: String(index).padStart(4, '0') })))
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ role: 'local' })
  })
})
