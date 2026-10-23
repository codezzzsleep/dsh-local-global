import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeCtx } from '../../dsh-lg-local/test/fake-ctx.js'
import { CheckpointRuntime, DEFAULT_EVERY_MINUTES, DEFAULT_MAX_STEERS, DEFAULT_POLL_SECONDS, apply, missingAnswers, resolveCheckpointConfig, type ChannelLike } from '../src/checkpoint.js'
import { createWorld, refusal, type World } from './m4-world.js'

const MINUTE = 60_000
const ANSWERS = 'Q1: yes, on the deployed build\nQ2: yes, it is the critical path\nQ3: no, within the TASK'
const REPORT = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ refs: ['0001'], commit: 'c'.repeat(40), directive_version: 1, evidence: [], negative_tests: [], ...extra })

let w: World
let clock = 0
let runtime: CheckpointRuntime
let checkpoint: { current: CheckpointRuntime | undefined }

beforeEach(async () => {
  clock = 0
  checkpoint = { current: undefined }
  w = await createWorld({ deps: { checkpoint: () => checkpoint.current } })
  await w.post('human', 'TASK', { goal: 'g', constraints: ['c'], budget: { max_hours: 1, max_rounds: 1 } })
  runtime = build(w.global as unknown as ChannelLike)
  checkpoint.current = runtime
})
afterEach(async () => {
  await w.close()
})

function build(channel: ChannelLike, options: { agent?: boolean; every?: number } = {}): CheckpointRuntime {
  return new CheckpointRuntime({
    config: resolveCheckpointConfig({ everyMinutes: options.every ?? 120 }),
    channel: () => channel,
    agent: (id) => (options.agent === false ? undefined : w.rig.agents.get(id)),
    now: () => clock,
  })
}
const refresh = async (): Promise<void> => {
  await w.global.repo.fetch()
  await runtime.tick()
}
const prompts = (): string[] => w.agent.calls.filter((call) => call.text.includes('全局检查点')).map((call) => call.text)

