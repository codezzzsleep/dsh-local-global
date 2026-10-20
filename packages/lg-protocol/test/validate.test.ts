import { describe, expect, it } from 'vitest'
import {
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
  it('skips §4 rules for sequences at or below 0002', () => {
    const message = makeMessage('REPORT' as MessageType, { seq: '0002', fields: { hello: 'world' } })
    expect(validateMessage(message)).toEqual([])
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
