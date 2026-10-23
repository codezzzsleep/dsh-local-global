import { describe, expect, it } from 'vitest'
import { analyzeChannel, foldChannel, foldState, formatMessage, parseMessage, supersededByOf } from '../src/index.js'
import type { MessageType, ParsedMessage, Sender } from '../src/index.js'
import { PRIMARY_SENDER, VALID_FIELDS } from './fixtures.js'

function make(seq: string, type: MessageType, fields: Record<string, unknown> = {}, sender: Sender = PRIMARY_SENDER[type]): ParsedMessage {
  const rendered = formatMessage({ seq, sender, type, fields: { ...VALID_FIELDS[type], ...fields }, body: '' })
  const parsed = parseMessage(rendered.filename, rendered.text)
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join('; '))
  return parsed.message
}

/** A message whose fields are replaced wholesale, so required ones can be absent. */
function raw(seq: string, type: MessageType, fields: Record<string, unknown>, sender: Sender = PRIMARY_SENDER[type]): ParsedMessage {
  const rendered = formatMessage({ seq, sender, type, fields, body: '' })
  const parsed = parseMessage(rendered.filename, rendered.text)
  if (!parsed.ok) throw new Error('did not parse')
  return parsed.message
}

const approve = { answers: ['0003'], choice: 'A', reason: 'ok', approve_action: 'force-push:abc123def456' }

describe('foldChannel — approvals only from valid DECISIONs', () => {
  it('grants an approval for a valid DECISION', () => {
    const state = foldChannel([make('0004', 'DECISION', approve)])
    expect(state.approvals).toEqual([{ decision: '0004', fingerprint: 'force-push:abc123def456' }])
  })

  it('grants nothing for a DECISION written by local', () => {
    const forged = make('0004', 'DECISION', approve, 'local')
    // foldState alone is a pure fold and trusts its input; this is the hole.
    expect(foldState([forged]).approvals).toHaveLength(1)
    expect(foldChannel([forged]).approvals).toEqual([])
  })

  it('grants nothing for a DECISION missing required fields', () => {
    const partial = raw('0004', 'DECISION', { approve_action: 'force-push:abc123def456' })
    expect(foldChannel([partial]).approvals).toEqual([])
  })

  it('grants nothing for a DECISION with a malformed shape', () => {
    const bad = make('0004', 'DECISION', { ...approve, answers: 'not-a-list' })
    expect(foldChannel([bad]).approvals).toEqual([])
  })

  it('grants nothing for a superseded DECISION', () => {
    const decision = make('0004', 'DECISION', { ...approve, id: 'G-0001' })
    const retraction = make('0005', 'DECISION', { answers: ['0003'], choice: 'B', reason: 'changed my mind', id: 'G-0002', supersedes: ['G-0001'] })
    expect(foldChannel([decision]).approvals).toHaveLength(1)
    expect(foldChannel([decision, retraction]).approvals).toEqual([])
  })

  it('cannot be granted by a foreign supersedes either way', () => {
    const decision = make('0004', 'DECISION', { ...approve, id: 'G-0001' })
    const attack = make('0005', 'CLAIM', { id: 'L-0001', supersedes: ['G-0001'] }, 'local')
    expect(foldChannel([decision, attack]).approvals).toHaveLength(1)
  })

  it('stays consumed when the REPORT that registered it is later superseded', () => {
    const decision = make('0004', 'DECISION', approve)
    const report = make('0005', 'REPORT', { id: 'L-0001', consumed_approvals: ['0004'] })
    const redo = make('0006', 'REPORT', { id: 'L-0002', supersedes: ['L-0001'] })
    expect(foldChannel([decision, report]).approvals).toEqual([])
    expect(foldChannel([decision, report, redo]).approvals).toEqual([])
  })

  it('treats the legacy messages as inert', () => {
    const legacy = raw('0002', 'REPORT', { consumed_approvals: ['0004'] })
    const decision = make('0004', 'DECISION', approve)
    expect(foldChannel([legacy, decision]).approvals).toHaveLength(1)
    expect(foldChannel([legacy, decision]).lastSeq).toBe('0004')
  })
})

