/**
 * `lg-channel` — the git channel transport for one side of a Local–Global pair.
 *
 * Implements docs/channel-git.md: fetch the branch, deliver new messages into
 * the bound session, and append messages as one commit each.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Module augmentations only: `ctx.tools` lives in dsh-tools, `agent.*` in dsh-agent.
import type {} from '@deepseek-ai/dsh-tools'
import {
  ALLOWED_SENDERS,
  deliveryLabel,
  foldState,
  formatMessage,
  parseMessage,
  validateMessage,
  type MessageError,
  type MessageType,
  type ParsedMessage,
  type Sender,
} from '@local-global/lg-protocol'
import { resolveChannelConfig, type ChannelConfig, type RawChannelConfig } from './config.js'
import { ChannelRepo } from './git.js'
import { StateStore, initialState, type PersistedState } from './state.js'

/** A rejected channel operation, carrying the rule violations that caused it. */
export class ChannelError extends Error {
  readonly code: string
  readonly details: readonly MessageError[]

  constructor(code: string, message: string, details: readonly MessageError[] = []) {
    super(message)
    this.name = 'ChannelError'
    this.code = code
    this.details = details
  }
}

/** Input to {@link ChannelRuntime.post}. */
export interface PostInput {
  readonly type: MessageType
  readonly fields: Readonly<Record<string, unknown>>
  readonly body?: string
  readonly refs?: readonly string[]
}

/** What appending produced. */
export interface PostResult {
  readonly seq: string
  readonly filename: string
  readonly commit: string
}

/** Live channel shared by `lg-channel` and `lg-commands` in one process. */
export class ChannelRuntime {
  readonly ctx: Context
  readonly config: ChannelConfig
  readonly repo: ChannelRepo
  private readonly store: StateStore
  private state: PersistedState
  private polling = false

  constructor(ctx: Context, config: ChannelConfig) {
    this.ctx = ctx
    this.config = config
    this.repo = new ChannelRepo(config.cloneDir, config.repo, config.branch)
    this.store = new StateStore(join(config.stateDir, `${config.slug}.json`))
    this.state = initialState(config.repo, config.role)
  }

  /** Prepare the mirror and load persisted state. */
  async start(): Promise<void> {
    this.state = await this.store.load(this.config.repo, this.config.role)
    await this.repo.ensure()
  }

  /** Highest delivered sequence. */
  get cursor(): string {
    return this.state.cursor
  }

  /** Whether a human HALT has been delivered. */
  get halted(): boolean {
    return this.state.halted
  }

  /** The bound session, if any. */
  get boundSessionId(): string | null {
    return this.state.boundSessionId
  }

  /**
   * Bind the session that channel messages are delivered to.
   * @param sessionId - session identity of the invoking agent.
   */
  async bind(sessionId: string): Promise<void> {
    await this.persist({ boundSessionId: sessionId })
  }

  /** The live agent this side delivers to, when the bound session is running. */
  private boundAgent(): Agent | undefined {
    const sessionId = this.state.boundSessionId
    if (sessionId === null) return undefined
    // The stored id is a plain string; the registry keys agents by the branded
    // SessionId, whose brand exists only in the type system.
    return this.ctx.agents.get(sessionId as SessionId)
  }

