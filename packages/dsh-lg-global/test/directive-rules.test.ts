import { describe, expect, it } from 'vitest'
import type { ParsedMessage } from '@local-global/lg-protocol'
import { checkDecision, checkDirective, checkReview, citedRequirements, incrementalReason, specRequirementIds } from '../src/directive-rules.js'
import { validDirective } from './m4-world.js'

const spec = new Set(['GD-1', 'GD-2', 'GD-3', 'QA-1'])
const problemsOf = (input: Record<string, unknown>, ids: ReadonlySet<string> | undefined = spec): string[] => {
  const checked = checkDirective(input, ids)
  return checked.ok ? [] : checked.problems
}

describe('GD-1: checkDirective refuses incomplete directives', () => {
  it('accepts a complete directive and numbers nothing it was not given', () => {
    const checked = checkDirective(validDirective(), spec)
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      expect(checked.fields.acceptance.map((entry) => entry.id)).toEqual(['AC-1', 'AC-2'])
      expect(checked.fields.scope).toEqual({ in: ['packages/dsh-lg-global'], out: ['packages/dsh-lg-local'] })
    }
  })

  it('refuses every missing or empty field, all at once', () => {
    const problems = problemsOf({})
    expect(problems.join('\n')).toMatch(/goal is missing/)
    expect(problems.join('\n')).toMatch(/priorities is missing/)
    expect(problems.join('\n')).toMatch(/acceptance is missing/)
    expect(problems.join('\n')).toMatch(/scope is missing/)
    expect(problemsOf(validDirective({ goal: '   ' }))).toEqual(['goal is missing or empty'])
    expect(problemsOf(validDirective({ priorities: [] }))).toEqual(['priorities must not be empty'])
    expect(problemsOf(validDirective({ priorities: ['ok', ''] }))).toEqual(['priorities[2] is empty or not a string'])
    expect(problemsOf(validDirective({ acceptance: [] }))).toEqual(['acceptance is missing or empty; a DIRECTIVE needs at least one criterion'])
    expect(problemsOf(validDirective({ scope: { in: [], out: [] } }))).toEqual(['scope.in must not be empty'])
    expect(problemsOf(validDirective({ scope: { in: ['x'] } }))).toEqual(['scope.out is missing; it must be a list of strings'])
    expect(problemsOf(validDirective({ acceptance: [{ id: 'AC-1', text: '' }] }))).toEqual(['acceptance[1] has no text'])
  })

  it('allows an empty scope.out', () => {
    expect(problemsOf(validDirective({ scope: { in: ['x'], out: [] } }))).toEqual([])
  })

  it('refuses acceptance criteria that cite no requirement id', () => {
    const problems = problemsOf(validDirective({ acceptance: [{ id: 'AC-1', text: 'GD-1: fine' }, { id: 'AC-2', text: 'It should work well.' }] }))
    expect(problems).toEqual(['AC-2 cites no spec requirement id; name the requirement it verifies, e.g. "GD-1"'])
  })

  it('does not take the criterion id, an encoding or a hash name for a requirement', () => {
    expect(citedRequirements('see AC-2, UTF-8 and SHA-256, plus GD-1 and QA-4')).toEqual(['GD-1', 'QA-4'])
    expect(problemsOf(validDirective({ acceptance: [{ id: 'AC-1', text: 'AC-1 holds for UTF-8 input' }] }))).toEqual(['AC-1 cites no spec requirement id; name the requirement it verifies, e.g. "GD-1"'])
  })

  it('checks cited ids against the spec when it is readable, and by pattern only when it is not', () => {
    const unknown = validDirective({ acceptance: [{ id: 'AC-1', text: 'ZZ-9: made up' }] })
    expect(problemsOf(unknown)).toEqual(['AC-1 cites ZZ-9, which the spec does not define'])
    expect(checkDirective(unknown, undefined).ok).toBe(true)
  })

  it('reads requirement ids from the first cell of the spec tables', () => {
    expect([...specRequirementIds('| 编号 | x |\n| --- | --- |\n| GD-1 | uses UTF-8 and mentions QA-9 |\n| GD-2 | y |\n')]).toEqual(['GD-1', 'GD-2'])
    expect([...specRequirementIds('no tables, but GD-4 is named')]).toEqual(['GD-4'])
  })
})

