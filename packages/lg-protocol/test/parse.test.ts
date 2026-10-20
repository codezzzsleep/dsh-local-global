import { describe, expect, it } from 'vitest'
import { parseMessage, validateMessage } from '../src/index.js'
import { makeMessage } from './fixtures.js'

describe('parseMessage', () => {
  it('parses a well-formed message into header, fields, and body', () => {
    const message = makeMessage('DIRECTIVE')
    expect(message.seq).toBe('0003')
    expect(message.sender).toBe('global')
    expect(message.type).toBe('DIRECTIVE')
    expect(message.fields['version']).toBe(1)
    expect(message.body).toBe('body text\n')
    expect(validateMessage(message)).toEqual([])
  })

  it('rejects a first line that does not match the header grammar', () => {
    const result = parseMessage('0003-global-CLAIM.md', 'LG CLAIM from global\n---\n')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.map((error) => error.code)).toEqual(['header-format'])
  })

  it('rejects a file whose sender disagrees with its first line', () => {
    const result = parseMessage('0003-local-REPORT.md', '[LG REPORT from global]\nrefs: []\n---\n')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.map((error) => error.code)).toContain('sender-mismatch')
  })

  it('rejects a file whose type disagrees with its first line', () => {
    const result = parseMessage('0003-global-CLAIM.md', '[LG DIRECTIVE from global]\n---\n')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.map((error) => error.code)).toContain('type-mismatch')
  })

  it('rejects a file name outside the four-digit convention', () => {
    const result = parseMessage('3-global-CLAIM.md', '[LG CLAIM from global]\n---\n')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors[0]?.code).toBe('filename-format')
  })

  it('rejects a field region that is not YAML', () => {
    const result = parseMessage('0003-global-CLAIM.md', '[LG CLAIM from global]\nscope: [unclosed\n---\n')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors[0]?.code).toBe('fields-yaml')
  })
})