describe('foldChannel — questions, findings, checkpoints, directive', () => {
  it('drops a superseded QUESTION from the open list', () => {
    const question = make('0003', 'QUESTION', { id: 'L-0001' })
    const reworded = make('0004', 'QUESTION', { id: 'L-0002', supersedes: ['L-0001'], options: ['C'] })
    expect(foldChannel([question]).openQuestions.map((m) => m.seq)).toEqual(['0003'])
    expect(foldChannel([question, reworded]).openQuestions.map((m) => m.seq)).toEqual(['0004'])
  })

  it('ignores an invalid QUESTION and an invalid answer', () => {
    const bad = raw('0003', 'QUESTION', { options: ['A'] })
    expect(foldChannel([bad]).openQuestions).toEqual([])
    const question = make('0003', 'QUESTION')
    const fakeAnswer = make('0004', 'DECISION', { answers: ['0003'], choice: 'A', reason: 'x' }, 'local')
    expect(foldChannel([question, fakeAnswer]).openQuestions.map((m) => m.seq)).toEqual(['0003'])
  })

  it('does not resolve a finding through an invalid REPORT', () => {
    const review = make('0011', 'REVIEW', { findings: [{ id: 'F-1', severity: 'blocking', text: 't' }] })
    const invalidReport = raw('0012', 'REPORT', { resolves: ['0011/F-1'] })
    expect(foldChannel([review, invalidReport]).unresolvedFindings).toHaveLength(1)
    const validReport = make('0012', 'REPORT', { resolves: ['0011/F-1'] })
    expect(foldChannel([review, validReport]).unresolvedFindings).toEqual([])
  })

  it('does not report findings of a superseded REVIEW', () => {
    const review = make('0011', 'REVIEW', { id: 'G-0001', findings: [{ id: 'F-1', severity: 'blocking', text: 't' }] })
    const newer = make('0012', 'REVIEW', { id: 'G-0002', supersedes: ['G-0001'], verdict: 'accepted', findings: [] })
    expect(foldChannel([review, newer]).unresolvedFindings).toEqual([])
  })

  it('does not keep a superseded checkpoint pending', () => {
    const checkpoint = make('0005', 'REPORT', { id: 'L-0001', checkpoint: true })
    const retract = make('0006', 'REPORT', { id: 'L-0002', supersedes: ['L-0001'] })
    expect(foldChannel([checkpoint]).pendingCheckpoints).toHaveLength(1)
    expect(foldChannel([checkpoint, retract]).pendingCheckpoints).toEqual([])
  })

  it('ignores an invalid DIRECTIVE when choosing the current one', () => {
    const good = make('0005', 'DIRECTIVE', { version: 1 })
    const forged = make('0006', 'DIRECTIVE', { version: 9 }, 'local')
    expect(foldChannel([good, forged]).directive?.seq).toBe('0005')
  })

  it('still reports the true channel maximum when the newest message is invalid', () => {
    const state = foldChannel([make('0003', 'CLAIM'), raw('0004', 'REVIEW', {})])
    expect(state.lastSeq).toBe('0004')
  })
})

