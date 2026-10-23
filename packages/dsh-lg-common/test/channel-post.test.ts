import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseMessage } from '@local-global/lg-protocol'
import { ChannelError, apply } from '../src/channel.js'
import { resolveChannelConfig } from '../src/config.js'
import { runGit } from '../src/git.js'
import { COMMIT, Rig, VALID } from './helpers.js'

vi.setConfig({ testTimeout: 60_000 })

const rig = new Rig()
beforeEach(async () => {
  await rig.open()
})
afterEach(async () => {
  await rig.close()
})

const rejection = async (promise: Promise<unknown>): Promise<ChannelError> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(ChannelError)
  return error as ChannelError
}

describe('lg_post generates and checks ids (CH-7)', () => {
  it('numbers each sender from 0001 and returns the id', async () => {
    const local = await rig.side('local')
    const first = await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    const second = await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    expect([first.id, second.id]).toEqual(['L-0001', 'L-0002'])
    const archived = parseMessage(first.filename, (await local.repo.readFile(`messages/${first.filename}`)) ?? '')
    expect(archived.ok && archived.message.fields['id']).toBe('L-0001')

    const global = await rig.side('global')
    expect((await global.post({ type: 'CLAIM', fields: VALID.CLAIM() })).id).toBe('G-0001')
    expect((await global.post({ type: 'CLAIM', fields: VALID.CLAIM() })).id).toBe('G-0002')
    expect((await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })).id).toBe('L-0003')
    // The human's counter is its own.
    expect((await local.postAs('human', { type: 'HALT', fields: VALID.HALT() })).id).toBe('H-0001')
  })

  it('gives concurrent posts from one side distinct ids and sequences', async () => {
    const local = await rig.side('local')
    const results = await Promise.all([1, 2, 3, 4].map(async () => await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })))
    expect(results.map((result) => result.id).sort()).toEqual(['L-0001', 'L-0002', 'L-0003', 'L-0004'])
    expect(results.map((result) => result.seq).sort()).toEqual(['0001', '0002', '0003', '0004'])
  })

  it('accepts a given id that is well-formed, unused and next', async () => {
    const local = await rig.side('local')
    expect((await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local', id: 'L-0007' }) })).id).toBe('L-0007')
    expect((await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })).id).toBe('L-0008')
  })

  it('refuses a given id that is malformed, foreign, reused or going backwards', async () => {
    const local = await rig.side('local')
    await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    const post = async (id: string) => await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local', id }) })
    expect((await rejection(post('L-1'))).code).toBe('invalid-message')
    expect((await rejection(post('G-0009'))).code).toBe('invalid-message')
    expect((await rejection(post('L-0002'))).code).toBe('duplicate-id')
    expect((await rejection(post('L-0001'))).code).toBe('duplicate-id')
    // Unused but below the sender's highest: ids only go up.
    const lower = rig.side('local', { name: 'other' })
    await (await lower).post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local', id: 'L-0050' }) })
    expect((await rejection(post('L-0040'))).code).toBe('id-not-increasing')
  })
})

