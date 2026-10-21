/**
 * `lg-channel` — the git channel transport for one side of a Local–Global pair.
 *
 * Implements docs/channel-git.md: fetch the branch, deliver new messages into
 * the bound session, and append messages as one commit each.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  type Approval,
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

/** One byte-level difference between the archive and this side's saved copy. */
export interface SentCopyMismatch {
  readonly filename: string
  readonly reason: string
}

/**
 * Whether a message wakes a Global session (SPEC "投递").
 *
 * Only these open a turn: a checkpoint REPORT, a blocking QUESTION, an
 * OBJECTION, a TASK or a HALT. Everything else is injected as context without
 * waking the driver (CH-4).
 * @param message - the message about to be delivered.
 * @returns true when the Global side must start a turn for it.
 */
export function wakesGlobal(message: ParsedMessage): boolean {
  if (message.type === 'TASK' || message.type === 'HALT' || message.type === 'OBJECTION') return true
  if (message.type === 'QUESTION' && message.fields['blocking'] === true) return true
  if (message.type === 'REPORT' && message.fields['checkpoint'] === true) return true
  return false
}

/** Live channel shared by `lg-channel` and `lg-commands` in one process. */
export class ChannelRuntime {
  readonly ctx: Context
  readonly config: ChannelConfig
  readonly repo: ChannelRepo
  private readonly store: StateStore
  /** Copies of every message this side wrote, keyed by its file name (CH-12). */
  private readonly sentDir: string
  private state: PersistedState
  /** Approval table derived from the last fetch (see {@link approvals}). */
  private approvalCache: Approval[] = []
  private polling = false
  private reportedMismatch = new Set<string>()

  constructor(ctx: Context, config: ChannelConfig) {
    this.ctx = ctx
    this.config = config
    this.repo = new ChannelRepo(config.cloneDir, config.repo, config.branch)
    this.store = new StateStore(join(config.stateDir, `${config.slug}.json`), config.legacyStateFile)
    this.sentDir = join(config.stateDir, 'sent')
    this.state = initialState(config.repo, config.role)
  }

  /**
   * Save the exact bytes of a message this side just wrote (CH-12).
   * @param filename - the archived file name, also used as the copy's key.
   * @param text - the complete message text, byte for byte.
   */
  async saveSentCopy(filename: string, text: string): Promise<void> {
    await mkdir(this.sentDir, { recursive: true })
    await writeFile(join(this.sentDir, filename), text, 'utf8')
  }