describe('analyzeChannel — supersedes only works within one sender', () => {
  const theirs = make('0003', 'CLAIM', { id: 'G-0001' })

  it('ignores a foreign supersedes and says why', () => {
    const mine = make('0004', 'CLAIM', { id: 'L-0001', supersedes: ['G-0001'] }, 'local')
    const analysis = analyzeChannel([theirs, mine])
    expect(supersededByOf(analysis, theirs)).toBeUndefined()
    expect(analysis.ignored.get(mine.filename)?.map((entry) => entry.code)).toEqual(['foreign-supersedes'])
    expect(analysis.effective).toContain(mine)
  })

  it('ignores an unknown supersedes and says why', () => {
    const mine = make('0004', 'CLAIM', { id: 'L-0001', supersedes: ['L-0099'] }, 'local')
    const analysis = analyzeChannel([theirs, mine])
    expect(analysis.ignored.get(mine.filename)?.map((entry) => entry.code)).toEqual(['unknown-supersedes'])
  })

  it('ignores a self-supersedes and a supersedes that points forward', () => {
    const selfRef = make('0004', 'CLAIM', { id: 'L-0001', supersedes: ['L-0001'] }, 'local')
    const early = make('0005', 'CLAIM', { id: 'L-0002', supersedes: ['L-0003'] }, 'local')
    const later = make('0006', 'CLAIM', { id: 'L-0003' }, 'local')
    const analysis = analyzeChannel([selfRef, early, later])
    expect(analysis.supersededBy.size).toBe(0)
    expect(analysis.ignored.get(selfRef.filename)?.[0]?.code).toBe('self-supersedes')
    expect(analysis.ignored.get(early.filename)?.[0]?.code).toBe('self-supersedes')
  })

  it('honours a same-sender supersedes', () => {
    const first = make('0004', 'CLAIM', { id: 'L-0001' }, 'local')
    const second = make('0005', 'CLAIM', { id: 'L-0002', supersedes: ['L-0001'] }, 'local')
    const analysis = analyzeChannel([first, second])
    expect(supersededByOf(analysis, first)).toBe(second)
    expect(analysis.ignored.size).toBe(0)
    expect(foldChannel([first, second]).superseded).toEqual(['L-0001'])
  })

  it('lets only an effective message supersede', () => {
    const decision = make('0004', 'DECISION', { ...approve, id: 'G-0001' })
    const invalid = raw('0005', 'DECISION', { id: 'G-0002', supersedes: ['G-0001'] })
    expect(foldChannel([decision, invalid]).approvals).toHaveLength(1)
  })

  it('flags a reused id and keeps the first owner', () => {
    const first = make('0003', 'CLAIM', { id: 'L-0001' }, 'local')
    const again = make('0004', 'CLAIM', { id: 'L-0001' }, 'local')
    const analysis = analyzeChannel([first, again])
    expect(analysis.issues.get(again.filename)?.map((error) => error.code)).toEqual(['duplicate-id'])
    expect(analysis.effective).toEqual([first])
  })

  it('flags a CORRECTION of another sender message, or of nothing', () => {
    const foreign = make('0004', 'CORRECTION', { corrects: '0003', replacement: 'x' }, 'local')
    const none = make('0005', 'CORRECTION', { corrects: '0099', replacement: 'x' }, 'local')
    const own = make('0006', 'CORRECTION', { corrects: '0004', replacement: 'x' }, 'local')
    const analysis = analyzeChannel([theirs, foreign, none, own])
    expect(analysis.ignored.get(foreign.filename)?.[0]?.code).toBe('foreign-corrects')
    expect(analysis.ignored.get(none.filename)?.[0]?.code).toBe('unknown-corrects')
    expect(analysis.ignored.has(own.filename)).toBe(false)
  })
})

describe('analyzeChannel — HALT can never be suppressed', () => {
  const halt = make('0005', 'HALT', { id: 'H-0001' })

  it('ignores a supersedes from another sender', () => {
    const attack = make('0006', 'CLAIM', { id: 'L-0001', supersedes: ['H-0001'] }, 'local')
    const analysis = analyzeChannel([halt, attack])
    expect(supersededByOf(analysis, halt)).toBeUndefined()
    expect(analysis.halts).toEqual([halt])
    expect(foldChannel([halt, attack]).halt?.seq).toBe('0005')
  })

  it('ignores a supersedes from the human too', () => {
    const second = make('0006', 'HALT', { id: 'H-0002', supersedes: ['H-0001'] })
    const analysis = analyzeChannel([halt, second])
    expect(supersededByOf(analysis, halt)).toBeUndefined()
    expect(analysis.ignored.get(second.filename)?.[0]?.code).toBe('halt-supersedes')
  })

  it('counts a HALT with invalid fields', () => {
    const broken = raw('0005', 'HALT', { why: 'no reason field' })
    const analysis = analyzeChannel([broken])
    expect(analysis.issues.has(broken.filename)).toBe(true)
    expect(analysis.halts).toEqual([broken])
    expect(foldChannel([broken]).halt).toBe(broken)
  })

  it('does not count a HALT written by someone other than human', () => {
    const fake = make('0005', 'HALT', {}, 'local')
    expect(foldChannel([fake]).halt).toBeUndefined()
  })
})