describe('supersedes and CORRECTION are only for your own messages (PR-6)', () => {
  it('lets a sender supersede its own earlier message', async () => {
    const local = await rig.side('local')
    const first = await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    const second = await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local', supersedes: [first.id] }) })
    expect(second.seq).toBe('0002')
  })

  it('refuses to supersede another sender’s message, an unknown id, itself, or a HALT', async () => {
    const local = await rig.side('local')
    const global = await rig.side('global')
    const theirs = await global.post({ type: 'CLAIM', fields: VALID.CLAIM() })
    await local.postAs('human', { type: 'HALT', fields: VALID.HALT() })
    const supersede = async (target: string, extra: Record<string, unknown> = {}) =>
      await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local', supersedes: [target], ...extra }) })

    expect((await rejection(supersede(theirs.id))).code).toBe('foreign-supersedes')
    expect((await rejection(supersede('L-0099'))).code).toBe('unknown-supersedes')
    expect((await rejection(supersede('L-0003', { id: 'L-0003' }))).code).toBe('self-supersedes')
    expect((await rejection(supersede('H-0001'))).code).toBe('foreign-supersedes')
    // Nothing was written by any of the refused posts.
    expect((await local.repo.listMessages()).length).toBe(2)
  })

  it('refuses a human superseding its own HALT', async () => {
    const local = await rig.side('local')
    const halt = await local.postAs('human', { type: 'HALT', fields: VALID.HALT() })
    const error = await rejection(local.postAs('human', { type: 'HALT', fields: VALID.HALT({ supersedes: [halt.id] }) }))
    expect(error.code).toBe('halt-supersedes')
  })

  it('refuses a CORRECTION of another sender’s message, and of nothing', async () => {
    const local = await rig.side('local')
    const global = await rig.side('global')
    const theirs = await global.post({ type: 'CLAIM', fields: VALID.CLAIM() })
    const mine = await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    const correct = async (seq: string) => await local.post({ type: 'CORRECTION', fields: { corrects: seq, replacement: 'x' } })

    expect((await rejection(correct(theirs.seq))).code).toBe('foreign-corrects')
    expect((await rejection(correct('0099'))).code).toBe('unknown-corrects')
    expect((await correct(mine.seq)).seq).toBe('0003')
  })

  it('refuses to write as the other agent', async () => {
    const local = await rig.side('local')
    expect((await rejection(local.postAs('global', { type: 'CLAIM', fields: VALID.CLAIM() }))).code).toBe('sender-not-allowed')
  })
})

describe('attachments (SPEC lg_post)', () => {
  const patchFields = (content: Buffer, extra: Record<string, unknown> = {}) => ({
    name: 'docs.patch',
    claim: '0001',
    base: COMMIT,
    format: 'git-format-patch',
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    ...extra,
  })

  it('commits a PATCH with its attachment in one commit and reads it back byte-exact', async () => {
    const global = await rig.side('global')
    const content = Buffer.from([0x66, 0x72, 0x6f, 0x6d, 0xff, 0x00, 0xfe, 0x0a])
    const posted = await global.post({ type: 'PATCH', fields: patchFields(content), attachments: [{ name: 'docs.patch', content }] })

    const { stdout } = await runGit(['show', '--name-only', '--format=', posted.commit], { cwd: global.repo.dir })
    expect(stdout.trim().split('\n').sort()).toEqual(['attachments/0001/docs.patch', 'messages/0001-global-PATCH.md'])
    expect((await global.readAttachment('attachments/0001/docs.patch'))?.equals(content)).toBe(true)
    expect(await global.readAttachment('attachments/0001/other.patch')).toBeUndefined()
  })

  it('accepts base64 content for a text-only caller', async () => {
    const global = await rig.side('global')
    const content = Buffer.from([0xff, 0xfe, 0x01])
    await global.post({
      type: 'PATCH',
      fields: patchFields(content),
      attachments: [{ name: 'docs.patch', content: content.toString('base64'), encoding: 'base64' }],
    })
    expect((await global.readAttachment('attachments/0001/docs.patch'))?.equals(content)).toBe(true)
  })

  it('refuses a PATCH without its attachment, or with one that does not match bytes and sha256', async () => {
    const global = await rig.side('global')
    const content = Buffer.from('real patch')
    expect((await rejection(global.post({ type: 'PATCH', fields: patchFields(content) }))).code).toBe('patch-attachment')
    const wrongHash = patchFields(content, { sha256: 'f'.repeat(64) })
    expect((await rejection(global.post({ type: 'PATCH', fields: wrongHash, attachments: [{ name: 'docs.patch', content }] }))).code).toBe('patch-attachment')
    const wrongSize = patchFields(content, { bytes: 3 })
    expect((await rejection(global.post({ type: 'PATCH', fields: wrongSize, attachments: [{ name: 'docs.patch', content }] }))).code).toBe('patch-attachment')
    expect(await global.repo.listMessages()).toEqual([])
  })

  it.each(['../../messages/0001-global-HALT.md', 'a/b', '..', '.git', ''])('refuses the attachment name %j', async (name) => {
    const local = await rig.side('local')
    const error = await rejection(local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }), attachments: [{ name, content: 'x' }] }))
    expect(error.code).toBe('invalid-attachment')
    expect(await local.repo.listMessages()).toEqual([])
  })

  it('refuses a PATCH whose own name field is a path', async () => {
    const global = await rig.side('global')
    const content = Buffer.from('x')
    const error = await rejection(global.post({ type: 'PATCH', fields: patchFields(content, { name: '../x.patch' }), attachments: [{ name: 'x.patch', content }] }))
    expect(error.code).toBe('invalid-message')
  })

  it('refuses to read outside attachments/', async () => {
    const global = await rig.side('global')
    await global.post({ type: 'CLAIM', fields: VALID.CLAIM() })
    for (const path of ['messages/0001-global-CLAIM.md', 'attachments/../messages/0001-global-CLAIM.md', 'attachments/0001/../../x', 'attachments//x']) {
      expect((await rejection(global.readAttachment(path))).code).toBe('invalid-path')
    }
  })
})

