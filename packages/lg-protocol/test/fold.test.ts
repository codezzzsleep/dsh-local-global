import { describe, expect, it } from 'vitest'
import { foldState } from '../src/index.js'
import { makeMessage } from './fixtures.js'

describe('foldState — open questions', () => {
  it('lists a QUESTION until a DECISION answers it', () => {
    const question = makeMessage('QUESTION', { seq: '0003' })
    const before = foldState([question])
    expect(before.openQuestions.map((message) => message.seq)).toEqual(['0003'])

    const decision = makeMessage('DECISION', {
      seq: '0004',
      fields: { answers: ['0003'], choice: 'A', reason: 'go' },
    })
    const after = foldState([question, decision])
    expect(after.openQuestions).toEqual([])
  })

  it('keeps an OBJECTION open until a DECISION names it', () => {
    const objection = makeMessage('OBJECTION', { seq: '0005' })
    const decision = makeMessage('DECISION', {
      seq: '0006',
      fields: { answers: ['0001'], choice: 'A', reason: 'other' },
    })
    expect(foldState([objection, decision]).openQuestions.map((message) => message.seq)).toEqual(['0005'])
  })
})

describe('foldState — approvals', () => {
  const decision = makeMessage('DECISION', {
    seq: '0007',
    fields: { answers: ['0002'], choice: 'A', reason: 'ok', approve_action: 'force-push:abc123def456' },
  })

  it('exposes an approval granted by a DECISION', () => {
    const state = foldState([decision])
    expect(state.approvals).toEqual([{ decision: '0007', fingerprint: 'force-push:abc123def456' }])
  })

  it('drops the approval once a REPORT registers it in consumed_approvals', () => {
    const report = makeMessage('REPORT', {
      seq: '0008',
      fields: { ...makeMessage('REPORT').fields, consumed_approvals: ['0007'] },
    })
    expect(foldState([decision, report]).approvals).toEqual([])
  })

  it('does not drop an approval consumed by an unrelated sequence', () => {
    const report = makeMessage('REPORT', {
      seq: '0008',
      fields: { ...makeMessage('REPORT').fields, consumed_approvals: ['0003'] },
    })
    expect(foldState([decision, report]).approvals).toHaveLength(1)
  })
})

describe('foldState — directive and halt', () => {
  it('keeps the highest-version DIRECTIVE', () => {
    const v1 = makeMessage('DIRECTIVE', { seq: '0003', fields: { ...makeMessage('DIRECTIVE').fields, version: 1 } })
    const v2 = makeMessage('DIRECTIVE', { seq: '0009', fields: { ...makeMessage('DIRECTIVE').fields, version: 2 } })
    expect(foldState([v1, v2]).directive?.seq).toBe('0009')
    expect(foldState([v2, v1]).directive?.seq).toBe('0009')
  })

  it('reports the last HALT and the highest sequence', () => {
    const halt = makeMessage('HALT', { seq: '0011' })
    const state = foldState([makeMessage('QUESTION', { seq: '0003' }), halt])
    expect(state.halt?.seq).toBe('0011')
    expect(state.lastSeq).toBe('0011')
  })

  it('treats an empty channel as 0000 with no directive', () => {
    const state = foldState([])
    expect(state.lastSeq).toBe('0000')
    expect(state.directive).toBeUndefined()
  })
})

describe('foldState — REVIEW findings', () => {
  const review = makeMessage('REVIEW', {
    seq: '0011',
    fields: {
      refs: ['0008'],
      verdict: 'changes-requested',
      findings: [
        { id: 'F-1', severity: 'blocking', text: 'no sources' },
        { id: 'F-2', severity: 'minor', text: 'fixture naming' },
      ],
    },
  })

  it('lists every finding until a REPORT resolves it', () => {
    const state = foldState([review])
    expect(state.unresolvedFindings.map((entry) => entry.finding.id)).toEqual(['F-1', 'F-2'])
    expect(state.unresolvedFindings[0]?.review).toBe('0011')
  })

  it('drops a finding named by a later REPORT.resolves', () => {
    const report = makeMessage('REPORT', {
      seq: '0012',
      fields: { ...makeMessage('REPORT').fields, resolves: ['0011/F-1'] },
    })
    const state = foldState([review, report])
    expect(state.unresolvedFindings.map((entry) => entry.finding.id)).toEqual(['F-2'])
  })

  it('does not resolve another REVIEW that reuses the same finding id', () => {
    const second = makeMessage('REVIEW', {
      seq: '0014',
      fields: {
        refs: ['0012'],
        verdict: 'changes-requested',
        findings: [{ id: 'F-1', severity: 'blocking', text: 'second review, same id' }],
      },
    })
    const report = makeMessage('REPORT', {
      seq: '0015',
      fields: { ...makeMessage('REPORT').fields, resolves: ['0011/F-1'] },
    })
    const state = foldState([review, second, report])
    // 0011/F-1 is resolved; 0014/F-1 is a different finding with the same id.
    expect(state.unresolvedFindings.map((entry) => `${entry.review}/${entry.finding.id}`)).toEqual(['0011/F-2', '0014/F-1'])
  })
})
