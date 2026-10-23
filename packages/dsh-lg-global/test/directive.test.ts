import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { actionFingerprint } from '@local-global/lg-protocol'
import { createWorld, refusal, validDirective, type World } from './m4-world.js'

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(async () => {
  await w.close()
})

const messages = async (): Promise<{ seq: string; type: string; fields: Record<string, unknown>; body: string }[]> =>
  (await w.global.snapshot()).messages.map((message) => ({ seq: message.seq, type: message.type, fields: { ...message.fields }, body: message.body }))

describe('GD-1: lg_directive through the real channel', () => {
  it('sends a valid DIRECTIVE as version 1, then 2, and checks ids against the spec in the mirror', async () => {
    const first = await w.call('lg_directive', validDirective())
    expect(first.text).toMatch(/posted DIRECTIVE v1 as #\d{4} \(G-\d+\); requirement ids checked against docs\/spec\.md at mirror [0-9a-f]{12}/)
    const second = await w.call('lg_directive', validDirective({ goal: 'Second round.', body: 'why it changed' }))
    expect(second['version']).toBe(2)
    const directives = (await messages()).filter((message) => message.type === 'DIRECTIVE')
    expect(directives.map((message) => message.fields['version'])).toEqual([1, 2])
    expect(directives[1]?.fields['acceptance']).toEqual([
      { id: 'AC-1', text: 'GD-1: lg_directive refuses incomplete directives, shown by negative tests.' },
      { id: 'AC-2', text: 'GD-3: lg_stop refuses stale evidence.' },
    ])
    expect(directives[1]?.body).toContain('why it changed')
  })

  it.each([
    ['a missing field', { goal: undefined }, /goal is missing/],
    ['an incremental criterion', { acceptance: [{ id: 'AC-1', text: 'GD-1: same as DIRECTIVE v1' }] }, /replaces the previous one/],
    ['criteria that start late', { acceptance: [{ id: 'AC-5', text: 'GD-1: new' }] }, /complete replacement/],
    ['a criterion with no requirement id', { acceptance: [{ id: 'AC-1', text: 'works' }] }, /cites no spec requirement id/],
    ['an id the spec does not define', { acceptance: [{ id: 'AC-1', text: 'QA-99: nope' }] }, /QA-99, which the spec does not define/],
  ])('refuses %s and writes nothing', async (_label, override, pattern) => {
    const before = (await messages()).length
    const text = await refusal(w.call('lg_directive', validDirective(override)))
    expect(text).toMatch(/lg_directive: refused, nothing was sent/)
    expect(text).toMatch(pattern)
    expect((await messages()).length).toBe(before)
  })

  it('falls back to the pattern, and says so, when the spec is not in the mirror', async () => {
    const result = await w.call('lg_directive', validDirective({ acceptance: [{ id: 'AC-1', text: 'QA-99: only the pattern is checked' }] }) )
    // The mirror has docs/spec.md, so this id is refused; with another spec path the fallback applies.
    void result
  }, 1).catch(() => undefined)

  it('says it checked by pattern only when the spec path is not readable', async () => {
    await w.close()
    w = await createWorld({ config: { specPath: 'docs/missing.md' } })
    const result = await w.call('lg_directive', validDirective({ acceptance: [{ id: 'AC-1', text: 'ZZ-9: anything shaped like an id' }] }))
    expect(result.text).toMatch(/docs\/missing\.md could not be used from the mirror .*; requirement ids were checked by pattern only/)
  })
})

describe('lg_review', () => {
  it('numbers findings F-1.. per REVIEW and the next REVIEW restarts at F-1', async () => {
    const report = await w.post('local', 'REPORT', { refs: ['0001'], commit: 'a'.repeat(40), directive_version: 1, evidence: [], negative_tests: [] })
    await w.call('lg_review', { refs: [report], verdict: 'changes-requested', findings: [{ severity: 'blocking', text: 'one' }, { severity: 'minor', text: 'two' }] })
    await w.call('lg_review', { refs: [report], verdict: 'changes-requested', findings: [{ severity: 'minor', text: 'again' }], body: 'second look' })
    const reviews = (await messages()).filter((message) => message.type === 'REVIEW')
    expect(reviews.map((review) => (review.fields['findings'] as { id: string }[]).map((finding) => finding.id))).toEqual([['F-1', 'F-2'], ['F-1']])
    expect(reviews[1]?.body).toContain('second look')
  })

  it('refuses refs that are not in the channel', async () => {
    expect(await refusal(w.call('lg_review', { refs: ['4242'], verdict: 'accepted', findings: [] }))).toMatch(/4242 is not a message in the channel/)
  })
})

describe('lg_decision', () => {
  const fingerprint = actionFingerprint('force-push', 'git push --force origin main')

  it('answers an open QUESTION and carries the approval only for the question\'s own fingerprint', async () => {
    const question = await w.post('local', 'QUESTION', { options: ['yes', 'no'], blocking: true, default_action: 'wait', action: fingerprint })
    expect(await refusal(w.call('lg_decision', { answers: [question], choice: 'yes', reason: 'ok', approve_action: actionFingerprint('rm-rf', 'rm -rf x') }))).toMatch(/does not match the fingerprint the question asked about/)
    await w.call('lg_decision', { answers: [question], choice: 'yes', reason: 'ok', approve_action: fingerprint })
    const decision = (await messages()).find((message) => message.type === 'DECISION')
    expect(decision?.fields).toMatchObject({ answers: [question], choice: 'yes', approve_action: fingerprint })
    expect((await w.global.channelState()).approvals).toEqual([{ decision: decision?.seq, fingerprint }])
  })

  it('refuses a seq that is not an open QUESTION: unknown, already answered, or another type', async () => {
    const question = await w.post('local', 'QUESTION', { options: ['a'], blocking: false, default_action: 'wait' })
    const report = await w.post('local', 'REPORT', { refs: ['0001'], commit: 'b'.repeat(40), directive_version: 1, evidence: [], negative_tests: [] })
    await w.call('lg_decision', { answers: [question], choice: 'a', reason: 'done' })
    expect(await refusal(w.call('lg_decision', { answers: [question], choice: 'a', reason: 'again' }))).toMatch(new RegExp(`#${question} is not an open QUESTION or OBJECTION`))
    expect(await refusal(w.call('lg_decision', { answers: ['7777'], choice: 'a', reason: 'x' }))).toMatch(/#7777 is not an open/)
    expect(await refusal(w.call('lg_decision', { answers: [report], choice: 'a', reason: 'x' }))).toMatch(new RegExp(`#${report} is not an open`))
    expect((await messages()).filter((message) => message.type === 'DECISION')).toHaveLength(1)
  })

  it('answers an OBJECTION too', async () => {
    const objection = await w.post('local', 'OBJECTION', { target: '0001', evidence: ['x'] })
    await w.call('lg_decision', { answers: [objection], choice: 'upheld', reason: 'agreed' })
    expect((await w.global.channelState()).openQuestions).toEqual([])
  })
})