describe('GD-1: checkDirective refuses incremental directives', () => {
  it('requires the criteria to be numbered AC-1.. in order, so a list that only adds is refused', () => {
    const delta = validDirective({ acceptance: [{ id: 'AC-4', text: 'GD-1: a new criterion' }] })
    expect(problemsOf(delta).join('\n')).toMatch(/complete replacement.*expected AC-1/)
    const skipped = validDirective({ acceptance: [{ id: 'AC-1', text: 'GD-1: a' }, { id: 'AC-3', text: 'GD-2: b' }] })
    expect(problemsOf(skipped).join('\n')).toMatch(/expected AC-2/)
  })

  it.each([
    ['English version reference', 'Same as DIRECTIVE v2 but with GD-1 added'],
    ['named directive number', 'Complete what directive #3 asked for, GD-1'],
    ['previous version', 'GD-1: keep the criteria of the previous version'],
    ['carry over', 'GD-2: carried over from AC-3 of before'],
    ['amendment wording', 'GD-1: incremental change to the tool'],
    ['Chinese previous version', 'GD-1: 沿用上一版的验收标准'],
    ['Chinese same as above', 'GD-2: 验收标准同上'],
    ['Chinese increment', 'GD-1: 本条为增量指令'],
  ])('refuses text that depends on an earlier version: %s', (_label, text) => {
    const problems = problemsOf(validDirective({ acceptance: [{ id: 'AC-1', text }] }))
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0]).toMatch(/replaces the previous one/)
  })

  it('refuses a goal, a priority or a scope entry that only points back', () => {
    expect(problemsOf(validDirective({ goal: 'Continue with the previous directive' })).join('\n')).toMatch(/goal points at the previous version/)
    expect(problemsOf(validDirective({ priorities: ['P1 same as v2 priorities'] })).join('\n')).toMatch(/priorities\[1\]/)
    expect(problemsOf(validDirective({ scope: { in: ['everything from the last directive'], out: [] } })).join('\n')).toMatch(/scope\.in\[1\]/)
  })

  it('leaves ordinary wording alone', () => {
    for (const text of ['keep the public API signature unchanged', 'the result is the same as the input after a round trip', 'GD-1 holds in version 2 of the API', '最后一步输出保持原样']) {
      expect(incrementalReason(text)).toBeUndefined()
    }
  })
})

describe('checkReview', () => {
  const known = new Set(['0003', '0004'])

  it('numbers findings F-1.. within this REVIEW', () => {
    const checked = checkReview(
      { refs: ['0003'], verdict: 'changes-requested', findings: [{ severity: 'blocking', text: 'a' }, { severity: 'minor', text: 'b' }] },
      known,
    )
    expect(checked.ok && checked.fields.findings.map((finding) => finding.id)).toEqual(['F-1', 'F-2'])
  })

  it.each([
    [{ refs: [], verdict: 'accepted', findings: [] }, /refs is missing or empty/],
    [{ refs: ['9999'], verdict: 'accepted', findings: [] }, /not a message in the channel/],
    [{ refs: ['3'], verdict: 'accepted', findings: [] }, /not a four-digit sequence/],
    [{ refs: ['0003'], verdict: 'maybe', findings: [] }, /verdict must be/],
    [{ refs: ['0003'], verdict: 'accepted' }, /findings is missing/],
    [{ refs: ['0003'], verdict: 'accepted', findings: [{ severity: 'blocking', text: 'x' }] }, /cannot carry a blocking finding/],
    [{ refs: ['0003'], verdict: 'changes-requested', findings: [] }, /needs at least one finding/],
    [{ refs: ['0003'], verdict: 'changes-requested', findings: [{ severity: 'huge', text: 'x' }] }, /severity must be/],
    [{ refs: ['0003'], verdict: 'changes-requested', findings: [{ id: 'F-7', severity: 'minor', text: 'x' }] }, /the tool numbers findings, this one is F-1/],
  ])('refuses %j', (input, pattern) => {
    const checked = checkReview(input, known)
    expect(checked.ok).toBe(false)
    expect(checked.ok ? '' : checked.problems.join('\n')).toMatch(pattern)
  })
})

describe('checkDecision', () => {
  const message = (seq: string, type: 'QUESTION' | 'OBJECTION', extra: Record<string, unknown> = {}): ParsedMessage =>
    ({ seq, sender: 'local', type, filename: `${seq}-local-${type}.md`, fields: { ...extra }, body: '', raw: '' }) as ParsedMessage
  const open = [message('0004', 'QUESTION', { action: 'force-push:0123456789ab' }), message('0005', 'OBJECTION'), message('0006', 'QUESTION')]

  it('answers open items, and approves only the fingerprint the question carries', () => {
    expect(checkDecision({ answers: ['0005', '0006'], choice: 'A', reason: 'ok' }, open).ok).toBe(true)
    const approved = checkDecision({ answers: ['0004'], choice: 'approve', reason: 'ok', approve_action: 'force-push:0123456789ab' }, open)
    expect(approved.ok && approved.fields.approve_action).toBe('force-push:0123456789ab')
  })

  it.each([
    [{ answers: [], choice: 'A', reason: 'r' }, /answers is missing or empty/],
    [{ answers: ['0001'], choice: 'A', reason: 'r' }, /#0001 is not an open QUESTION or OBJECTION/],
    [{ answers: ['0004'], choice: '', reason: 'r' }, /choice is missing/],
    [{ answers: ['0004'], choice: 'A', reason: ' ' }, /reason is missing/],
    [{ answers: ['0004'], choice: 'A', reason: 'r', approve_action: 'rm-rf:ffffffffffff' }, /does not match the fingerprint the question asked about/],
    [{ answers: ['0006'], choice: 'A', reason: 'r', approve_action: 'rm-rf:ffffffffffff' }, /none of the answered questions carries an action fingerprint/],
    [{ answers: ['0004'], choice: 'A', reason: 'r', approve_action: 'not a fingerprint' }, /must be an action fingerprint/],
  ])('refuses %j', (input, pattern) => {
    const checked = checkDecision(input, open)
    expect(checked.ok).toBe(false)
    expect(checked.ok ? '' : checked.problems.join('\n')).toMatch(pattern)
  })
})
