import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'

import { apply, readSessionArtifact, sessionsRoot } from '../src/evidence.js'

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

describe('EV-3: the exported events are byte-identical to the session log', () => {
  it('decompresses the store and returns exactly those bytes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lg-ev3-'))
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const dir = join(home, 'sessions', '--tmp--', id)
    mkdirSync(dir, { recursive: true })
    const events = [
      JSON.stringify({ type: 'session', version: 4, id, cwd: '/tmp' }),
      JSON.stringify({ type: 'tool/call', turn: 1, step: 1, name: 'lg_evidence_session', arguments: '{}' }),
      JSON.stringify({ type: 'tool/result', turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } }),
      '',
    ].join('\n')
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(events, 'utf8')))

    expect(sessionsRoot(home)).toBe(join(home, 'sessions'))
    const artifact = await readSessionArtifact(sessionsRoot(home), id)
    if (typeof artifact === 'string') throw new Error(artifact)

    // Same bytes as the log the store holds, not a re-serialization of it.
    expect(artifact.jsonl).toBe(events)
    expect(sha(artifact.jsonl)).toBe(sha(events))
    expect(sha(artifact.jsonl)).toBe(sha(artifact.jsonl))
    expect(artifact.jsonl).toContain('"type":"tool/call"')
  })

  it('also accepts an uncompressed log and reports a missing session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lg-ev3b-'))
    const id = 'ffffffff-0000-1111-2222-333333333333'
    const dir = join(home, 'sessions', '--tmp--', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), '{"type":"session"}\n')
    const artifact = await readSessionArtifact(sessionsRoot(home), id)
    expect(typeof artifact === 'string' ? artifact : artifact.jsonl).toBe('{"type":"session"}\n')

    const missing = await readSessionArtifact(sessionsRoot(home), 'no-such-session')
    expect(typeof missing).toBe('string')
    expect(missing).toContain('no event log')
  })
})

describe('sessionsRoot', () => {
  it('falls back to ~/.dsh when DSH_HOME is unset', () => {
    expect(sessionsRoot('')).toContain('.dsh/sessions')
    expect(sessionsRoot('/srv/home')).toBe('/srv/home/sessions')
  })
})

