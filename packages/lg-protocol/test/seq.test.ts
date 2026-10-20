import { describe, expect, it } from 'vitest'
import { findSeqAnomalies, nextSeq } from '../src/index.js'

describe('nextSeq', () => {
  it('starts at 0001 for an empty channel', () => {
    expect(nextSeq([])).toBe('0001')
  })

  it('continues after the highest sequence, ignoring non-message files', () => {
    expect(nextSeq(['0001-human-TASK.md', '0002-local-REPORT.md', 'README.md'])).toBe('0003')
  })

  it('throws when the channel is exhausted', () => {
    expect(() => nextSeq(['9999-global-STOP.md'])).toThrow(RangeError)
  })
})

describe('findSeqAnomalies', () => {
  it('accepts a contiguous run', () => {
    expect(findSeqAnomalies(['0001', '0002', '0003'])).toEqual([])
  })

  it('reports a gap', () => {
    expect(findSeqAnomalies(['0001', '0003'])).toEqual(['expected 0002 but found 0003'])
  })

  it('reports a duplicate', () => {
    expect(findSeqAnomalies(['0001', '0002', '0002', '0003'])).toEqual(['duplicate sequence 0002'])
  })

  it('does not treat a repeat of the last sequence as a gap', () => {
    const problems = findSeqAnomalies(['0001', '0002', '0002'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('duplicate')
  })
})
