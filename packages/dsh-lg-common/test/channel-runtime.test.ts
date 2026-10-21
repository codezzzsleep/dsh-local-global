import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMessage, validateMessage } from '@local-global/lg-protocol'
import { ChannelRuntime } from '../src/channel.js'
import { resolveChannelConfig } from '../src/config.js'
import { runGit } from '../src/git.js'

let workspace: string
let remote: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'lg-runtime-test-'))
  remote = join(workspace, 'channel.git')
  await runGit(['init', '--bare', '--initial-branch', 'main', remote])
  await runGit(['config', 'protocol.file.allow', 'always'], { cwd: remote })
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

/**
 * The runtime only touches `ctx.agents.get` from the live channel path; the
 * archive path under test never resolves an agent, so a minimal stub keeps the
 * test free of a full harness composition.
 */
function stubContext(): Context {
  return { agents: { get: () => undefined } } as unknown as Context
}

async function runtime(): Promise<ChannelRuntime> {
  const config = resolveChannelConfig({
    repo: `file://${remote}`,
    role: 'local',
    pollSeconds: 10,
    relay: true,
    cloneDir: join(workspace, 'mirror.git'),
    stateDir: join(workspace, 'state'),
  })
  const channel = new ChannelRuntime(stubContext(), config)
  await channel.start()
  return channel
}

describe('ChannelRuntime.recordRelayed', () => {
  it('archives a message whose fields it cannot validate, and lets readers mark it INVALID', async () => {
    const channel = await runtime()
    // Sequences at or below 0002 are exempt from field validation, so seed two
    // messages first to make the relayed one land at 0003.
    await channel.post({ type: 'CLAIM', fields: { scope: [], implementer: 'local' } })
    await channel.postAs('human', { type: 'HALT', fields: { reason: 'seed' } })

    // A REVIEW without `verdict`: this side does not know the type well enough
    // to validate it, but §8 still requires archiving it byte-for-byte.
    const text = "[LG REVIEW from global]\nrefs: ['0011']\nfindings: []\n---\nno verdict yet\n"
    const result = await channel.recordRelayed(text)
    expect(result.filename).toBe('0003-global-REVIEW.md')

    const stored = await channel.repo.readFile('messages/0003-global-REVIEW.md')
    expect(stored).toBe(text)

    const parsed = parseMessage('0003-global-REVIEW.md', stored ?? '')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected parse success')
    // The reader is what rejects it, not the writer.
    expect(validateMessage(parsed.message).some((error) => error.code === 'missing-field')).toBe(true)
  })

  it('refuses relayed text that this side wrote itself', async () => {
    const channel = await runtime()
    await expect(channel.recordRelayed('[LG CLAIM from local]\nscope: []\nimplementer: local\n---\n')).rejects.toThrow(/global or human/)
  })

  it('refuses relayed text with an unusable first line', async () => {
    const channel = await runtime()
    await expect(channel.recordRelayed('hello there\n')).rejects.toThrow(/must start with/)
  })
})

describe('commit identity', () => {
  it('uses the machine git identity, not the message sender', async () => {
    const channel = await runtime()
    await runGit(['config', 'user.name', 'Machine User'], { cwd: channel.repo.dir })
    await runGit(['config', 'user.email', 'machine@example.com'], { cwd: channel.repo.dir })
    const posted = await channel.post({ type: 'CLAIM', fields: { scope: ['x'], implementer: 'local' } })

    const { stdout } = await runGit(['log', '-1', posted.commit, '--format=%an|%ae|%cn'], { cwd: channel.repo.dir })
    expect(stdout.trim()).toBe('Machine User|machine@example.com|Machine User')
  })
})

describe('bind', () => {
  it('starts the cursor at the newest message so history never enters the session', async () => {
    const channel = await runtime()
    await channel.post({ type: 'CLAIM', fields: { scope: [], implementer: 'local' } })
    await channel.postAs('human', { type: 'HALT', fields: { reason: 'seed' } })

    expect(channel.cursor).toBe('0000')
    await channel.bind('session-1')
    expect(channel.boundSessionId).toBe('session-1')
    expect(channel.cursor).toBe('0002')
  })

  it('keeps the cursor when another session rebinds', async () => {
    const channel = await runtime()
    await channel.post({ type: 'CLAIM', fields: { scope: [], implementer: 'local' } })
    await channel.bind('session-1')
    await channel.post({ type: 'CLAIM', fields: { scope: [], implementer: 'local' } })
    // The later message arrived while bound, so a rebind must not skip it.
    await channel.bind('session-2')
    expect(channel.cursor).toBe('0001')
  })
})

