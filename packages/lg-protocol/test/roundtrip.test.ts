import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatMessage, formatParsed, parseMessage } from '../src/index.js'

describe('PR-3: parse then render reproduces the original bytes', () => {
  const dir = join(import.meta.dirname, 'real-messages')
  // 0001 and 0002 predate the field region and do not parse (PR-9 starts at 0003).
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name.slice(0, 4) >= '0003')
    .sort()

  it('holds for all 37 archived messages, hand-written YAML included', () => {
    expect(files).toHaveLength(37)
    const changed: string[] = []
    for (const name of files) {
      const text = readFileSync(join(dir, name), 'utf8')
      const parsed = parseMessage(name, text)
      if (!parsed.ok) throw new Error(`${name} does not parse`)
      const rendered = formatParsed(parsed.message)
      expect(rendered.filename).toBe(name)
      if (rendered.text !== text) changed.push(name)
    }
    expect(changed).toEqual([])
  })

  it('holds for what formatMessage writes, whatever the body ends with', () => {
    for (const body of ['', 'one line', 'one line\n', 'two\n\n', 'blank tail\n\n\n', '\n\nleading blanks\n', 'trailing spaces   \n  \n']) {
      const first = formatMessage({ seq: '0004', sender: 'local', type: 'CLAIM', fields: { scope: ['a', 'b'], implementer: 'local' }, body })
      const parsed = parseMessage(first.filename, first.text)
      if (!parsed.ok) throw new Error('did not parse')
      const again = formatMessage({ seq: parsed.message.seq, sender: parsed.message.sender, type: parsed.message.type, fields: parsed.message.fields, body: parsed.message.body })
      expect(again.text, JSON.stringify(body)).toBe(first.text)
      expect(formatParsed(parsed.message).text, JSON.stringify(body)).toBe(first.text)
    }
  })

  it('keeps a body that ends in several newlines intact', () => {
    const rendered = formatMessage({ seq: '0004', sender: 'local', type: 'CLAIM', fields: { scope: [], implementer: 'local' }, body: 'x\n\n\n' })
    expect(rendered.text.endsWith('---\nx\n\n\n')).toBe(true)
  })

  it('supplies the final newline a body is missing', () => {
    const rendered = formatMessage({ seq: '0004', sender: 'local', type: 'CLAIM', fields: { scope: [], implementer: 'local' }, body: 'x' })
    expect(rendered.text.endsWith('---\nx\n')).toBe(true)
  })

  it('round-trips a message with no fields and no body', () => {
    const text = '[LG HALT from human]\n---\n'
    const parsed = parseMessage('0005-human-HALT.md', text)
    if (!parsed.ok) throw new Error('did not parse')
    expect(formatParsed(parsed.message).text).toBe(text)
  })
})
