import { describe, expect, it } from 'vitest'
import {
  isLegacyMessage,
  MESSAGE_TYPES,
  REQUIRED_FIELDS,
  validateMessage,
  type MessageType,
} from '../src/index.js'
import { makeMessage } from './fixtures.js'

describe('validateMessage — required fields', () => {
  for (const type of MESSAGE_TYPES) {
    it(`rejects ${type} with each required field missing`, () => {
      for (const field of REQUIRED_FIELDS[type]) {
        const message = makeMessage(type, { drop: [field] })
        const errors = validateMessage(message)
        expect(
          errors.some((error) => error.code === 'missing-field' && error.message.includes(`"${field}"`)),
          `${type} without ${field} should report missing-field`,
        ).toBe(true)
      }
    })
  }
})

describe('validateMessage — sender authority', () => {
  it('rejects a DIRECTIVE written by local', () => {
    const message = makeMessage('DIRECTIVE', { sender: 'local' })
    const errors = validateMessage(message)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe('sender-not-allowed')
    expect(errors[0]?.message).toContain('local may not send DIRECTIVE')
  })

  it('rejects a REPORT written by global', () => {
    const message = makeMessage('REPORT', { sender: 'global' })
    const errors = validateMessage(message)
    expect(errors.some((error) => error.code === 'sender-not-allowed')).toBe(true)
  })

  it('rejects a TASK written by global', () => {
    const message = makeMessage('TASK', { sender: 'global' })
    expect(validateMessage(message).some((error) => error.code === 'sender-not-allowed')).toBe(true)
  })

  it('accepts CLAIM from either side', () => {
    expect(validateMessage(makeMessage('CLAIM', { sender: 'local' }))).toEqual([])
    expect(validateMessage(makeMessage('CLAIM', { sender: 'global' }))).toEqual([])
  })
})

describe('validateMessage — field shapes', () => {
  it('rejects a short commit SHA', () => {
    const message = makeMessage('REPORT', { fields: { ...makeMessage('REPORT').fields, commit: 'deadbeef' } })
    expect(validateMessage(message).some((error) => error.code === 'field-shape')).toBe(true)
  })

  it('rejects a refs entry that is not a four-digit sequence', () => {
    const message = makeMessage('REPORT', { fields: { ...makeMessage('REPORT').fields, refs: ['1'] } })
    expect(validateMessage(message).some((error) => error.message.includes('refs'))).toBe(true)
  })

  it('rejects a PATCH whose format is not git-format-patch', () => {
    const base = makeMessage('PATCH').fields
    const message = makeMessage('PATCH', { fields: { ...base, format: 'diff' } })
    expect(validateMessage(message).some((error) => error.message.includes('format'))).toBe(true)
  })

  it('rejects DIRECTIVE acceptance ids that are not AC-<n>', () => {
    const base = makeMessage('DIRECTIVE').fields
    const message = makeMessage('DIRECTIVE', {
      fields: { ...base, acceptance: [{ id: 'AC1', text: 'x' }] },
    })
    expect(validateMessage(message).some((error) => error.message.includes('acceptance'))).toBe(true)
  })

  it('rejects a DIRECTIVE version below 1', () => {
    const base = makeMessage('DIRECTIVE').fields
    const message = makeMessage('DIRECTIVE', { fields: { ...base, version: 0 } })
    expect(validateMessage(message).some((error) => error.message.includes('version'))).toBe(true)
  })

  it('accepts empty evidence and negative_tests lists on a REPORT', () => {
    const base = makeMessage('REPORT').fields
    const message = makeMessage('REPORT', { fields: { ...base, evidence: [], negative_tests: [] } })
    expect(validateMessage(message)).toEqual([])
  })
})

describe('validateMessage — legacy exemption', () => {
  it('skips §4 rules for the two archived pre-contract messages only', () => {
    const report = makeMessage('REPORT' as MessageType, { seq: '0002', fields: { hello: 'world' } })
    expect(validateMessage(report)).toEqual([])
    const task = makeMessage('TASK', { seq: '0001', fields: { hello: 'world' } })
    expect(validateMessage(task)).toEqual([])
  })

  it('still validates any other message at 0001 or 0002', () => {
    // An invalid sender on a fresh channel used to ride the seq-only exemption.
    const wrongSender = makeMessage('DIRECTIVE', { seq: '0001', sender: 'local' })
    expect(validateMessage(wrongSender).map((error) => error.code)).toContain('sender-not-allowed')
    const wrongType = makeMessage('DECISION', { seq: '0002', fields: { hello: 'world' } })
    expect(validateMessage(wrongType).map((error) => error.code)).toContain('missing-field')
    const otherSender = makeMessage('REPORT', { seq: '0002', sender: 'global', fields: { hello: 'world' } })
    expect(validateMessage(otherSender).length).toBeGreaterThan(0)
    const otherSeq = makeMessage('TASK', { seq: '0002', fields: { hello: 'world' } })
    expect(validateMessage(otherSeq).length).toBeGreaterThan(0)
  })

  it('does not exempt a fresh channel\'s 0001 TASK or 0002 REPORT that carries an id', () => {
    const report = makeMessage('REPORT' as MessageType, { seq: '0002', fields: { id: 'L-0001', hello: 'world' } })
    expect(validateMessage(report).length).toBeGreaterThan(0)
    expect(isLegacyMessage(report)).toBe(false)
    const task = makeMessage('TASK', { seq: '0001', fields: { id: 'H-0001' } })
    expect(isLegacyMessage(task)).toBe(false)
  })

  it('applies §4 rules from 0003 onward', () => {
    const message = makeMessage('REPORT', { seq: '0003', fields: { hello: 'world' } })
    expect(validateMessage(message).length).toBeGreaterThan(0)
  })
})

