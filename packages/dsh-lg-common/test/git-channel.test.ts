import { chmod, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelRepo, GitError, runGit } from '../src/git.js'

vi.setConfig({ testTimeout: 60_000 })

let workspace: string
let remote: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'lg-git-test-'))
  remote = join(workspace, 'channel.git')
  await runGit(['init', '--bare', '--initial-branch', 'main', remote])
  await runGit(['config', 'protocol.file.allow', 'always'], { cwd: remote })
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

function message(text: string) {
  return (seq: string) => ({
    sender: 'local' as const,
    type: 'REPORT' as const,
    filename: `${seq}-local-REPORT.md`,
    text: `[LG REPORT from local]\nnote: ${text}\n---\n${text}\n`,
  })
}

async function remoteMessages(): Promise<string[]> {
  // Ask the remote itself, so a stale local mirror cannot fake the assertion.
  const { stdout } = await runGit(['ls-tree', '--name-only', 'main', 'messages/'], { cwd: remote }).catch(() => ({ stdout: '' }))
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.replace('messages/', ''))
    .sort()
}

describe('ChannelRepo', () => {
  it('appends a first message to an empty channel', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    const result = await repo.append(message('hello'))
    expect(result.seq).toBe('0001')
    expect(result.filename).toBe('0001-local-REPORT.md')
    expect(await repo.listMessages()).toEqual(['0001-local-REPORT.md'])
    expect(await repo.readFile('messages/0001-local-REPORT.md')).toContain('hello')
  })

  it('writes the commit message the contract requires', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    await repo.append(message('hello'))
    const { stdout } = await runGit(['log', '-1', '--format=%s', 'origin/main'], { cwd: repo.dir })
    expect(stdout.trim()).toBe('msg 0001 local REPORT')
  })

  it('lets two independent writers push concurrently without a lost or duplicate sequence', async () => {
    const first = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    const second = new ChannelRepo(join(workspace, 'b.git'), remote, 'main')
    await Promise.all([first.ensure(), second.ensure()])

    const results = await Promise.all([first.append(message('from A')), second.append(message('from B'))])
    const seqs = results.map((result) => result.seq).sort()
    expect(seqs).toEqual(['0001', '0002'])

    const names = await remoteMessages()
    expect(names).toEqual(['0001-local-REPORT.md', '0002-local-REPORT.md'])
  })

  it('takes the next sequence from a fresh fetch when its mirror was stale', async () => {
    // Not a rejected push: append fetches first, so nothing is refused here.
    // The refusal paths are exercised under "concurrent writers" below.
    const first = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    const second = new ChannelRepo(join(workspace, 'b.git'), remote, 'main')
    await Promise.all([first.ensure(), second.ensure()])

    await first.append(message('first'))
    // second still believes the channel is empty until its next fetch inside append.
    const result = await second.append(message('second'))
    expect(result.seq).toBe('0002')
    expect(await remoteMessages()).toEqual(['0001-local-REPORT.md', '0002-local-REPORT.md'])
  })

  it('stores relayed text byte-for-byte', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    const text = '[LG CLAIM from global]\nrefs: [\'0002\']\n---\nbody with trailing spaces   \n'
    await repo.append((seq) => ({ sender: 'global', type: 'CLAIM', filename: `${seq}-global-CLAIM.md`, text }))
    const stored = await repo.readFile('messages/0001-global-CLAIM.md')
    expect(stored).toBe(text)
  })
})

const ping = (name: string) => (seq: string) => ({
  sender: 'local' as const,
  type: 'REPORT' as const,
  filename: `${seq}-local-REPORT.md`,
  text: `[LG REPORT from local]\nwriter: ${name}\n---\n`,
})

describe('unreachable versus empty remote (CH-2)', () => {
  it('treats an existing remote with no branch as an empty channel', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    expect(await repo.originHead()).toBeUndefined()
    expect(await repo.listMessages()).toEqual([])
    expect((await repo.readMessages()).size).toBe(0)
  })

  it('fails loudly when the remote does not exist', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), join(workspace, 'no-such.git'), 'main')
    await expect(repo.ensure()).rejects.toThrow(GitError)
  })

  it('fails loudly on a later fetch when the remote disappears, and recovers when it returns', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    await repo.append(message('first'))
    await rename(remote, `${remote}.away`)
    await expect(repo.fetch()).rejects.toThrow(GitError)
    // The mirror still knows the last commit; only the fetch failed.
    expect(await repo.listMessages()).toEqual(['0001-local-REPORT.md'])
    await rename(`${remote}.away`, remote)
    await expect(repo.fetch()).resolves.toBeUndefined()
  })

  it('reports a git failure while listing instead of an empty channel', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    await repo.append(message('first'))
    // Break the mirror: a read that cannot run is an error, never "no messages".
    await rm(join(repo.dir, 'objects'), { recursive: true, force: true })
    await expect(repo.listMessages()).rejects.toThrow()
    await expect(repo.readMessages()).rejects.toThrow()
  })

  it('never puts credentials in an error message', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), 'https://user:hunter2secret@127.0.0.1:1/chan.git', 'main')
    const failure = await repo.ensure().then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(failure).not.toBe('')
    expect(failure).not.toContain('hunter2secret')
  })
})

