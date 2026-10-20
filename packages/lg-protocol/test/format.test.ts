import { describe, expect, it } from 'vitest'
import { actionFingerprint, deliveryLabel, formatMessage, parseMessage } from '../src/index.js'
import { makeMessage } from './fixtures.js'

describe('formatMessage', () => {
  it('renders the header, YAML fields, terminator, and trailing newline', () => {
    const rendered = formatMessage({ seq: '0003', sender: 'global', type: 'HALT', fields: { reason: 'stop' }, body: 'why' })
    expect(rendered.filename).toBe('0003-global-HALT.md')
    expect(rendered.text).toBe('[LG HALT from global]\nreason: stop\n---\nwhy\n')
  })

  it('round-trips through parseMessage', () => {
    const rendered = formatMessage({ seq: '0004', sender: 'local', type: 'CLAIM', fields: { scope: ['a'], implementer: 'local' } })
    const parsed = parseMessage(rendered.filename, rendered.text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected parse success')
    expect(parsed.message.fields).toEqual({ scope: ['a'], implementer: 'local' })
    expect(parsed.message.body).toBe('')
  })
})

describe('deliveryLabel', () => {
  it('carries the directive version', () => {
    expect(deliveryLabel(makeMessage('DIRECTIVE', { seq: '0002' }))).toBe('[LG #0002 DIRECTIVE v1 from global]')
  })

  it('omits a version for other types', () => {
    expect(deliveryLabel(makeMessage('CLAIM', { seq: '0003' }))).toBe('[LG #0003 CLAIM from global]')
  })
})

describe('actionFingerprint', () => {
  it('is stable and shaped <rule>:<12 hex>', () => {
    const fingerprint = actionFingerprint('force-push', 'git push --force')
    expect(fingerprint).toMatch(/^force-push:[0-9a-f]{12}$/)
    expect(actionFingerprint('force-push', 'git push --force')).toBe(fingerprint)
  })

  it('differs when the command differs', () => {
    expect(actionFingerprint('r', 'a')).not.toBe(actionFingerprint('r', 'b'))
  })
})