  /** Read back a saved copy; `undefined` when this side never wrote that file. */
  async sentCopyOf(filename: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.sentDir, filename), 'utf8')
    } catch {
      return undefined
    }
  }

  /**
   * Compare every archived message this side sent against its saved copy.
   *
   * A copy that exists and differs is a mismatch — that is the tamper case
   * the SPEC's IN-3 pauses on. An own message with no copy at all (written
   * before this side started keeping copies) is reported separately by
   * {@link uncopiedOwnMessages} so it cannot mask a tamper.
   * @returns one entry per differing or missing copy.
   */
  async verifySentCopies(): Promise<SentCopyMismatch[]> {
    const out: SentCopyMismatch[] = []
    for (const filename of await this.repo.listMessages()) {
      const text = await this.repo.readFile(`messages/${filename}`)
      if (text === undefined) continue
      const parsed = parseMessage(filename, text)
      if (!parsed.ok) continue
      if (parsed.message.sender !== this.config.role) continue
      const copy = await this.sentCopyOf(filename)
      if (copy === undefined) continue
      if (copy !== text) {
        out.push({
          filename,
          reason: `archived bytes differ from the saved copy (copy ${String(Buffer.byteLength(copy, 'utf8'))}B, archive ${String(Buffer.byteLength(text, 'utf8'))}B)`,
        })
      }
    }
    return out
  }

  /** Own messages the archive holds but this side has no copy of. */
  async uncopiedOwnMessages(): Promise<string[]> {
    const out: string[] = []
    for (const filename of await this.repo.listMessages()) {
      const text = await this.repo.readFile(`messages/${filename}`)
      if (text === undefined) continue
      const parsed = parseMessage(filename, text)
      if (!parsed.ok) continue
      if (parsed.message.sender !== this.config.role) continue
      if ((await this.sentCopyOf(filename)) === undefined) out.push(filename)
    }
    return out
  }

  /** Prepare the mirror and load persisted state. */
  async start(): Promise<void> {
    if (await this.store.migrate()) {
      this.ctx.logger?.('lg-channel')?.info?.(`lg-channel: adopted the pre-SPEC state file at ${String(this.config.legacyStateFile)}`)
    }
    this.state = await this.store.load(this.config.repo, this.config.role)
    await this.repo.ensure()
  }

  /**
   * Unused approvals, as maintained **in memory** from our own fetches.
   *
   * SPEC "lg-action-gate" (AG-2) is explicit that the guard reads a table the
   * channel keeps, not the channel repository: a guard is synchronous and must
   * never do I/O, and a repo read would also be a fresh, spoofable read.
   * @returns the approvals that no REPORT has consumed yet.
   */
  approvals(): readonly Approval[] {
    return [...this.approvalCache]
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
   *
   * The first bind starts the cursor at the channel's newest message, so a
   * session never receives the history that accumulated before it joined. A
   * later bind (another session on the same side) keeps the cursor and so
   * neither replays nor drops anything.
   * @param sessionId - session identity of the invoking agent.
   */
  async bind(sessionId: string): Promise<void> {
    const patch: { boundSessionId: string; cursor?: string } = { boundSessionId: sessionId }
    if (this.state.boundSessionId === null) {
      await this.repo.fetch()
      const messages = await this.all()
      const newest = messages.at(-1)
      if (newest !== undefined) patch.cursor = newest.seq
    }
    await this.persist(patch)
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
      this.refreshApprovals()
      await this.reportSentCopyMismatches()
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

  /**
   * Post one ISOLATION_REPORT per newly seen lost-integrity finding (CH-12).
   *
   * Runs after the fetch so it sees the archive as it stands; each file is
   * reported at most once per process, so a tampered message does not spam.
   */
  private async reportSentCopyMismatches(): Promise<void> {
    const mismatches = await this.verifySentCopies()
    const fresh = mismatches.filter((entry) => !this.reportedMismatch.has(entry.filename))
    if (fresh.length === 0) return
    for (const entry of fresh) this.reportedMismatch.add(entry.filename)
    try {
      await this.post({
        type: 'ISOLATION_REPORT',
        fields: {
          probes: fresh.map((entry) => ({
            name: `sent-copy:${entry.filename}`,
            expected: 'archive equals the saved copy',
            actual: entry.reason,
            pass: false,
          })),
        },
        body: `本侧自己发出的消息在频道存档里与发件副本不一致（CH-12）。\n\n${fresh.map((e) => `- messages/${e.filename}: ${e.reason}`).join('\n')}`,
      })
    } catch {
      // Reporting must never take the poll loop down; the mismatch stays visible
      // through lg_integrity_check (IN-3).
    }
  }

  /** Deliver one message; returns false when nothing was delivered (own message). */
  private async deliverOne(agent: Agent, filename: string, seq: string): Promise<boolean> {
    const text = await this.repo.readFile(`messages/${filename}`)
    if (text === undefined) return false
    const parsed = parseMessage(filename, text)
    if (!parsed.ok) {
      this.deliver(agent, `[LG INVALID #${seq}] ${parsed.errors.map((error) => error.message).join('; ')}`)
      return true
    }
    const errors = validateMessage(parsed.message)
    if (errors.length > 0) {
      this.deliver(agent, `[LG INVALID #${seq}] ${errors.map((error) => error.message).join('; ')}`)
      return true
    }
    if (parsed.message.sender === this.config.role) return false

    // CH-9: an id already handed to the session is never delivered twice, even
    // after a cursor reset or a restart.
    const id = parsed.message.fields['id']
    if (typeof id === 'string' && this.state.deliveredIds.includes(id)) return false

    // CH-10: a superseded message is shown as superseded and must not be run.
    // Name the message that replaces this one, not this one's own id.
    const everyMessage = await this.all()
    const replacer = everyMessage.find((message) =>
      Array.isArray(message.fields['supersedes']) && typeof id === 'string' && message.fields['supersedes'].includes(id),
    )
    const dead = replacer !== undefined
    if (typeof id === 'string') await this.persist({ deliveredIds: [...this.state.deliveredIds, id] })
    if (dead) {
      const by = replacer?.fields['id'] ?? replacer?.seq ?? 'a newer message'
      this.deliver(agent, `[LG #${seq} ${parsed.message.type} SUPERSEDED by ${String(by)}] 不要执行。\n${this.renderDelivery(parsed.message, text)}`)
      return true
    }
    if (parsed.message.type === 'HALT') {
      agent.cancel({ kind: 'user' })
      this.deliver(agent, this.renderDelivery(parsed.message, text))
      await this.persist({ halted: true })
      return true
    }
    // CH-4: the Global side only opens a turn for wake-class messages; anything
    // else goes into the context without waking the driver.
    if (this.config.role === 'global' && !wakesGlobal(parsed.message)) {
      agent.inject(this.messageFor(this.renderDelivery(parsed.message, text)))
      return true
    }
    this.deliver(agent, this.renderDelivery(parsed.message, text))
    return true
  }

  /** Render one message the way the model sees it. */
  private renderDelivery(message: ParsedMessage, text: string): string {
    const newline = text.indexOf('\n')
    const rest = newline === -1 ? '' : text.slice(newline + 1)
    return `${deliveryLabel(message)}\n${rest}`
  }

  /** Hand one user-role message to the agent: steer while it runs, follow up when idle. */
  /** Build the frozen user message the agent inbox takes. */
  private messageFor(body: string): UserMessage {
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
    return message
  }

  /** Hand one user-role message to the agent: steer while it runs, follow up when idle. */
  private deliver(agent: Agent, body: string): void {
    const message = this.messageFor(body)
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
  /**
   * Refuse a REPORT whose cited manifests have gone stale (EV-4).
   *
   * Read through the `lgEvidence` service, so lg-channel needs no dependency on
   * dsh-lg-local. A missing service simply means no evidence plugin is composed.
   * @param input - the message about to be written.
   */
  private assertEvidenceFresh(input: PostInput): void {
    if (input.type !== 'REPORT') return
    const evidence = input.fields['evidence']
    if (!Array.isArray(evidence)) return
    const service = (this.ctx as unknown as { get?: (name: string) => unknown }).get?.('lgEvidence') as
      | { staleTopics?: () => string[] }
      | undefined
    if (service?.staleTopics === undefined) return
    const stale = service.staleTopics()
    if (stale.length === 0) return
    // Topics may nest (`M3/ev-real`), so take everything after `evidence/`
    // minus a trailing `/manifest.json` — a depth-1 split used to yield `M3`
    // and silently match nothing.
    const cited = evidence
      .filter((path): path is string => typeof path === 'string')
      .map((path) => path.replace(/^.*?evidence\//, '').replace(/\/manifest\.json$/, ''))
      .filter((topic) => topic.length > 0 && !topic.includes('..'))
    const bad = cited.filter((topic) => stale.includes(topic))
    if (bad.length > 0) {
      throw new Error(`lg-post: refusing a REPORT that cites stale evidence: ${bad.join(', ')} (digest moved; re-run the claim)`)
    }
  }

  async postAs(sender: Sender, input: PostInput): Promise<PostResult> {
    const fields = { ...input.fields }
    if (input.refs !== undefined && fields['refs'] === undefined) fields['refs'] = [...input.refs]
    const body = input.body ?? ''
    this.probe(sender, input.type, fields, body)
    this.assertEvidenceFresh(input)
    const result = await this.repo.append((seq) => {
      const rendered = formatMessage({ seq, sender, type: input.type, fields, body })
      return { sender, type: input.type, filename: rendered.filename, text: rendered.text }
    })
    await this.saveSentCopy(result.filename, await this.renderedAgain(sender, input.type, fields, body, result.seq))
    return result
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
    const result = await this.repo.append((seq) => ({
      sender,
      type,
      filename: `${seq}-${sender}-${type}.md`,
      text,
    }))
    await this.saveSentCopy(result.filename, text)
    return result
  }

  /** Re-render a posted message so the saved copy holds the archived bytes. */
  private async renderedAgain(
    sender: Sender,
    type: MessageType,
    fields: Readonly<Record<string, unknown>>,
    body: string,
    seq: string,
  ): Promise<string> {
    return formatMessage({ seq, sender, type, fields, body }).text
  }

  /**
   * Post one ISOLATION_REPORT on this side's behalf, without a model.
   *
   * SPEC "lg-integrity": the startup result is sent through the channel's own
   * interface, so the report exists even if the model never runs a tool.
   * @param probes - one entry per check that ran.
   * @param body - optional markdown body.
   * @returns the posted message, or `undefined` when nothing was sent.
   */
  async reportIsolation(probes: readonly unknown[], body?: string): Promise<PostResult | undefined> {
    if (this.config.role === undefined) return undefined
    return await this.post({
      type: 'ISOLATION_REPORT',
      fields: { probes },
      ...(body === undefined ? {} : { body }),
    })
  }

  /**
   * Read one attachment byte-exactly.
   *
   * PATCH attachments carry a `sha256` in their message, so the bytes matter
   * and the utf8 path is not good enough (PA-1).
   * @param path - path inside the channel repo, e.g. `attachments/0004/x.patch`.
   * @returns the bytes, or `undefined` when the path is absent.
   */
  async readAttachment(path: string): Promise<Buffer | undefined> {
    return await this.repo.readBytes(path)
  }

  /** Recompute the in-memory approval table from the messages we just fetched. */
  private refreshApprovals(): void {
    void this.all()
      .then((messages) => {
        this.approvalCache = [...foldState(messages).approvals]
      })
      .catch(() => {
        // A failed refresh leaves the previous table: approvals become neither
        // more nor less permissive on a transient fetch error.
      })
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
    // Expose the runtime so lg-integrity (a different bundle) can run the
    // CH-12 byte comparison without importing this package.
    const release = (ctx as unknown as { provide?: (name: string, value: unknown) => () => void }).provide?.('lgChannel', runtime)
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
      release?.()
      if (active === runtime) active = undefined
    }
  })
}