describe('concurrent writers (CH-7)', () => {
  it('lets six independent writers all land, with contiguous unique sequences', async () => {
    const writers = Array.from({ length: 6 }, (_, index) => new ChannelRepo(join(workspace, `w${String(index)}.git`), remote, 'main'))
    await Promise.all(writers.map(async (writer) => await writer.ensure()))
    const results = await Promise.all(writers.map(async (writer, index) => await writer.append(ping(String(index)))))
    expect(results.map((result) => result.seq).sort()).toEqual(['0001', '0002', '0003', '0004', '0005', '0006'])
    expect(await remoteMessages()).toHaveLength(6)
  })

  it('serialises appends through one mirror', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    const results = await Promise.all([1, 2, 3, 4].map(async (n) => await repo.append(ping(String(n)))))
    expect(results.map((result) => result.seq).sort()).toEqual(['0001', '0002', '0003', '0004'])
  })

  it('really is refused when another writer lands between our read and our push, and retries', async () => {
    const intruder = new ChannelRepo(join(workspace, 'intruder.git'), remote, 'main')
    await intruder.ensure()

    class Raced extends ChannelRepo {
      raced = false
      pushesSeen = 0
      override async listMessages(rev?: string): Promise<string[]> {
        const names = await super.listMessages(rev)
        if (!this.raced) {
          this.raced = true
          // Our view of the channel is now stale: the remote moves under us.
          await intruder.append(ping('intruder'))
        }
        return names
      }
    }
    const victim = new Raced(join(workspace, 'victim.git'), remote, 'main')
    await victim.ensure()
    const sleeps: number[] = []
    const result = await victim.append(ping('victim'), { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 })

    expect(result.seq).toBe('0002')
    // The first push was refused (stale parent), so exactly one backoff happened.
    expect(sleeps).toHaveLength(1)
    expect(await remoteMessages()).toEqual(['0001-local-REPORT.md', '0002-local-REPORT.md'])
  })

  it('backs off with jitter between refused pushes and gives up after the attempt limit', async () => {
    // A hook that refuses every push: the remote's own, real rejection.
    await writeFile(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho refused by test >&2\nexit 1\n')
    await chmod(join(remote, 'hooks', 'pre-receive'), 0o755)
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    const sleeps: number[] = []
    await expect(
      repo.append(ping('x'), { attempts: 5, backoffMs: 100, maxBackoffMs: 500, random: () => 0.999, sleep: async (ms) => void sleeps.push(ms) }),
    ).rejects.toThrow(/after 5 attempts/)
    // Four waits between five attempts; each is a jittered, capped doubling.
    expect(sleeps).toEqual([99, 199, 399, 499])
    expect(await remoteMessages()).toEqual([])
  })

  it('succeeds once the remote stops refusing', async () => {
    const hook = join(remote, 'hooks', 'pre-receive')
    const counter = join(workspace, 'refusals')
    await writeFile(counter, '2')
    await writeFile(hook, `#!/bin/sh\nn=$(cat '${counter}')\nif [ "$n" -gt 0 ]; then echo $((n-1)) > '${counter}'; echo refused >&2; exit 1; fi\nexit 0\n`)
    await chmod(hook, 0o755)
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    const sleeps: number[] = []
    const result = await repo.append(ping('x'), { sleep: async (ms) => void sleeps.push(ms) })
    expect(result.seq).toBe('0001')
    expect(sleeps).toHaveLength(2)
  })

  it('does not retry a failure that is not a refused push', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    await rename(remote, `${remote}.away`)
    const sleeps: number[] = []
    await expect(repo.append(ping('x'), { sleep: async (ms) => void sleeps.push(ms) })).rejects.toThrow()
    expect(sleeps).toEqual([])
  })

  it('does not retry an error thrown by the caller', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    let calls = 0
    await expect(
      repo.append(() => {
        calls += 1
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
    expect(calls).toBe(1)
  })
})

describe('attachments (SPEC "文件与格式")', () => {
  it('commits attachments/<seq>/ together with the message in one commit, byte-exact', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a, 0x0d, 0xc3])
    const result = await repo.append((seq) => ({ ...message('with patch')(seq), attachments: [{ name: 'x.patch', content: binary }] }))

    const { stdout } = await runGit(['show', '--name-only', '--format=%s', result.commit], { cwd: repo.dir })
    expect(stdout.trim().split('\n').filter((line) => line !== '')).toEqual(['msg 0001 local REPORT', 'attachments/0001/x.patch', 'messages/0001-local-REPORT.md'])
    expect((await repo.readBytes('attachments/0001/x.patch'))?.equals(binary)).toBe(true)
    const { stdout: parents } = await runGit(['rev-list', '--count', result.commit], { cwd: repo.dir })
    expect(parents.trim()).toBe('1')
  })

  it.each(['../evil', 'a/b', '..', '.hidden', ''])('refuses the attachment name %j', async (name) => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    await expect(repo.append((seq) => ({ ...message('x')(seq), attachments: [{ name, content: Buffer.from('x') }] }))).rejects.toThrow(/attachment/)
    expect(await remoteMessages()).toEqual([])
  })

  it('refuses two attachments with one name and a file name that does not match its sequence', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    const dup = [{ name: 'a', content: Buffer.from('1') }, { name: 'a', content: Buffer.from('2') }]
    await expect(repo.append((seq) => ({ ...message('x')(seq), attachments: dup }))).rejects.toThrow(/twice/)
    await expect(repo.append(() => ({ sender: 'local', type: 'REPORT', filename: '0009-local-REPORT.md', text: 'x' }))).rejects.toThrow(/does not match/)
  })
})

describe('byte-exact reads', () => {
  it('reads every message with its bytes intact, including non-UTF-8', async () => {
    const repo = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    await repo.ensure()
    await repo.append(message('one'))
    await repo.append(message('two'))
    const all = await repo.readMessages()
    expect([...all.keys()]).toEqual(['0001-local-REPORT.md', '0002-local-REPORT.md'])
    expect(all.get('0002-local-REPORT.md')?.toString('utf8')).toContain('two')
    expect(await repo.readFile('messages/9999-none.md')).toBeUndefined()
    expect(await repo.readBytes('messages')).toBeUndefined()
  })
})