describe('an unreachable remote is not an empty channel (CH-2)', () => {
  it('fails the first bind and leaves the cursor alone, then binds at the newest message once it is back', async () => {
    const local = await rig.side('local')
    const global = await rig.side('global')
    await global.post({ type: 'CLAIM', fields: VALID.CLAIM() })
    await global.post({ type: 'CLAIM', fields: VALID.CLAIM() })

    await rename(rig.remote, `${rig.remote}.away`)
    await expect(local.bind('s1')).rejects.toThrow()
    expect(local.boundSessionId).toBeNull()
    expect(local.cursor).toBe('0000')

    await rename(`${rig.remote}.away`, rig.remote)
    await local.bind('s1')
    expect(local.cursor).toBe('0002')
  })

  it('counts a newest message that does not parse as history', async () => {
    const local = await rig.side('local')
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0001' }))
    await rig.write('global', 'CLAIM', '\u0000 header is gone')
    await local.bind('s1')
    expect(local.cursor).toBe('0002')
  })

  it('refuses to start against a remote that does not exist', async () => {
    const config = resolveChannelConfig({ repo: `file://${rig.workspace}/missing.git`, role: 'local', cloneDir: join(rig.workspace, 'm.git'), stateDir: join(rig.workspace, 's') })
    const { ChannelRuntime } = await import('../src/channel.js')
    await expect(new ChannelRuntime(rig.context(), config).start()).rejects.toThrow()
  })
})

describe('credentials stay out of what a user sees (REVIEW /lg-status)', () => {
  const secretUrl = 'https://alice:s3cr3t-token@channel.example/org/chan.git'

  async function sideBehindUrl() {
    // The mirror rewrites the credentialed URL onto the local remote, so the
    // runtime really fetches and posts while its configured repo carries a secret.
    const mirror = join(rig.workspace, 'secret-mirror.git')
    await runGit(['init', '--bare', '--initial-branch', 'main', mirror])
    await runGit(['config', `url.file://${rig.remote}.insteadOf`, secretUrl], { cwd: mirror })
    return await rig.side('local', { name: 'secret', repo: secretUrl })
  }

  it('redacts the repo in /lg-status', async () => {
    const mirrorDir = join(rig.workspace, 'secret-mirror.git')
    await mkdir(mirrorDir, { recursive: true })
    await runGit(['init', '--bare', '--initial-branch', 'main', mirrorDir])
    await runGit(['config', `url.file://${rig.remote}.insteadOf`, secretUrl], { cwd: mirrorDir })
    const config = resolveChannelConfig({ repo: secretUrl, role: 'local', cloneDir: mirrorDir, stateDir: join(rig.workspace, 'secret-state') })
    const { ChannelRuntime } = await import('../src/channel.js')
    const channel = new ChannelRuntime(rig.context(), config)
    await channel.start()
    await channel.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    await channel.bind('s1')

    const status = await channel.statusText()
    expect(status).toContain('repo: https://***@channel.example/org/chan.git#main')
    expect(status).not.toContain('s3cr3t')
    expect(status).not.toContain('alice')

    // Nor does the state file on disk keep the secret.
    const stateDir = join(rig.workspace, 'secret-state')
    for (const name of await readdir(stateDir)) {
      if (name.endsWith('.json')) expect(await readFile(join(stateDir, name), 'utf8')).not.toContain('s3cr3t')
    }
  })

  it('redacts the repo in an error from an unreachable remote', async () => {
    const config = resolveChannelConfig({
      repo: 'https://alice:s3cr3t-token@127.0.0.1:1/org/chan.git',
      role: 'local',
      cloneDir: join(rig.workspace, 'x.git'),
      stateDir: join(rig.workspace, 'x-state'),
    })
    const { ChannelRuntime } = await import('../src/channel.js')
    const failure = await new ChannelRuntime(rig.context(), config).start().then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(failure).not.toBe('')
    expect(failure).not.toContain('s3cr3t')
    expect(failure).not.toContain('alice:')
  })

  it('keeps the credential out of the default directory names', async () => {
    const config = resolveChannelConfig({ repo: 'https://alice:s3cr3t-token@channel.example', role: 'local' }, join(rig.workspace, 'home'))
    expect(`${config.cloneDir} ${config.stateDir} ${config.slug}`).not.toMatch(/s3cr3t|alice/u)
  })

  void sideBehindUrl
})

