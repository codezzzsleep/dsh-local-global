import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { checkIdentities, foldState, formatMessage, parseMessage, validateMessage } from '../src/index.js'
import type { MessageType, ParsedMessage, Sender } from '../src/index.js'

/** Build one valid message and parse it back. */
function make(seq: string, sender: Sender, type: MessageType, fields: Record<string, unknown>): ParsedMessage {
  const rendered = formatMessage({ seq, sender, type, fields, body: '' })
  const parsed = parseMessage(rendered.filename, rendered.text)
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.errors.map((error) => error.message).join('; ')}`)
  return parsed.message
}

const claim = (seq: string, fields: Record<string, unknown>): ParsedMessage =>
  make(seq, 'local', 'CLAIM', { scope: ['x'], implementer: 'local', ...fields })

describe('PR-6: id and supersedes', () => {
  it('rejects a malformed id', () => {
    const errors = validateMessage(claim('0003', { id: 'L-1' }))
    expect(errors.map((error) => error.code)).toContain('bad-id')
  })

  it('rejects an id that carries another sender prefix', () => {
    const errors = validateMessage(claim('0003', { id: 'G-0001' }))
    expect(errors.some((error) => error.code === 'bad-id')).toBe(true)
  })

  it('accepts a well-formed own id', () => {
    expect(validateMessage(claim('0003', { id: 'L-0123' }))).toEqual([])
  })

  it('flags a duplicate id across messages', () => {
    const errors = checkIdentities([claim('0003', { id: 'L-0001' }), claim('0004', { id: 'L-0001' })])
    expect(errors.map((error) => error.code)).toEqual(['duplicate-id'])
  })

  it('flags superseding another sender message', () => {
    const theirs = make('0003', 'global', 'CLAIM', { scope: ['y'], implementer: 'global', id: 'G-0001' })
    const mine = claim('0004', { id: 'L-0001', supersedes: ['G-0001'] })
    const errors = checkIdentities([theirs, mine])
    expect(errors.map((error) => error.code)).toEqual(['foreign-supersedes'])
  })

  it('flags superseding an id nobody carries', () => {
    const errors = checkIdentities([claim('0003', { id: 'L-0001', supersedes: ['L-9999'] })])
    expect(errors.map((error) => error.code)).toEqual(['unknown-supersedes'])
  })

  it('accepts superseding your own message', () => {
    const errors = checkIdentities([claim('0003', { id: 'L-0001' }), claim('0004', { id: 'L-0002', supersedes: ['L-0001'] })])
    expect(errors).toEqual([])
  })

  it('marks what supersedes names in the folded state', () => {
    const state = foldState([claim('0003', { id: 'L-0001' }), claim('0004', { id: 'L-0002', supersedes: ['L-0001'] })])
    expect(state.superseded).toEqual(['L-0001'])
  })
})

describe('PR-9: the real channel messages 0001–0039', () => {
  const dir = join(import.meta.dirname, 'real-messages')
  // SPEC names 0003..0039 for this regression: 0001 and 0002 predate the field
  // region entirely (0001 has no YAML block at all) and are not validated.
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name.slice(0, 4) >= '0003')
    .sort()

  it('parses every archived message', () => {
    expect(files.length).toBe(37)
    for (const name of files) {
      const parsed = parseMessage(name, readFileSync(join(dir, name), 'utf8'))
      expect(parsed.ok, `${name}: ${parsed.ok ? '' : parsed.errors.map((error) => error.message).join('; ')}`).toBe(true)
    }
  })

  it('folds old messages that carry no id, and pins the pre-v2 resolves shape', () => {
    // PR-9 only demands parse + fold for 0003..0039. Full validation is a
    // different matter: 0012, 0015 and 0017 were written under the pre-v2
    // contract where `resolves` was a bare `F-<n>` list, so the current shape
    // rule flags them. They are archived and cannot be rewritten, so this test
    // pins the fact instead of hiding it.
    const legacyResolves: string[] = []
    for (const name of files) {
      const parsed = parseMessage(name, readFileSync(join(dir, name), 'utf8'))
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) continue
      const errors = validateMessage(parsed.message)
      const shapeErrors = errors.filter((error) => error.code === 'field-shape')
      if (shapeErrors.length > 0) legacyResolves.push(name)
    }
    expect(legacyResolves).toEqual(['0012-local-REPORT.md', '0015-local-REPORT.md', '0017-local-REPORT.md'])
  })

  it('folds the real channel without identity errors and reports its last sequence', () => {
    const messages = files
      .map((name) => parseMessage(name, readFileSync(join(dir, name), 'utf8')))
      .filter((parsed) => parsed.ok)
      .map((parsed) => parsed.message)
    expect(checkIdentities(messages)).toEqual([])
    const state = foldState(messages)
    expect(state.lastSeq).toBe('0039')
    // This channel predates v2: its REPORTs carry refs but not `resolves`, so
    // findings legitimately stay open. The point of the regression is that the
    // old shape folds without crashing and yields the right directive.
    expect(state.directive?.seq).toBe('0025')
    expect(state.directive?.fields['version']).toBe(3)
    // The channel predates v2, so nothing carries an id or supersedes anything.
    expect(state.superseded).toEqual([])
    expect(state.pendingCheckpoints).toEqual([])
  })
})