describe('sent copies (CH-12 / IN-3)', () => {
  it('saves a byte-exact copy of every message this side writes', async () => {
    const channel = await runtime()
    const posted = await channel.post({ type: 'CLAIM', fields: { scope: ['x'], implementer: 'local' } })
    const archived = await channel.repo.readFile(`messages/${posted.filename}`)
    const copy = await channel.sentCopyOf(posted.filename)
    expect(copy).toBe(archived)
    expect(await channel.verifySentCopies()).toEqual([])
  })

  it('reports a mismatch when the archived message is tampered with', async () => {
    const channel = await runtime()
    const posted = await channel.post({ type: 'CLAIM', fields: { scope: ['x'], implementer: 'local' } })

    // Rewrite the archived file in a fresh clone and push it: this is the
    // tamper IN-3 must catch.
    const work = join(workspace, 'tamper')
    await runGit(['clone', '-q', remote, work])
    await runGit(['config', 'user.name', 'tamper'], { cwd: work })
    await runGit(['config', 'user.email', 'tamper@invalid'], { cwd: work })
    await appendFile(join(work, 'messages', posted.filename), '\n本行是篡改\n')
    await runGit(['add', '-A'], { cwd: work })
    await runGit(['commit', '-q', '-m', 'tamper'], { cwd: work })
    await runGit(['push', '-q', 'origin', 'HEAD:main'], { cwd: work })

    await channel.repo.fetch()
    const mismatches = await channel.verifySentCopies()
    expect(mismatches.map((entry) => entry.filename)).toEqual([posted.filename])
    expect(mismatches[0]?.reason).toContain('differ')
  })

  it('reports nothing for a message this side never wrote', async () => {
    const channel = await runtime()
    const work = join(workspace, 'other')
    await runGit(['clone', '-q', remote, work])
    await runGit(['config', 'user.name', 'other'], { cwd: work })
    await runGit(['config', 'user.email', 'other@invalid'], { cwd: work })
    await mkdir(join(work, 'messages'), { recursive: true })
    await writeFile(join(work, 'messages', '0001-global-CLAIM.md'), "[LG CLAIM from global]\nscope: ['y']\nimplementer: global\n---\n")
    await runGit(['add', '-A'], { cwd: work })
    await runGit(['commit', '-q', '-m', 'msg 0001 global CLAIM'], { cwd: work })
    await runGit(['push', '-q', 'origin', 'HEAD:main'], { cwd: work })

    await channel.repo.fetch()
    expect(await channel.verifySentCopies()).toEqual([])
    expect(await channel.uncopiedOwnMessages()).toEqual([])
  })
})

describe('wakesGlobal (CH-4)', () => {
  it('wakes only on the wake-class messages', async () => {
    const { parseMessage } = await import('@local-global/lg-protocol')
    const { wakesGlobal } = await import('../src/channel.js')
    const build = (name: string, text: string) => {
      const parsed = parseMessage(name, text)
      if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join('; '))
      return parsed.message
    }
    const checkpoint = build('0026-local-REPORT.md', "[LG REPORT from local]\nrefs: ['0025']\ncommit: 0000000000000000000000000000000000000000\ndirective_version: 3\nevidence: []\nnegative_tests: []\ncheckpoint: true\n---\n")
    const plain = build('0027-local-REPORT.md', "[LG REPORT from local]\nrefs: ['0025']\ncommit: 0000000000000000000000000000000000000000\ndirective_version: 3\nevidence: []\nnegative_tests: []\ncheckpoint: false\n---\n")
    const blocking = build('0028-local-QUESTION.md', "[LG QUESTION from local]\noptions: ['a']\nblocking: true\ndefault_action: continue\n---\n")
    const notBlocking = build('0029-local-QUESTION.md', "[LG QUESTION from local]\noptions: ['a']\nblocking: false\ndefault_action: continue\n---\n")
    expect(wakesGlobal(checkpoint)).toBe(true)
    expect(wakesGlobal(plain)).toBe(false)
    expect(wakesGlobal(blocking)).toBe(true)
    expect(wakesGlobal(notBlocking)).toBe(false)
  })
})

describe('EV-4: a REPORT citing stale evidence is refused', () => {
  /** A runtime whose context offers an `lgEvidence` service with fixed topics. */
  async function runtimeWithEvidence(staleTopics: string[]): Promise<ChannelRuntime> {
    const ctx = {
      agents: { get: () => undefined },
      get: (name: string) => (name === 'lgEvidence' ? { staleTopics: () => staleTopics } : undefined),
    } as unknown as Context
    const config = resolveChannelConfig({
      repo: `file://${remote}`,
      role: 'local',
      pollSeconds: 10,
      relay: true,
      cloneDir: join(workspace, 'mirror.git'),
      stateDir: join(workspace, 'state'),
    })
    const channel = new ChannelRuntime(ctx, config)
    await channel.start()
    return channel
  }

  const report = (evidence: string[]): Parameters<ChannelRuntime['post']>[0] => ({
    type: 'REPORT',
    fields: {
      refs: ['0001'],
      commit: '0000000000000000000000000000000000000000',
      directive_version: 1,
      evidence,
      negative_tests: [],
      checkpoint: true,
    },
  })

  it('rejects a citation of a manifest whose digest moved', async () => {
    const channel = await runtimeWithEvidence(['M3/ev-real'])
    await expect(channel.post(report(['evidence/M3/ev-real/manifest.json']))).rejects.toThrow(/stale evidence: M3\/ev-real/)
  })

  it('accepts a citation when nothing is stale, and when no evidence plugin is composed', async () => {
    const fresh = await runtimeWithEvidence([])
    await expect(fresh.post(report(['evidence/M3/ev-real/manifest.json']))).resolves.toBeTruthy()
    // No service at all: the archive path is unchanged.
    const plain = await runtime()
    await expect(plain.post(report(['evidence/M3/ev-real/manifest.json']))).resolves.toBeTruthy()
  })
})