describe('lg_evidence_session hardening', () => {
  type Execute = (args: unknown, exec: { agent?: unknown }) => Promise<Record<string, unknown>>

  function setup(): { home: string; cwd: string; id: string; run: Execute; agent: unknown; log: (bytes: Buffer) => void } {
    const home = mkdtempSync(join(tmpdir(), 'lg-ev-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'lg-ev-cwd-'))
    const id = 'sessionone'
    const dir = join(home, 'sessions', '--tmp--', id)
    mkdirSync(dir, { recursive: true })
    process.env['DSH_HOME'] = home
    let execute: Execute | undefined
    apply({ tools: { register: (definition: { execute: Execute }) => (execute = definition.execute) } } as never)
    return {
      home,
      cwd,
      id,
      run: execute as Execute,
      agent: { session: { id, header: { id, cwd } } },
      log: (bytes) => writeFileSync(join(dir, 'session.v4.jsonl'), bytes),
    }
  }

  afterEach(() => {
    delete process.env['DSH_HOME']
  })

  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

  it('refuses a session id that climbs out of the store', async () => {
    const { home, run, agent, cwd } = setup()
    mkdirSync(join(home, 'secret'), { recursive: true })
    writeFileSync(join(home, 'secret', 'session.jsonl'), '{"leak":true}\n')
    const root = sessionsRoot(home)
    for (const id of ['../../secret', '..', 'a/b', '.hidden', '']) {
      const found = await readSessionArtifact(root, id)
      expect(typeof found, id).toBe('string')
    }
    await expect(run({ out: 'out.jsonl', session: '../../secret' }, { agent })).rejects.toThrow(/not a session id/u)
    expect(existsSync(join(cwd, 'out.jsonl'))).toBe(false)
  })

  it('exports the log byte for byte, including bytes that are not UTF-8', async () => {
    const { run, agent, cwd, log } = setup()
    const bytes = Buffer.concat([Buffer.from('{"a":1}\n'), Buffer.from([0xff, 0xfe, 0x80, 0x0a]), Buffer.from('{"b":2}')])
    log(bytes)
    const result = await run({ out: 'drafts/evidence/session.jsonl' }, { agent })
    const written = readFileSync(join(realpathSync(cwd), 'drafts', 'evidence', 'session.jsonl'))
    expect(written.equals(bytes)).toBe(true)
    expect(result['sha256']).toBe(sha256(bytes))
    expect(result['bytes']).toBe(bytes.length)
    expect(result['events']).toBe(3)
  })

  it('exports only an event range, unchanged, when from and to are given', async () => {
    const { run, agent, cwd, log } = setup()
    const lines = ['{"n":1}', '{"n":2,"raw":"é\\u0000"}', '', '{"n":3}\r', '{"n":4}']
    const bytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8')
    log(bytes)
    const result = await run({ out: 'part.jsonl', from: 2, to: 3 }, { agent })
    const written = readFileSync(join(realpathSync(cwd), 'part.jsonl'))
    // Events 2 and 3 are lines 2 and 4; the blank line between them and the CRLF stay.
    expect(written.toString('utf8')).toBe('{"n":2,"raw":"é\\u0000"}\n\n{"n":3}\r\n')
    expect(result).toMatchObject({ from: 2, to: 3, total: 4, events: 2, bytes: written.length, sha256: sha256(written) })
    // The slice is a literal part of the log.
    expect(bytes.indexOf(written)).toBeGreaterThan(-1)
  })

  it('clips a range past the end and rejects ranges that select nothing', async () => {
    const { run, agent, log } = setup()
    log(Buffer.from('{"n":1}\n{"n":2}\n'))
    expect(await run({ out: 'a.jsonl', from: 2, to: 99 }, { agent })).toMatchObject({ from: 2, to: 2, total: 2 })
    await expect(run({ out: 'b.jsonl', from: 3 }, { agent })).rejects.toThrow(/2 events/u)
    await expect(run({ out: 'c.jsonl', from: 0 }, { agent })).rejects.toThrow(/valid 1-based range/u)
    await expect(run({ out: 'd.jsonl', from: 2, to: 1 }, { agent })).rejects.toThrow(/valid 1-based range/u)
    await expect(run({ out: 'e.jsonl', from: 'x' }, { agent })).rejects.toThrow(/must be a number/u)
  })

  it('refuses an out path that leaves the session directory lexically', async () => {
    const { run, agent, log } = setup()
    log(Buffer.from('{"n":1}\n'))
    await expect(run({ out: '../escape.jsonl' }, { agent })).rejects.toThrow(/outside the session directory/u)
    await expect(run({ out: join(tmpdir(), 'abs-escape.jsonl') }, { agent })).rejects.toThrow(/outside the session directory/u)
  })

  it('refuses an out path that leaves it through a symlink', async () => {
    const { run, agent, log, cwd } = setup()
    log(Buffer.from('{"n":1}\n'))
    const outside = mkdtempSync(join(tmpdir(), 'lg-ev-outside-'))
    symlinkSync(outside, join(cwd, 'link'))
    await expect(run({ out: 'link/stolen.jsonl' }, { agent })).rejects.toThrow(/outside the session directory/u)
    expect(existsSync(join(outside, 'stolen.jsonl'))).toBe(false)
    // A directory that does not exist yet, below the link, is judged by the link too.
    await expect(run({ out: 'link/new/dir/stolen.jsonl' }, { agent })).rejects.toThrow(/outside the session directory/u)
    expect(existsSync(join(outside, 'new'))).toBe(false)
  })

  it('refuses a file symlink that leads out, and a dangling one', async () => {
    const { run, agent, log, cwd } = setup()
    log(Buffer.from('{"n":1}\n'))
    const outside = mkdtempSync(join(tmpdir(), 'lg-ev-outside-'))
    writeFileSync(join(outside, 'victim.txt'), 'keep')
    symlinkSync(join(outside, 'victim.txt'), join(cwd, 'file-link'))
    await expect(run({ out: 'file-link' }, { agent })).rejects.toThrow(/outside the session directory/u)
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('keep')

    symlinkSync(join(outside, 'not-there-yet'), join(cwd, 'dangling'))
    await expect(run({ out: 'dangling' }, { agent })).rejects.toThrow(/dangling symlink/u)
    expect(existsSync(join(outside, 'not-there-yet'))).toBe(false)
  })

  it('still allows a symlink that stays inside the session directory', async () => {
    const { run, agent, log, cwd } = setup()
    log(Buffer.from('{"n":1}\n'))
    mkdirSync(join(cwd, 'real'))
    symlinkSync(join(cwd, 'real'), join(cwd, 'alias'))
    await run({ out: 'alias/ok.jsonl' }, { agent })
    expect(readFileSync(join(cwd, 'real', 'ok.jsonl'), 'utf8')).toBe('{"n":1}\n')
  })
})