  private async persist(patch: Partial<PersistedState>): Promise<void> {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() }
    await this.store.save(this.state)
  }

  /**
   * Deliver every message after the cursor, then advance it.
   *
   * The cursor moves only after a message was handed to the agent, so a
   * restart neither loses nor repeats a message (§7).
   */
  async poll(): Promise<void> {
    if (this.polling || this.state.halted) return
    const agent = this.boundAgent()
    if (agent === undefined) return
    this.polling = true
    try {
      await this.repo.fetch()
      for (const filename of await this.repo.listMessages()) {
        const seq = filename.slice(0, 4)
        if (!/^\d{4}$/.test(seq) || seq <= this.state.cursor) continue
        const delivered = await this.deliverOne(agent, filename, seq)
        if (!delivered) continue
        await this.persist({ cursor: seq })
        if (this.state.halted) break
      }
    } finally {
      this.polling = false
    }
  }

  /** Deliver one message; returns false when nothing was delivered (own message). */
  private async deliverOne(agent: Agent, filename: string, seq: string): Promise<boolean> {
    const text = await this.repo.readFile(`messages/${filename}`)
    if (text === undefined) return false
    const parsed = parseMessage(filename, text)
    if (!parsed.ok) {
      this.inject(agent, `[LG INVALID #${seq}] ${parsed.errors.map((error) => error.message).join('; ')}`)
      return true
    }
    const errors = validateMessage(parsed.message)
    if (errors.length > 0) {
      this.inject(agent, `[LG INVALID #${seq}] ${errors.map((error) => error.message).join('; ')}`)
      return true
    }
    if (parsed.message.sender === this.config.role) return false
    if (parsed.message.type === 'HALT') {
      agent.cancel({ kind: 'user' })
      this.inject(agent, this.renderDelivery(parsed.message, text))
      await this.persist({ halted: true })
      return true
    }
    this.inject(agent, this.renderDelivery(parsed.message, text))
    return true
  }

  /** Render one message the way the model sees it. */
  private renderDelivery(message: ParsedMessage, text: string): string {
    const newline = text.indexOf('\n')
    const rest = newline === -1 ? '' : text.slice(newline + 1)
    return `${deliveryLabel(message)}\n${rest}`
  }

  /** Hand one user-role message to the agent: steer while it runs, follow up when idle. */
  private inject(agent: Agent, body: string): void {
    // Built here rather than with dsh-llm's createUserMessage: the bundle keeps
    // no runtime dependency on the harness packages (the profile does not
    // install peer dependencies), so the only cast is the MessageId brand,
    // which is a string at runtime.
    const message: UserMessage = Object.freeze({
      id: randomUUID() as UserMessage['id'],
      role: 'user',
      content: Object.freeze([{ type: 'text' as const, text: body }]),
      source: { kind: 'user' as const },
    })
    if (agent.status === 'running') agent.steer(message)
    else agent.followup(message)
  }

  /** Validate a message locally before it is rendered into a commit. */
  private probe(sender: Sender, type: MessageType, fields: Readonly<Record<string, unknown>>, body: string): ParsedMessage {
    const allowed = ALLOWED_SENDERS[type]
    if (!allowed.includes(sender)) {
      throw new ChannelError('sender-not-allowed', `${sender} may not send ${type}; allowed senders are ${allowed.join(', ')}`)
    }
    const rendered = formatMessage({ seq: '9999', sender, type, fields, body })
    const parsed = parseMessage(rendered.filename, rendered.text)
    if (!parsed.ok) throw new ChannelError('invalid-message', parsed.errors.map((error) => error.message).join('; '), parsed.errors)
    const errors = validateMessage(parsed.message)
    if (errors.length > 0) throw new ChannelError('invalid-message', errors.map((error) => error.message).join('; '), errors)
    return parsed.message
  }

  /**
   * Append one message as this side's role and push it.
   * @param input - type, fields, body, and optional refs.
   * @returns the sequence, file name, and commit that landed.
   */
  async post(input: PostInput): Promise<PostResult> {
    return await this.postAs(this.config.role as Sender, input)
  }

  /**
   * Append one message under an explicit identity.
   *
   * Only `/lg-halt` uses this, to speak as `human` in a channel this side
   * otherwise writes as its role.
   * @param sender - identity to declare; must be allowed for the type.
   * @param input - type, fields, body, and optional refs.
   * @returns the sequence, file name, and commit that landed.
   */
  async postAs(sender: Sender, input: PostInput): Promise<PostResult> {
    const fields = { ...input.fields }
    if (input.refs !== undefined && fields['refs'] === undefined) fields['refs'] = [...input.refs]
    const body = input.body ?? ''
    this.probe(sender, input.type, fields, body)
    return await this.repo.append((seq) => {
      const rendered = formatMessage({ seq, sender, type: input.type, fields, body })
      return { sender, type: input.type, filename: rendered.filename, text: rendered.text }
    })
  }

  /**
   * Archive a relayed message byte-for-byte (§8).
   * @param text - the complete message text exactly as relayed.
   * @returns the sequence, file name, and commit that landed.
   */
  async recordRelayed(text: string): Promise<PostResult> {
    if (!this.config.relay) {
      throw new ChannelError('relay-disabled', 'lg_record_relayed requires lg-channel config relay: true')
    }
    const firstLine = (text.split('\n')[0] ?? '').replace(/\r$/, '')
    const header = /^\[LG ([A-Z_]+) from (human|global|local)\]$/.exec(firstLine)
    if (header === null) {
      throw new ChannelError('invalid-message', 'relayed text must start with [LG <TYPE> from <human|global|local>]')
    }
    const type = header[1] as MessageType
    const sender = header[2] as Sender
    if (sender !== 'global' && sender !== 'human') {
      throw new ChannelError('relay-sender', 'relayed text must come from global or human, not from this side')
    }
    // §8: archive first, judge later. Only the header is required, because the
    // file name is built from it; field-level problems are left for readers to
    // report as [LG INVALID #<seq>] (that is how a new message type can be
    // relayed before this side knows how to validate it).
    const parsed = parseMessage(`9999-${sender}-${type}.md`, text)
    if (!parsed.ok) throw new ChannelError('invalid-message', parsed.errors.map((error) => error.message).join('; '), parsed.errors)
    return await this.repo.append((seq) => ({
      sender,
      type,
      filename: `${seq}-${sender}-${type}.md`,
      text,
    }))
  }

  /** Every parsed message, ascending. */
  async all(): Promise<ParsedMessage[]> {
    const messages: ParsedMessage[] = []
    for (const filename of await this.repo.listMessages()) {
      const text = await this.repo.readFile(`messages/${filename}`)
      if (text === undefined) continue
      const parsed = parseMessage(filename, text)
      if (parsed.ok) messages.push(parsed.message)
    }
    return messages
  }

  /**
   * Read messages in an inclusive sequence range.
   * @param from - first sequence, default `0001`.
   * @param to - last sequence, default the newest.
   * @returns the matching messages.
   */
  async readRange(from = '0001', to = '9999'): Promise<ParsedMessage[]> {
    return (await this.all()).filter((message) => message.seq >= from && message.seq <= to)
  }

  /** Unanswered QUESTION and OBJECTION messages. */
  async openQuestions(): Promise<readonly ParsedMessage[]> {
    return foldState(await this.all()).openQuestions
  }

  /** One-line status for `/lg-status`. */
  async statusText(): Promise<string> {
    const state = foldState(await this.all())
    const open = state.openQuestions.map((message) => message.seq)
    return [
      `repo: ${this.config.repo}#${this.config.branch}`,
      `role: ${this.config.role}`,
      `bound session: ${this.state.boundSessionId ?? '(none — run /lg-bind)'}`,
      `cursor: ${this.state.cursor}`,
      `channel max: ${state.lastSeq}`,
      `directive: ${state.directive === undefined ? '(none)' : `v${String(state.directive.fields['version'])} (#${state.directive.seq})`}`,
      `open questions: ${open.length === 0 ? '(none)' : open.join(', ')}`,
      `halted: ${String(this.state.halted)}`,
    ].join('\n')
  }
}

