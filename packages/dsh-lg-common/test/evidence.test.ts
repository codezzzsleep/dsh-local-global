import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { readSessionArtifact, sessionsRoot } from '../src/evidence.js'

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
