import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChannelRepo, runGit } from '../src/git.js'

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
  const { stdout } = await runGit(['ls-tree', '--name-only', 'main', 'messages/'], { cwd: remote })
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

  it('retries with a fresh sequence after a rejected push', async () => {
    const first = new ChannelRepo(join(workspace, 'a.git'), remote, 'main')
    const second = new ChannelRepo(join(workspace, 'b.git'), remote, 'main')
    await Promise.all([first.ensure(), second.ensure()])

    // Prepare a stale local view: second fetches nothing, then first lands 0001.
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