describe('GK-1: global checkpoints fire on the timer and on a milestone, and a REVIEW answers them', () => {
  it('opens a timer checkpoint only once everyMinutes have passed, delivers it once, and anchors it to the newest message', async () => {
    await refresh()
    clock = 119 * MINUTE
    await refresh()
    expect(prompts()).toEqual([])
    clock = 121 * MINUTE
    await refresh()
    await refresh()
    expect(prompts()).toHaveLength(1)
    expect(runtime.pending).toMatchObject({ id: 'CP-1', reason: 'timer', anchor: '0001', delivered: true })
    const text = prompts()[0] ?? ''
    expect(text).toContain('[LG 全局检查点 CP-1] 定时检查点')
    for (const marker of ['Q1.', 'Q2.', 'Q3.', 'refs 必须包含 "0001"', 'lg_review']) expect(text).toContain(marker)
    // The channel is idle, so the prompt is a follow-up rather than a steer.
    expect(w.agent.calls.at(-1)?.kind).toBe('followup')
  })

  it('steers instead of following up while the session is running, and waits for a bound session', async () => {
    runtime = build(w.global as unknown as ChannelLike, { agent: false })
    clock = 121 * MINUTE
    await refresh()
    expect(runtime.pending).toMatchObject({ delivered: false })
    expect(prompts()).toEqual([])
    runtime = build(w.global as unknown as ChannelLike)
    runtime = Object.assign(build(w.global as unknown as ChannelLike), {})
    w.agent.status = 'running'
    clock = 300 * MINUTE
    await refresh()
    expect(w.agent.calls.at(-1)?.kind).toBe('steer')
  })

  it('opens a milestone checkpoint for a REPORT with checkpoint: true, at once, anchored to that REPORT', async () => {
    await refresh()
    await w.post('local', 'REPORT', REPORT())
    await refresh()
    expect(prompts()).toEqual([])
    const report = await w.post('local', 'REPORT', REPORT({ checkpoint: true }))
    await refresh()
    expect(runtime.pending).toMatchObject({ reason: 'milestone', anchor: report })
    expect(prompts()[0]).toContain(`Local 在 #${report} 报告了里程碑完成`)
    expect(prompts()[0]).toContain(`refs 必须包含 "${report}"`)
  })

  it('does not replay a milestone REPORT the channel already delivered', async () => {
    await w.post('local', 'REPORT', REPORT({ checkpoint: true }))
    await w.global.repo.fetch()
    const delivered = { ...(w.global as unknown as ChannelLike), snapshot: () => w.global.snapshot(), boundSessionId: 's1', cursor: '9999' } as ChannelLike
    const quiet = build(delivered)
    await quiet.tick()
    expect(quiet.pending).toBeUndefined()
    expect(prompts()).toEqual([])
  })

  it('is cleared by a REVIEW that cites the anchor and answers Q1-Q3, and the timer then starts over', async () => {
    clock = 121 * MINUTE
    await refresh()
    const anchor = runtime.pending?.anchor ?? ''

    // Wrong shape: the tool refuses, nothing is written, the checkpoint stays open.
    const before = (await w.global.snapshot()).messages.length
    expect(await refusal(w.call('lg_review', { refs: [anchor], verdict: 'accepted', findings: [], body: 'looks fine' }))).toMatch(/global checkpoint CP-1 \(#0001\): the body must answer Q1, Q2, Q3/)
    expect(await refusal(w.call('lg_review', { refs: [anchor], verdict: 'accepted', findings: [], body: 'Q1: yes\nQ3: no' }))).toMatch(/must answer Q2/)
    expect((await w.global.snapshot()).messages.length).toBe(before)

    // A REVIEW that does not cite the anchor does not answer it.
    await w.call('lg_review', { refs: ['0001'], verdict: 'accepted', findings: [] })
    // (0001 is the anchor here, so cite another message instead.)
    const other = await w.post('local', 'REPORT', REPORT())
    await w.global.repo.fetch()
    await w.call('lg_review', { refs: [other], verdict: 'accepted', findings: [], body: ANSWERS })
    await refresh()
    expect(runtime.pending).toBeUndefined()
  })

  it('a REVIEW citing the anchor with answers clears it; a late or unrelated one does not', async () => {
    clock = 121 * MINUTE
    await refresh()
    const anchor = runtime.pending?.anchor ?? ''
    const unrelated = await w.post('local', 'REPORT', REPORT())
    await w.global.repo.fetch()
    await w.call('lg_review', { refs: [unrelated], verdict: 'accepted', findings: [], body: ANSWERS })
    await refresh()
    expect(runtime.pending).toMatchObject({ id: 'CP-1' })

    await w.call('lg_review', { refs: [anchor], verdict: 'changes-requested', findings: [{ severity: 'minor', text: 'tighten Q3' }], body: ANSWERS })
    await refresh()
    expect(runtime.pending).toBeUndefined()
    clock = 150 * MINUTE
    await refresh()
    expect(runtime.pending).toBeUndefined()
    clock = (121 + 121) * MINUTE
    await refresh()
    expect(runtime.pending).toMatchObject({ id: 'CP-2', reason: 'timer' })
  })

  it('a milestone REVIEW clears both the global checkpoint and the REPORT\'s own pending checkpoint', async () => {
    await refresh()
    const report = await w.post('local', 'REPORT', REPORT({ checkpoint: true }))
    await refresh()
    expect((await w.global.channelState()).pendingCheckpoints.map((message) => message.seq)).toEqual([report])
    expect(runtime.pending?.anchor).toBe(report)
    await w.call('lg_review', { refs: [report], verdict: 'accepted', findings: [], body: ANSWERS })
    await refresh()
    expect(runtime.pending).toBeUndefined()
    expect((await w.global.channelState()).pendingCheckpoints).toEqual([])
  })

  it('answers are recognised line by line', () => {
    expect(missingAnswers(ANSWERS)).toEqual([])
    expect(missingAnswers('- Q1: a\n  Q2： b\nQ3、c')).toEqual([])
    expect(missingAnswers('Q1: a\nQ2:\nQ3 no colon here')).toEqual([2, 3])
    expect(missingAnswers('')).toEqual([1, 2, 3])
  })

  it('has the documented defaults and rejects unusable values', () => {
    expect(resolveCheckpointConfig({})).toEqual({ everyMinutes: DEFAULT_EVERY_MINUTES, pollSeconds: DEFAULT_POLL_SECONDS, maxSteersPerTurn: DEFAULT_MAX_STEERS })
    expect(DEFAULT_EVERY_MINUTES).toBe(120)
    expect(resolveCheckpointConfig({ everyMinutes: 30 }).everyMinutes).toBe(30)
    for (const bad of [0, -5, '10', Number.NaN]) expect(() => resolveCheckpointConfig({ everyMinutes: bad })).toThrow(/everyMinutes/)
    expect(() => resolveCheckpointConfig({ maxSteersPerTurn: 1.5 })).toThrow(/maxSteersPerTurn/)
  })
})

describe('GK-2: a Global turn does not end silently while there is open work', () => {
  const agentStub = (): { agent: { steer: (message: unknown) => void }; texts: string[] } => {
    const texts: string[] = []
    return { agent: { steer: (message: unknown) => texts.push((message as { content: { text: string }[] }).content[0]?.text ?? '') }, texts }
  }
  const compose = (options: Record<string, unknown> = {}, services: Record<string, unknown> = { lgChannel: w.global }) => {
    const fake = fakeCtx(services)
    fake.ctx.agents = { get: (id: string) => w.rig.agents.get(id) }
    apply(fake.ctx, { pollSeconds: 3600, ...options })
    return fake
  }
  const stopping = async (fake: ReturnType<typeof compose>, agent: object, turn: number): Promise<void> => {
    await w.global.repo.fetch()
    await fake.emit('agent/turn-stopping', { agent, turn })
  }

  it('lets the turn end when nothing is open', async () => {
    const fake = compose()
    const { agent, texts } = agentStub()
    await stopping(fake, agent, 1)
    expect(texts).toEqual([])
  })

  it('steers a prompt for an open QUESTION and for an OBJECTION, and stops once they are answered', async () => {
    const question = await w.post('local', 'QUESTION', { options: ['a'], blocking: false, default_action: 'wait' })
    const objection = await w.post('local', 'OBJECTION', { target: '0001', evidence: ['x'] })
    const fake = compose()
    const { agent, texts } = agentStub()
    await stopping(fake, agent, 1)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain(`#${question} QUESTION`)
    expect(texts[0]).toContain(`#${objection} OBJECTION`)
    expect(texts[0]).toContain('lg_decision')

    await w.call('lg_decision', { answers: [question, objection], choice: 'a', reason: 'done' })
    await stopping(fake, agent, 2)
    expect(texts).toHaveLength(1)
  })

  it('steers for a checkpoint REPORT nobody reviewed, until a REVIEW cites it', async () => {
    const report = await w.post('local', 'REPORT', REPORT({ checkpoint: true }))
    const fake = compose()
    const { agent, texts } = agentStub()
    await stopping(fake, agent, 1)
    expect(texts[0]).toContain(`#${report} 是请求审核的 checkpoint REPORT`)
    await w.call('lg_review', { refs: [report], verdict: 'accepted', findings: [] })
    await stopping(fake, agent, 2)
    expect(texts).toHaveLength(1)
  })

  it('steers for an unanswered global checkpoint', async () => {
    const fake = compose()
    const service = fake.services.get('lgCheckpoint') as CheckpointRuntime
    expect(service).toBeInstanceOf(CheckpointRuntime)
    await w.post('local', 'REPORT', REPORT({ checkpoint: true }))
    await w.global.repo.fetch()
    await service.tick()
    expect(service.pending).toBeDefined()
    const { agent, texts } = agentStub()
    await stopping(fake, agent, 1)
    expect(texts.join('\n')).toContain('全局检查点 CP-1 还没有 REVIEW')
  })

  it('reminds at most maxSteersPerTurn times in one turn, then lets it end; a new turn starts counting again', async () => {
    await w.post('local', 'QUESTION', { options: ['a'], blocking: false, default_action: 'wait' })
    const fake = compose({ maxSteersPerTurn: 2 })
    const { agent, texts } = agentStub()
    for (let attempt = 0; attempt < 5; attempt++) await stopping(fake, agent, 7)
    expect(texts).toHaveLength(2)
    expect(texts[0]).not.toContain('最后一次提醒')
    expect(texts[1]).toContain('最后一次提醒')
    expect(fake.logs.filter((line) => line.includes('ending turn 7 with open work after 2 reminder(s)'))).toHaveLength(3)
    await stopping(fake, agent, 8)
    expect(texts).toHaveLength(3)
  })

  it('does nothing, and says so once, when lg-channel is not composed', async () => {
    const fake = compose({}, {})
    const { agent, texts } = agentStub()
    await fake.emit('agent/turn-stopping', { agent, turn: 1 })
    await fake.emit('agent/turn-stopping', { agent, turn: 2 })
    expect(texts).toEqual([])
    expect(fake.logs.filter((line) => line.includes('lg-channel is not composed'))).toHaveLength(1)
  })

  it('does not hold the turn when the channel cannot be read, and logs why', async () => {
    const broken = { snapshot: async () => Promise.reject(new Error('disk gone')), boundSessionId: null }
    const fake = compose({}, { lgChannel: broken })
    const { agent, texts } = agentStub()
    await fake.emit('agent/turn-stopping', { agent, turn: 1 })
    expect(texts).toEqual([])
    expect(fake.logs.join('\n')).toMatch(/the channel cannot be read \(disk gone\)/)
  })

  it('falls back to the defaults, with a warning, on an unusable config', () => {
    const fake = compose({ everyMinutes: -1 })
    expect(fake.logs.join('\n')).toMatch(/"everyMinutes" must be a positive number; using the defaults/)
  })
})
