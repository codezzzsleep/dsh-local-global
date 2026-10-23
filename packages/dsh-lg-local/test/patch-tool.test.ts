import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatMessage, parseMessage, type MessageType, type Sender } from '@local-global/lg-protocol'

import { apply } from '../src/patch.js'
import { apply as applyProtect } from '../src/protect.js'
import { agentIn, fakeCtx, git, repo, tmp } from './fake-ctx.js'

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** A repo at `base` plus a PATCH message (and attachment) that adds a line to a.txt. */
function world(over: { sender?: Sender; fields?: Record<string, unknown>; type?: MessageType; tamper?: (data: Buffer) => Buffer } = {}) {
  const dir = repo({ 'a.txt': 'one\n' })
  const base = git(dir, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', 'add two')
  const patch = Buffer.from(git(dir, 'format-patch', '--stdout', '-1'), 'utf8')
  git(dir, 'reset', '--hard', base)

  const fields = { name: '0001-add-two.patch', claim: '0003', base, format: 'git-format-patch', bytes: patch.length, sha256: sha(patch), ...over.fields }
  const rendered = formatMessage({ seq: '0004', sender: over.sender ?? 'global', type: over.type ?? 'PATCH', fields })
  const parsed = parseMessage(rendered.filename, rendered.text)
  if (!parsed.ok) throw new Error('fixture does not parse')
  const read: string[] = []
  const channel = {
    all: async () => [parsed.message],
    readAttachment: async (path: string) => {
      read.push(path)
      return over.tamper === undefined ? patch : over.tamper(patch)
    },
  }
  const fake = fakeCtx({ lgChannel: channel })
  apply(fake.ctx)
  const run = (args: Record<string, unknown>) => fake.tool('lg_apply_patch').execute(args, { agent: agentIn(dir) }) as Promise<{ verdict: string; detail: string; commit?: string }>
  return { dir, base, fake, run, read }
}

describe('lg_apply_patch tool wrapper', () => {
  it('fetches the attachment of a global PATCH by sequence and applies it in the session directory', async () => {
    const { dir, base, run, read } = world()
    const result = await run({ seq: '0004' })
    expect(result.verdict).toBe('APPLIED')
    expect(result.commit).toBe(git(dir, 'rev-parse', 'HEAD').trim())
    expect(result.commit).not.toBe(base)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(read).toEqual(['attachments/0004/0001-add-two.patch'])
  })

  it('answers DUPLICATE the second time', async () => {
    const { run } = world()
    await run({ seq: '0004' })
    expect((await run({ seq: '0004' })).verdict).toBe('DUPLICATE')
  })

  it('rejects a PATCH that did not come from global, without touching the worktree', async () => {
    const { dir, base, run, read } = world({ sender: 'local' })
    const result = await run({ seq: '0004' })
    expect(result.verdict).toBe('REJECTED')
    expect(result.detail).toContain('only global')
    expect(read).toEqual([])
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(base)
  })

  it('rejects a message that fails protocol validation', async () => {
    const { run, read } = world({ fields: { format: 'diff' } })
    const result = await run({ seq: '0004' })
    expect(result.verdict).toBe('REJECTED')
    expect(result.detail).toMatch(/not a valid message.*git-format-patch/)
    expect(read).toEqual([])
  })

  it('rejects a name that is not a plain file name before it is joined into any path', async () => {
    const { run, read } = world({ fields: { name: '../../outside.patch' } })
    const result = await run({ seq: '0004' })
    expect(result.verdict).toBe('REJECTED')
    expect(read).toEqual([])
  })

  it('verifies size and sha256 against the attachment it fetched', async () => {
    const { dir, base, run } = world({ tamper: (data) => Buffer.concat([data, Buffer.from('\n')]) })
    const result = await run({ seq: '0004' })
    expect(result.verdict).toBe('REJECTED')
    expect(result.detail).toMatch(/bytes/)
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(base)
  })

  it('rejects a missing attachment', async () => {
    const dir = repo()
    const channel = world().fake.services.get('lgChannel') as { all: () => Promise<unknown[]> }
    const fake = fakeCtx({ lgChannel: { all: channel.all, readAttachment: async () => undefined } })
    apply(fake.ctx)
    const result = (await fake.tool('lg_apply_patch').execute({ seq: '0004' }, { agent: agentIn(dir) })) as { verdict: string }
    expect(result.verdict).toBe('REJECTED')
  })

  it('refuses a bad sequence, an unknown PATCH, and a missing channel with explicit errors', async () => {
    const { fake, run } = world()
    await expect(run({ seq: '../4' })).rejects.toThrow(/four-digit/)
    await expect(run({ seq: '0009' })).rejects.toThrow(/no PATCH message at #0009/)
    const bare = fakeCtx()
    apply(bare.ctx)
    await expect(bare.tool('lg_apply_patch').execute({ seq: '0004' }, { agent: agentIn(tmp('x')) })).rejects.toThrow(/lg-channel is not composed/)
    expect(fake.tool('lg_apply_patch').name).toBe('lg_apply_patch')
  })

  it('applies into an explicit cwd resolved against the session directory, and refuses a protected one', async () => {
    const { dir, run, fake } = world()
    applyProtect(fake.ctx, { protectedPaths: [join(dir, '..', 'protected-elsewhere')] })
    expect((await run({ seq: '0004', cwd: '.' })).verdict).toBe('APPLIED')

    const other = world()
    applyProtect(other.fake.ctx, { protectedPaths: [other.dir] })
    await expect(other.run({ seq: '0004', cwd: other.dir })).rejects.toThrow(/protected path/)
    expect(git(other.dir, 'rev-parse', 'HEAD').trim()).toBe(other.base)
  })

  it('also refuses a protected cwd when lg-protect is not composed (default protected set)', async () => {
    const { run } = world()
    await expect(run({ seq: '0004', cwd: '~/.lg-global/workspace' })).rejects.toThrow(/protected path/)
  })
})
