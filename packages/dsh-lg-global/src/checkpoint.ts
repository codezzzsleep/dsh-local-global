/**
 * `lg-checkpoint` — keeps the global view alive (GK-1, GK-2).
 *
 * A *global checkpoint* is a prompt delivered to the bound Global session,
 * asking three questions Global answers with one REVIEW:
 * - on a timer (`everyMinutes`), and
 * - when Local reports a milestone, i.e. a REPORT with `checkpoint: true`.
 *
 * The REVIEW names the checkpoint through `refs`: the prompt carries an anchor
 * sequence (the milestone REPORT, or the newest message when the timer fired),
 * and a Global REVIEW that cites it and answers `Q1`..`Q3` in its body clears
 * the checkpoint. That uses nothing but `refs`, so it stays inside the message
 * protocol, and it also clears a milestone REPORT's own "pending checkpoint"
 * (a Global message citing it) in the same stroke. The state is read from the
 * channel, so only the anchor itself is kept in memory; a restart forgets an
 * unanswered timer checkpoint and starts the clock again.
 *
 * On `agent/turn-stopping` the plugin steers a prompt while a QUESTION or
 * OBJECTION is open, a checkpoint REPORT is unreviewed, or a global checkpoint
 * is unanswered. A turn gets at most `maxSteersPerTurn` reminders.
 */
import { randomUUID } from 'node:crypto'
import { supersededByOf, type ChannelView, type ParsedMessage } from '@local-global/lg-protocol'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: the agent events live in dsh-agent.
import type {} from '@deepseek-ai/dsh-tools'
import { serviceOf } from './tools.js'

export const name = 'lg-checkpoint'
export const inject = ['agents']

export const DEFAULT_EVERY_MINUTES = 120
export const DEFAULT_POLL_SECONDS = 15
export const DEFAULT_MAX_STEERS = 3

/** The three questions, in the order a REVIEW answers them. */
export const CHECKPOINT_QUESTIONS = [
  '是否在真实目标环境里验证了用户真正看到的东西？',
  '当前工作是否在关键路径上？',
  '范围是否超出 TASK 的约束？',
] as const

/** Raw plugin config. */
export interface RawCheckpointConfig {
  readonly everyMinutes?: unknown
  readonly pollSeconds?: unknown
  readonly maxSteersPerTurn?: unknown
}

/** Resolved configuration. */
export interface CheckpointConfig {
  readonly everyMinutes: number
  readonly pollSeconds: number
  readonly maxSteersPerTurn: number
}

/**
 * Validate raw config and fill defaults.
 * @throws TypeError when a value is not usable.
 */
export function resolveCheckpointConfig(raw: RawCheckpointConfig = {}): CheckpointConfig {
  const positive = (value: unknown, fallback: number, label: string): number => {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError(`lg-checkpoint: "${label}" must be a positive number`)
    return value
  }
  const steers = raw.maxSteersPerTurn
  if (steers !== undefined && (typeof steers !== 'number' || !Number.isInteger(steers) || steers < 0)) {
    throw new TypeError('lg-checkpoint: "maxSteersPerTurn" must be a non-negative integer')
  }
  return {
    everyMinutes: positive(raw.everyMinutes, DEFAULT_EVERY_MINUTES, 'everyMinutes'),
    pollSeconds: positive(raw.pollSeconds, DEFAULT_POLL_SECONDS, 'pollSeconds'),
    maxSteersPerTurn: steers === undefined ? DEFAULT_MAX_STEERS : steers,
  }
}

/** Which of Q1..Q3 a REVIEW body does not answer; an answer is a line `Q<n>: <text>`. */
export function missingAnswers(body: string): number[] {
  const answered = new Set<number>()
  for (const match of body.matchAll(/^[ \t]*(?:[-*][ \t]+)?Q([123])[ \t]*[:：.)、-][ \t]*\S/gmu)) answered.add(Number(match[1]))
  return [1, 2, 3].filter((number) => !answered.has(number))
}

/** One unanswered global checkpoint. */
export interface GlobalCheckpoint {
  readonly id: string
  /** Sequence a REVIEW must cite in `refs`. */
  readonly anchor: string
  readonly reason: 'timer' | 'milestone'
  /** Whether the prompt reached the session yet. */
  delivered: boolean
}

/** The slice of the channel runtime this plugin reads. */
export interface ChannelLike {
  snapshot?: () => Promise<{ view: ChannelView }>
  readonly boundSessionId?: string | null
  /** Highest delivered sequence. */
  readonly cursor?: string
}

interface AgentLike {
  status?: string
  steer?: (message: unknown) => void
  followup?: (message: unknown) => void
}

/** What the runtime needs from its surroundings. */
export interface CheckpointDeps {
  readonly config: CheckpointConfig
  readonly channel: () => ChannelLike | undefined
  readonly agent: (sessionId: string) => AgentLike | undefined
  readonly now?: () => number
  readonly log?: (level: 'info' | 'warn', message: string) => void
}