/** The runtime installed by the most recent `lg-channel` load, for `lg-commands`. */
let active: ChannelRuntime | undefined

/** The live channel, when `lg-channel` is composed. */
export function activeChannel(): ChannelRuntime | undefined {
  return active
}

function warn(ctx: Context, message: string): void {
  try {
    ctx.logger?.('lg-channel')?.warn?.(message)
  } catch {
    // Logging must never take the plugin down.
  }
}

/** Cordis plugin name. */
export const name = 'lg-channel'

/** Services this plugin reads. */
export const inject = ['tools', 'agents']

type ToolDefinition = Parameters<Context['tools']['register']>[0]

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

/**
 * Compose the channel: register `lg_*` tools and start the poll loop.
 * @param ctx - plugin context.
 * @param raw - composition config.
 */
export function apply(ctx: Context, raw: RawChannelConfig): void {
  const config = resolveChannelConfig(raw)
  const runtime = new ChannelRuntime(ctx, config)
  active = runtime

  const postable = ALLOWED_SENDERS
  const typesForRole = (Object.keys(postable) as MessageType[]).filter((type) => postable[type].includes(config.role as Sender))

  ctx.tools.register({
    name: 'lg_post',
    description: 'Append one message to the Local–Global channel and push it as a single commit.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: typesForRole, description: 'Message type this role may send.' },
        fields: { type: 'object', description: 'Message field region as a JSON object.' },
        body: { type: 'string', description: 'Optional Markdown body after the --- terminator.' },
        refs: { type: 'array', items: { type: 'string' }, description: 'Four-digit sequences this message references.' },
        supersedes: { type: 'array', items: { type: 'string' }, description: 'Sequences this message replaces.' },
      },
      required: ['type'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { seq: { type: 'string' }, filename: { type: 'string' }, commit: { type: 'string' } },
        required: ['seq', 'filename', 'commit'],
      },
      render: (_args: unknown, value: { seq: string; filename: string; commit: string }) => [
        textBlock(`posted ${value.filename} as ${value.commit.slice(0, 12)}`),
      ],
    },
    async execute(args: { type: MessageType; fields?: Record<string, unknown>; body?: string; refs?: string[]; supersedes?: string[] }) {
      const fields = { ...(args.fields ?? {}) }
      if (args.supersedes !== undefined) fields['supersedes'] = args.supersedes
      return await runtime.post({ type: args.type, fields, ...(args.body === undefined ? {} : { body: args.body }), ...(args.refs === undefined ? {} : { refs: args.refs }) })
    },
  } as ToolDefinition)

  ctx.tools.register({
    name: 'lg_record_relayed',
    description: 'Archive a relayed Local–Global message byte-for-byte and push it. Only available when relay mode is on.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The complete message text, exactly as relayed.' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { seq: { type: 'string' }, filename: { type: 'string' }, commit: { type: 'string' } },
        required: ['seq', 'filename', 'commit'],
      },
      render: (_args: unknown, value: { filename: string }) => [textBlock(`archived ${value.filename}`)],
    },
    async execute(args: { text: string }) {
      return await runtime.recordRelayed(args.text)
    },
  } as ToolDefinition)

  ctx.tools.register({
    name: 'lg_read',
    description: 'Read channel messages by sequence range.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First sequence, default 0001.' },
        to: { type: 'string', description: 'Last sequence, default newest.' },
      },
    },
    output: {
      schema: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      render: (_args: unknown, value: { text: string }[]) => [textBlock(value.map((item) => item.text).join('\n\n') || '(no messages)')],
    },
    async execute(args: { from?: string; to?: string }) {
      const messages = await runtime.readRange(args.from ?? '0001', args.to ?? '9999')
      return messages.map((message) => ({ text: message.raw }))
    },
  } as ToolDefinition)

  ctx.tools.register({
    name: 'lg_open_questions',
    description: 'List QUESTION and OBJECTION messages that no DECISION has answered yet.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      render: (_args: unknown, value: { text: string }[]) => [textBlock(value.map((item) => item.text).join('\n') || '(none open)')],
    },
    async execute() {
      const questions = await runtime.openQuestions()
      return questions.map((message) => ({ text: `#${message.seq} ${message.type} from ${message.sender}` }))
    },
  } as ToolDefinition)

  ctx.effect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    let disposed = false
    void (async () => {
      try {
        await runtime.start()
      } catch (error) {
        warn(ctx, `start failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (disposed) return
      const tick = (): void => {
        void runtime.poll().catch((error: unknown) => {
          warn(ctx, `poll failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      timer = setInterval(tick, config.pollSeconds * 1000)
      tick()
    })()
    return () => {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
      if (active === runtime) active = undefined
    }
  })
}