describe('validateMessage — REVIEW', () => {
  it('rejects a REVIEW written by local', () => {
    const message = makeMessage('REVIEW', { sender: 'local' })
    const errors = validateMessage(message)
    expect(errors.some((error) => error.code === 'sender-not-allowed')).toBe(true)
  })

  it('rejects a verdict outside the two allowed values', () => {
    const base = makeMessage('REVIEW').fields as Record<string, unknown>
    const message = makeMessage('REVIEW', { fields: { ...base, verdict: 'rejected' } })
    expect(validateMessage(message).some((error) => error.message.includes('verdict'))).toBe(true)
  })

  it('rejects a finding id that is not F-<n>', () => {
    const base = makeMessage('REVIEW').fields as Record<string, unknown>
    const message = makeMessage('REVIEW', { fields: { ...base, findings: [{ id: 'F1', severity: 'blocking', text: 'x' }] } })
    expect(validateMessage(message).some((error) => error.message.includes('findings'))).toBe(true)
  })

  it('rejects a severity outside blocking|minor', () => {
    const base = makeMessage('REVIEW').fields as Record<string, unknown>
    const message = makeMessage('REVIEW', { fields: { ...base, findings: [{ id: 'F-1', severity: 'major', text: 'x' }] } })
    expect(validateMessage(message).some((error) => error.message.includes('findings'))).toBe(true)
  })

  it('accepts an accepted verdict with no findings', () => {
    const base = makeMessage('REVIEW').fields as Record<string, unknown>
    const message = makeMessage('REVIEW', { fields: { ...base, verdict: 'accepted', findings: [] } })
    expect(validateMessage(message)).toEqual([])
  })

  it('requires REPORT.resolves to name the REVIEW and the finding', () => {
    const base = makeMessage('REPORT').fields as Record<string, unknown>
    const good = makeMessage('REPORT', { fields: { ...base, resolves: ['0011/F-1', '0014/F-12'] } })
    expect(validateMessage(good)).toEqual([])
    const bare = makeMessage('REPORT', { fields: { ...base, resolves: ['F-1'] } })
    expect(validateMessage(bare).some((error) => error.message.includes('resolves'))).toBe(true)
    const bad = makeMessage('REPORT', { fields: { ...base, resolves: ['0011/F-1', 'nope'] } })
    expect(validateMessage(bad).some((error) => error.message.includes('resolves'))).toBe(true)
  })
})

describe('validateMessage — optional REPORT fields', () => {
  const base = (): Record<string, unknown> => ({ ...makeMessage('REPORT').fields })
  const codes = (extra: Record<string, unknown>): string[] =>
    validateMessage(makeMessage('REPORT', { fields: { ...base(), ...extra } })).map((error) => `${error.code}:${error.message}`)

  it('requires checkpoint to be a boolean', () => {
    expect(codes({ checkpoint: true })).toEqual([])
    expect(codes({ checkpoint: false })).toEqual([])
    expect(codes({ checkpoint: 'yes' }).join()).toContain('checkpoint')
    expect(codes({ checkpoint: 1 }).join()).toContain('checkpoint')
  })

  it('requires meanwhile to be a list of strings', () => {
    expect(codes({ meanwhile: ['write docs'] })).toEqual([])
    expect(codes({ meanwhile: 'write docs' }).join()).toContain('meanwhile')
    expect(codes({ meanwhile: [1] }).join()).toContain('meanwhile')
  })

  it('requires open_questions to be a list of strings', () => {
    expect(codes({ open_questions: ['0037'] })).toEqual([])
    expect(codes({ open_questions: { a: 1 } }).join()).toContain('open_questions')
    expect(codes({ open_questions: [{ a: 1 }] }).join()).toContain('open_questions')
  })
})

describe('validateMessage — ISOLATION_REPORT', () => {
  const withProbes = (probes: unknown) => validateMessage(makeMessage('ISOLATION_REPORT', { fields: { probes } }))

  it('accepts complete probes', () => {
    expect(withProbes([{ name: 'a', expected: 'x', actual: 'x', pass: true }])).toEqual([])
  })

  it('requires expected and actual, not just name and pass', () => {
    expect(withProbes([{ name: 'a', pass: true }]).map((error) => error.message).join()).toContain('probes[0]')
    expect(withProbes([{ name: 'a', expected: 'x', pass: true }]).length).toBeGreaterThan(0)
  })

  it('rejects a non-boolean pass and an empty name, and names each bad probe', () => {
    const errors = withProbes([
      { name: 'ok', expected: 'x', actual: 'x', pass: true },
      { name: 'bad', expected: 'x', actual: 'x', pass: 'true' },
      { name: '', expected: 'x', actual: 'x', pass: false },
    ])
    expect(errors.map((error) => error.message).join()).toContain('probes[1]')
    expect(errors.map((error) => error.message).join()).toContain('probes[2]')
    expect(errors.map((error) => error.message).join()).not.toContain('probes[0]')
  })
})

describe('validateMessage — PATCH name doubles as an attachment path', () => {
  const withName = (name: unknown) => validateMessage(makeMessage('PATCH', { fields: { ...makeMessage('PATCH').fields, name } }))

  it('accepts a plain file name', () => {
    expect(withName('0001-docs.patch')).toEqual([])
  })

  it.each(['../x.patch', 'a/b.patch', '..', '.hidden', '', 'a\\b'])('rejects %j', (name) => {
    expect(withName(name).some((error) => error.code === 'field-shape' && error.message.includes('name'))).toBe(true)
  })
})