/** A frozen user message, shaped like the one lg-channel hands to the agent. */
export function userMessage(text: string): unknown {
  return Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze([{ type: 'text', text }]), source: { kind: 'user' } })
}

/** The prompt that opens a global checkpoint. */
export function checkpointPrompt(checkpoint: GlobalCheckpoint): string {
  const why = checkpoint.reason === 'milestone' ? `Local 在 #${checkpoint.anchor} 报告了里程碑完成` : '定时检查点'
  return [
    `[LG 全局检查点 ${checkpoint.id}] ${why}。先停下手上的事，用 lg_review 发一条 REVIEW 回答三个问题：`,
    ...CHECKPOINT_QUESTIONS.map((question, index) => `Q${String(index + 1)}. ${question}`),
    `- refs 必须包含 "${checkpoint.anchor}"（本检查点的锚点）。`,
    '- body 里每个问题单独一行作答，格式 "Q1: ..."、"Q2: ..."、"Q3: ..."。',
    '- 答案暴露问题时 verdict 用 changes-requested 并写 finding；否则用 accepted。',
    '在这条 REVIEW 发出之前，每次结束回合都会被提醒。',
  ].join('\n')
}

/** Everything a Global turn still owes the channel. */
export interface OpenWork {
  readonly questions: readonly ParsedMessage[]
  readonly checkpointReports: readonly ParsedMessage[]
  readonly checkpoint?: GlobalCheckpoint
}

/** The reminder steered when a turn tries to stop. */
export function stoppingPrompt(work: OpenWork, lastReminder: boolean): string {
  const lines = [
    ...work.questions.map((message) => `- #${message.seq} ${message.type} 还没有 DECISION：用 lg_decision 回答（answers 填 "${message.seq}"）`),
    ...work.checkpointReports.map((message) => `- #${message.seq} 是请求审核的 checkpoint REPORT：用 lg_review 回复（refs 填 "${message.seq}"）`),
    ...(work.checkpoint === undefined ? [] : [`- 全局检查点 ${work.checkpoint.id} 还没有 REVIEW：refs 含 "${work.checkpoint.anchor}"，body 回答 Q1、Q2、Q3`]),
  ]
  return [
    'lg-checkpoint: 这个回合还不能结束——频道里有待处理的事项：',
    ...lines,
    '先处理再结束回合。',
    ...(lastReminder ? ['这是本回合最后一次提醒：如果确实无法处理，请在最终回复里写明原因。'] : []),
  ].join('\n')
}

/** Checkpoint state and the channel reads behind it; provided as the `lgCheckpoint` service. */
export class CheckpointRuntime {
  private current: GlobalCheckpoint | undefined
  private counter = 0
  private lastAt: number
  /** Highest sequence already examined for milestone REPORTs; unset until the first read. */
  private seen: string | undefined
  private busy = false

  constructor(private readonly deps: CheckpointDeps) {
    this.lastAt = this.now()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The unanswered global checkpoint, if any. */
  get pending(): GlobalCheckpoint | undefined {
    return this.current
  }

  /**
   * Why a REVIEW citing `refs` may not be sent, or undefined.
   * @param refs - the REVIEW's refs.
   * @param body - the REVIEW's body.
   */
  reviewProblem(refs: readonly string[], body: string): string | undefined {
    const checkpoint = this.current
    if (checkpoint === undefined || !refs.includes(checkpoint.anchor)) return undefined
    const missing = missingAnswers(body)
    if (missing.length === 0) return undefined
    return `global checkpoint ${checkpoint.id} (#${checkpoint.anchor}): the body must answer ${missing.map((number) => `Q${String(number)}`).join(', ')} on lines like "Q1: ..."`
  }

  private async read(): Promise<ChannelView | undefined> {
    const channel = this.deps.channel()
    if (channel?.snapshot === undefined) return undefined
    return (await channel.snapshot()).view
  }

  /** A Global REVIEW after the anchor, citing it and answering all three questions. */
  private answered(view: ChannelView, checkpoint: GlobalCheckpoint): boolean {
    return view.analysis.effective.some((message) => {
      if (message.sender !== 'global' || message.type !== 'REVIEW' || message.seq <= checkpoint.anchor) return false
      if (supersededByOf(view.analysis, message) !== undefined) return false
      const refs = message.fields['refs']
      return Array.isArray(refs) && refs.includes(checkpoint.anchor) && missingAnswers(message.body).length === 0
    })
  }

  private open(reason: GlobalCheckpoint['reason'], anchor: string): void {
    this.counter += 1
    this.current = { id: `CP-${String(this.counter)}`, anchor, reason, delivered: false }
    this.deps.log?.('info', `lg-checkpoint: ${this.current.id} opened (${reason}, anchor #${anchor})`)
  }

  private deliver(checkpoint: GlobalCheckpoint): void {
    const sessionId = this.deps.channel()?.boundSessionId
    if (typeof sessionId !== 'string') return
    const agent = this.deps.agent(sessionId)
    if (agent === undefined) return
    const message = userMessage(checkpointPrompt(checkpoint))
    if (agent.status === 'running') agent.steer?.(message)
    else agent.followup?.(message)
    checkpoint.delivered = true
    this.lastAt = this.now()
  }

  /**
   * One look at the channel: clear an answered checkpoint, open one for a new
   * milestone REPORT or a due timer, and (re)try delivery.
   */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const view = await this.read()
      if (view === undefined) return
      if (this.current !== undefined && this.answered(view, this.current)) {
        this.deps.log?.('info', `lg-checkpoint: ${this.current.id} answered`)
        this.current = undefined
        this.lastAt = this.now()
      }
      const live = view.analysis.effective.filter((message) => supersededByOf(view.analysis, message) === undefined)
      // The first read starts after what the channel already delivered, so history is not replayed.
      const from = this.seen ?? this.deps.channel()?.cursor ?? view.lastSeq
      const milestone = live.filter((message) => message.type === 'REPORT' && message.fields['checkpoint'] === true && message.seq > from).at(-1)
      this.seen = view.lastSeq
      if (this.current === undefined) {
        if (milestone !== undefined) this.open('milestone', milestone.seq)
        else if (view.lastSeq !== '0000' && this.now() - this.lastAt >= this.deps.config.everyMinutes * 60_000) this.open('timer', view.lastSeq)
      }
      if (this.current !== undefined && !this.current.delivered) this.deliver(this.current)
    } finally {
      this.busy = false
    }
  }

  /**
   * What a Global turn still owes the channel. Also clears an answered
   * checkpoint, so a REVIEW sent this very turn counts.
   */
  async openWork(): Promise<OpenWork | undefined> {
    const view = await this.read()
    if (view === undefined) return undefined
    if (this.current !== undefined && this.answered(view, this.current)) this.current = undefined
    return { questions: view.openQuestions, checkpointReports: view.pendingCheckpoints, ...(this.current === undefined ? {} : { checkpoint: this.current }) }
  }
}