describe('sent copies (CH-12): deleted and corrupted archive files', () => {
  async function tamper(change: (work: string) => Promise<void>): Promise<void> {
    const work = join(rig.workspace, 'tamper')
    await rm(work, { recursive: true, force: true })
    await runGit(['clone', '-q', rig.remote, work])
    await runGit(['config', 'user.name', 'tamper'], { cwd: work })
    await runGit(['config', 'user.email', 'tamper@invalid'], { cwd: work })
    await change(work)
    await runGit(['add', '-A'], { cwd: work })
    await runGit(['commit', '-q', '-m', 'tamper'], { cwd: work })
    await runGit(['push', '-q', 'origin', 'HEAD:main'], { cwd: work })
  }

  it('reports an archived message that was deleted', async () => {
    const local = await rig.side('local')
    const posted = await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    await tamper(async (work) => await rm(join(work, 'messages', posted.filename)))
    await local.repo.fetch()

    const mismatches = await local.verifySentCopies()
    expect(mismatches.map((entry) => entry.filename)).toEqual([posted.filename])
    expect(mismatches[0]?.reason).toContain('missing')
  })

  it('reports an archived message whose header was corrupted', async () => {
    const local = await rig.side('local')
    const posted = await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    await tamper(async (work) => {
      const path = join(work, 'messages', posted.filename)
      const text = await readFile(path, 'utf8')
      await writeFile(path, text.replace('[LG CLAIM from local]', '[LG CLAIM from locl]'))
    })
    await local.repo.fetch()

    const mismatches = await local.verifySentCopies()
    expect(mismatches.map((entry) => entry.filename)).toEqual([posted.filename])
    expect(mismatches[0]?.reason).toContain('differ')
  })

  it('reports a message replaced by one of another type under the same sequence', async () => {
    const local = await rig.side('local')
    const posted = await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    await tamper(async (work) => {
      await rm(join(work, 'messages', posted.filename))
      await writeFile(join(work, 'messages', '0001-global-HALT.md'), '[LG HALT from global]\nreason: x\n---\n')
    })
    await local.repo.fetch()
    expect((await local.verifySentCopies()).map((entry) => entry.filename)).toEqual([posted.filename])
  })

  it('retries a failed report and then reports each tampered file once, across a restart', async () => {
    const local = await rig.side('local', { name: 'loc' })
    const posted = await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    await tamper(async (work) => await writeFile(join(work, 'messages', posted.filename), '[LG CLAIM from local]\nscope: [evil]\n---\n'))

    const isolationReports = async (): Promise<number> => {
      await local.repo.fetch()
      return (await local.repo.listMessages()).filter((name) => name.endsWith('-ISOLATION_REPORT.md')).length
    }

    // The first report fails: it must not count as reported.
    vi.spyOn(local, 'post').mockRejectedValueOnce(new Error('push failed'))
    await local.poll()
    expect(await isolationReports()).toBe(0)

    await local.poll()
    expect(await isolationReports()).toBe(1)
    await local.poll()
    expect(await isolationReports()).toBe(1)

    // A restart keeps the memory of what was reported.
    const restarted = await rig.side('local', { name: 'loc' })
    await restarted.poll()
    await restarted.repo.fetch()
    expect((await restarted.repo.listMessages()).filter((name) => name.endsWith('-ISOLATION_REPORT.md'))).toHaveLength(1)
  })
})

describe('recordRelayed (CH-8)', () => {
  const relayed = `[LG CLAIM from global]\nid: G-0001\nscope: [x]\nimplementer: global\n---\nbody  \n`

  it('archives byte-for-byte and reads the archive back', async () => {
    const local = await rig.side('local')
    const result = await local.recordRelayed(relayed)
    expect(result).toMatchObject({ seq: '0001', filename: '0001-global-CLAIM.md', id: 'G-0001', duplicate: false })
    const stored = await local.repo.readBytes('messages/0001-global-CLAIM.md')
    expect(createHash('sha256').update(stored ?? '').digest('hex')).toBe(createHash('sha256').update(relayed, 'utf8').digest('hex'))
  })

  it('does not archive the same id twice, and returns the existing sequence', async () => {
    const local = await rig.side('local')
    const first = await local.recordRelayed(relayed)
    const again = await local.recordRelayed(relayed)
    expect(again).toMatchObject({ seq: first.seq, filename: first.filename, commit: first.commit, duplicate: true, identical: true })
    expect(await local.repo.listMessages()).toEqual(['0001-global-CLAIM.md'])

    const other = await rig.side('local')
    const third = await other.recordRelayed(relayed)
    expect(third.duplicate).toBe(true)
    expect(await other.repo.listMessages()).toEqual(['0001-global-CLAIM.md'])
  })

  it('says when the pasted text differs from what is already archived under that id', async () => {
    const local = await rig.side('local')
    await local.recordRelayed(relayed)
    const changed = await local.recordRelayed(relayed.replace('body', 'edited'))
    expect(changed).toMatchObject({ duplicate: true, identical: false })
    expect(await local.repo.listMessages()).toHaveLength(1)
  })

  it('only needs a readable first line: invalid YAML is archived, not rejected', async () => {
    const local = await rig.side('local')
    const broken = '[LG REVIEW from global]\nid: G-0002\nrefs: [unclosed\n---\nbody\n'
    const result = await local.recordRelayed(broken)
    expect(result.duplicate).toBe(false)
    expect(result.id).toBe('G-0002')
    expect(await local.repo.readFile(`messages/${result.filename}`)).toBe(broken)
    // The id is still found, so the broken message is deduplicated too.
    expect((await local.recordRelayed(broken)).duplicate).toBe(true)
  })

  it('fails when the archive reads back different from what was sent', async () => {
    const local = await rig.side('local')
    const real = local.repo.readBytes.bind(local.repo)
    vi.spyOn(local.repo, 'readBytes').mockImplementation(async (path, rev) => {
      const bytes = await real(path, rev)
      return path.startsWith('messages/') && bytes !== undefined ? Buffer.concat([bytes, Buffer.from('x')]) : bytes
    })
    expect((await rejection(local.recordRelayed(relayed))).code).toBe('readback-mismatch')
  })

  it('is refused when relay mode is off', async () => {
    const local = await rig.side('local', { relay: false })
    expect((await rejection(local.recordRelayed(relayed))).code).toBe('relay-disabled')
  })
})

describe('tool registration', () => {
  function registered(raw: unknown): string[] {
    const names: string[] = []
    const ctx = { tools: { register: (definition: { name: string }) => void names.push(definition.name) }, effect: () => undefined, agents: { get: () => undefined } }
    apply(ctx as never, raw as never)
    return names
  }

  it('offers lg_record_relayed only in relay mode', () => {
    const base = { repo: `file://${'/x'}.git`, role: 'local', cloneDir: '/tmp/never-used.git', stateDir: '/tmp/never-used-state' }
    expect(registered({ ...base, relay: false })).toEqual(['lg_post', 'lg_read', 'lg_open_questions'])
    expect(registered({ ...base, relay: true })).toEqual(['lg_post', 'lg_record_relayed', 'lg_read', 'lg_open_questions'])
    expect(registered(base)).not.toContain('lg_record_relayed')
  })

  it('rejects a missing configuration with a clear message (CH-1)', () => {
    expect(() => registered(undefined)).toThrow(/configuration is missing.*"repo".*"role"/u)
    expect(() => resolveChannelConfig(undefined)).toThrow(TypeError)
    expect(() => resolveChannelConfig(null)).toThrow(/configuration is missing/u)
  })
})