interface TurnState {
  turn: number
  steers: number
}

/**
 * Compose the checkpoint timer and the turn-stopping gate.
 * @param ctx - plugin context.
 * @param raw - composition config.
 */
export function apply(ctx: Context, raw: RawCheckpointConfig = {}): void {
  const log = (level: 'info' | 'warn', message: string): void => {
    ;(ctx.logger?.('lg-checkpoint') as unknown as Record<string, ((text: string) => void) | undefined> | undefined)?.[level]?.(message)
  }
  let config: CheckpointConfig
  try {
    config = resolveCheckpointConfig(raw)
  } catch (error) {
    log('warn', `${error instanceof Error ? error.message : String(error)}; using the defaults`)
    config = resolveCheckpointConfig({})
  }
  const runtime = new CheckpointRuntime({
    config,
    channel: () => serviceOf<ChannelLike>(ctx, 'lgChannel'),
    agent: (sessionId) => (ctx as unknown as { agents?: { get?: (id: string) => AgentLike | undefined } }).agents?.get?.(sessionId),
    log,
  })

  ctx.effect(() => {
    const release = (ctx as unknown as { provide?: (name: string, value: unknown) => () => void }).provide?.('lgCheckpoint', runtime)
    const timer = setInterval(() => {
      void runtime.tick().catch((error: unknown) => log('warn', `tick failed: ${error instanceof Error ? error.message : String(error)}`))
    }, config.pollSeconds * 1000)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      release?.()
    }
  })

  const turns = new WeakMap<object, TurnState>()
  let warnedNoChannel = false
  ctx.on('agent/turn-stopping', async (payload: { agent: object; turn: number }) => {
    const { agent } = payload
    if (serviceOf<ChannelLike>(ctx, 'lgChannel')?.snapshot === undefined) {
      if (!warnedNoChannel) {
        warnedNoChannel = true
        log('warn', 'lg-checkpoint: lg-channel is not composed, so there is nothing to check; the gate is inactive (install @local-global/dsh-lg-common)')
      }
      return
    }
    const previous = turns.get(agent)
    const state: TurnState = previous !== undefined && previous.turn === payload.turn ? previous : { turn: payload.turn, steers: 0 }
    turns.set(agent, state)

    let work: OpenWork | undefined
    try {
      work = await runtime.openWork()
    } catch (error) {
      log('warn', `lg-checkpoint: the channel cannot be read (${error instanceof Error ? error.message : String(error)}); not holding the turn`)
      return
    }
    if (work === undefined || (work.questions.length === 0 && work.checkpointReports.length === 0 && work.checkpoint === undefined)) return

    state.steers += 1
    if (state.steers > config.maxSteersPerTurn) {
      log('warn', `lg-checkpoint: ending turn ${String(payload.turn)} with open work after ${String(config.maxSteersPerTurn)} reminder(s)`)
      return
    }
    ;(agent as AgentLike).steer?.(userMessage(stoppingPrompt(work, state.steers === config.maxSteersPerTurn)))
  })
}
