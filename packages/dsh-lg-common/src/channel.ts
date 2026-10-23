/**
 * `lg-channel` — the git channel transport for one side of a Local–Global pair.
 *
 * Implements docs/channel-git.md: fetch the branch, deliver new messages into
 * the bound session, and append messages as one commit each.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Module augmentations only: `ctx.tools` lives in dsh-tools, `agent.*` in dsh-agent.
import type {} from '@deepseek-ai/dsh-tools'
import {
  ALLOWED_SENDERS,
  ID_PREFIX,
  ID_RE,
  attachmentNameProblem,
  deliveryLabel,
  foldChannel,
  formatMessage,
  highestIdCounter,
  isHumanHalt,
  nextId,
  parseFilename,
  parseMessage,
  supersededByOf,
  validateMessage,
  type Approval,
  type ChannelView,
  type MessageError,
  type MessageType,
  type ParsedMessage,
  type ParseResult,
  type Sender,
} from '@local-global/lg-protocol'
import { resolveChannelConfig, type ChannelConfig, type RawChannelConfig } from './config.js'
import { ChannelRepo, type AppendAttachment } from './git.js'
import { redactSecrets } from './redact.js'
import { StateStore, initialState, type PersistedState } from './state.js'

/** A rejected channel operation, carrying the rule violations that caused it. */
export class ChannelError extends Error {
  readonly code: string
  readonly details: readonly MessageError[]

  constructor(code: string, message: string, details: readonly MessageError[] = []) {
    super(redactSecrets(message))
    this.name = 'ChannelError'
    this.code = code
    this.details = details
  }
}

/** One file to commit under `attachments/<seq>/` together with a message. */
export interface AttachmentInput {
  /** A plain file name; separators and dot-names are refused. */
  readonly name: string
  readonly content: string | Uint8Array
  /** How a string `content` is decoded; utf8 by default. */
  readonly encoding?: 'utf8' | 'base64'
}

/** Input to {@link ChannelRuntime.post}. */
export interface PostInput {
  readonly type: MessageType
  readonly fields: Readonly<Record<string, unknown>>
  readonly body?: string
  readonly refs?: readonly string[]
  readonly attachments?: readonly AttachmentInput[]
}

/** What appending produced. */
export interface PostResult {
  readonly seq: string
  readonly filename: string
  readonly commit: string
  /** The message id: generated when the input had none (CH-7). */
  readonly id: string
}

/** What archiving a relayed message produced (§8). */
export interface RelayResult {
  readonly seq: string
  readonly filename: string
  readonly commit: string
  readonly id?: string
  /** True when the id was already in the channel, so no file was created. */
  readonly duplicate: boolean
  /** For a duplicate: whether the existing file holds the same bytes. */
  readonly identical?: boolean
}

/** One byte-level difference between the archive and this side's saved copy. */
export interface SentCopyMismatch {
  readonly filename: string
  readonly reason: string
  /** Stable key (`<file>@<archive digest>`) so a report is made once per distinct state. */
  readonly key?: string
}

/** One thing a reader still has to act on (SPEC CM-1, `lg_open_questions`). */
export interface OpenItem {
  readonly kind: 'question' | 'objection' | 'finding' | 'checkpoint'
  /** Sequence of the message, or `<review>/<finding>` for a finding. */
  readonly ref: string
  readonly text: string
}

/** One archived message file, byte-exact. */
export interface ArchivedFile {
  readonly filename: string
  readonly bytes: Buffer
  readonly text: string
}

/** The archive read once at one commit, with everything derived from it. */
export interface ChannelSnapshot {
  readonly head: string | undefined
  readonly files: readonly ArchivedFile[]
  readonly parsed: ReadonlyMap<string, ParseResult>
  /** Every message that parsed, ascending. */
  readonly messages: readonly ParsedMessage[]
  /** State folded from valid, effective messages only. */
  readonly view: ChannelView
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

const SENT_COPY_NAME_RE = /^\d{4}-(?:human|global|local)-[A-Z_]+\.md$/u
const RELAY_HEADER_RE = /^\[LG ([A-Z_]+) from (human|global|local)\]$/u
const RELAY_ID_RE = /^id:[ \t]*['"]?([GLH]-\d{4,})['"]?[ \t]*$/mu
const HALT_PREVIEW_CHARS = 4000

/** Pull the `id` out of message text, tolerating a field region that is not valid YAML. */
function idOfText(filename: string, text: string): string | undefined {
  const parsed = parseMessage(filename, text)
  if (parsed.ok) {
    const id = parsed.message.fields['id']
    return typeof id === 'string' && ID_RE.test(id) ? id : undefined
  }
  const region = text.split(/^---\r?$/mu, 1)[0] ?? ''
  return RELAY_ID_RE.exec(region)?.[1]
}

function normalizeAttachments(input: readonly AttachmentInput[] | undefined): AppendAttachment[] {
  const out: AppendAttachment[] = []
  const seen = new Set<string>()
  for (const item of input ?? []) {
    const problem = attachmentNameProblem(item.name)
    if (problem !== undefined) throw new ChannelError('invalid-attachment', `${problem}: ${JSON.stringify(item.name)}`)
    if (seen.has(item.name)) throw new ChannelError('invalid-attachment', `attachment "${item.name}" is listed twice`)
    seen.add(item.name)
    let content: Uint8Array
    if (typeof item.content !== 'string') content = item.content
    else if (item.encoding === 'base64') {
      if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(item.content) || item.content.length % 4 !== 0) {
        throw new ChannelError('invalid-attachment', `attachment "${item.name}" is not valid base64`)
      }
      content = Buffer.from(item.content, 'base64')
    } else content = Buffer.from(item.content, 'utf8')
    out.push({ name: item.name, content })
  }
  return out
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
  private saveChain: Promise<void> = Promise.resolve()

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
  async saveSentCopy(filename: string, text: string | Uint8Array): Promise<void> {
    if (!SENT_COPY_NAME_RE.test(filename)) throw new ChannelError('invalid-message', `not a message file name: ${JSON.stringify(filename)}`)
    await mkdir(this.sentDir, { recursive: true })
    await writeFile(join(this.sentDir, filename), text)
  }

  /** Read back a saved copy; `undefined` when this side never wrote that file. */
  async sentCopyOf(filename: string): Promise<string | undefined> {
    if (!SENT_COPY_NAME_RE.test(filename)) return undefined
    try {
      return await readFile(join(this.sentDir, filename), 'utf8')
    } catch {
      return undefined
    }
  }

  private async sentCopyNames(): Promise<string[]> {
    try {
      return (await readdir(this.sentDir)).filter((name) => SENT_COPY_NAME_RE.test(name)).sort()
    } catch {
      return []
    }
  }

  /**
   * Compare every saved copy against the archive, byte for byte.
   *
   * Goes by the copies this side holds, not by what parses in the archive, so a
   * message that was deleted, renamed away or had its header corrupted is still
   * caught. An own message with no copy at all (written before this side kept
   * copies) is reported separately by {@link uncopiedOwnMessages}, so it cannot
   * mask a tamper.
   * @returns one entry per differing or missing archive file.
   */
  async verifySentCopies(): Promise<SentCopyMismatch[]> {
    return await this.compareCopies((await this.snapshot()).files)
  }

  private async compareCopies(files: readonly ArchivedFile[]): Promise<SentCopyMismatch[]> {
    const archive = new Map(files.map((file) => [file.filename, file]))
    const out: SentCopyMismatch[] = []
    for (const filename of await this.sentCopyNames()) {
      let copy: Buffer
      try {
        copy = await readFile(join(this.sentDir, filename))
      } catch {
        continue
      }
      const archived = archive.get(filename)
      if (archived === undefined) {
        out.push({
          filename,
          reason: `missing from the archive (the saved copy is ${String(copy.length)}B)`,
          key: `${filename}@deleted`,
        })
      } else if (!copy.equals(archived.bytes)) {
        out.push({
          filename,
          reason: `archived bytes differ from the saved copy (copy ${String(copy.length)}B, archive ${String(archived.bytes.length)}B)`,
          key: `${filename}@${createHash('sha256').update(archived.bytes).digest('hex')}`,
        })
      }
    }
    return out
  }

  /** Own messages the archive holds but this side has no copy of. */
  async uncopiedOwnMessages(): Promise<string[]> {
    const out: string[] = []
    for (const file of (await this.snapshot()).files) {
      const named = parseFilename(file.filename)
      if (!named.ok || named.parts.sender !== this.config.role) continue
      if ((await this.sentCopyOf(file.filename)) === undefined) out.push(file.filename)
    }
    return out
  }

  /** Prepare the mirror and load persisted state. */
  async start(): Promise<void> {
    if (await this.store.migrate()) {
      this.ctx.logger?.('lg-channel')?.info?.(`lg-channel: adopted the pre-SPEC state file at ${redactSecrets(String(this.config.legacyStateFile))}`)
    }
    this.state = await this.store.load(this.config.repo, this.config.role)
    await this.repo.ensure()
  }

  /**
   * Unused approvals, as maintained **in memory** from our own fetches.
   *
   * SPEC "lg-action-gate" (AG-2) is explicit that the guard reads a table the
   * channel keeps, not the channel repository: a guard is synchronous and must
   * never do I/O, and a repo read would also be a fresh, spoofable read. The
   * table only ever holds approvals from valid, unsuperseded DECISIONs, and a
   * halted channel authorises nothing.
   * @returns the approvals that no REPORT has consumed yet.
   */
  approvals(): readonly Approval[] {
    return this.state.halted ? [] : [...this.approvalCache]
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
   * neither replays nor drops anything. An unreachable remote fails the bind:
   * it is not an empty channel (CH-2).
   * @param sessionId - session identity of the invoking agent.
   */
  async bind(sessionId: string): Promise<void> {
    const patch: { boundSessionId: string; cursor?: string } = { boundSessionId: sessionId }
    if (this.state.boundSessionId === null) {
      await this.repo.fetch()
      // File names, not parsed messages: a newest message that does not parse still counts as history.
      const newest = (await this.repo.listMessages())
        .map((name) => name.slice(0, 4))
        .filter((seq) => /^\d{4}$/u.test(seq))
        .at(-1)
      if (newest !== undefined) patch.cursor = newest
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

  /**
   * Merge into the in-memory state at once and queue the write.
   *
   * The merge is synchronous so a HALT is effective even if the disk write is
   * slow or fails; writes are serialised so an older snapshot never lands last.
   */
  private persist(patch: Partial<PersistedState>): Promise<void> {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() }
    const run = this.saveChain.then(async () => await this.store.save(this.state))
    this.saveChain = run.catch(() => undefined)
    return run
  }

  /**
   * Read the archive once: every message file, parsed, validated and folded.
   * @returns the snapshot at the current origin head.
   */
  async snapshot(): Promise<ChannelSnapshot> {
    const head = await this.repo.originHead()
    const raw = await this.repo.readMessages(head)
    const files: ArchivedFile[] = []
    const parsed = new Map<string, ParseResult>()
    const messages: ParsedMessage[] = []
    for (const [filename, bytes] of raw) {
      const text = bytes.toString('utf8')
      files.push({ filename, bytes, text })
      const result = parseMessage(filename, text)
      parsed.set(filename, result)
      if (result.ok) messages.push(result.message)
    }
    return { head, files, parsed, messages, view: foldChannel(messages) }
  }

  /** Recompute the in-memory approval table from a snapshot. */
  private refreshApprovals(snapshot: ChannelSnapshot): void {
    this.approvalCache = [...snapshot.view.approvals]
  }

  /**
   * Deliver every message after the cursor, then advance it.
   *
   * A HALT among the pending messages is acted on first, before anything else is
   * delivered. Otherwise the cursor moves only after a message was handed to the
   * agent, together with its id, so a failed delivery is retried on the next poll
   * and a restart neither loses nor repeats a message (§7).
   */
  async poll(): Promise<void> {
    if (this.polling || this.state.halted) return
    this.polling = true
    try {
      await this.repo.fetch()
      const snapshot = await this.snapshot()
      this.refreshApprovals(snapshot)
      await this.reportSentCopyMismatches(snapshot)
      await this.deliverPending(snapshot)
    } finally {
      this.polling = false
    }
  }

  private async deliverPending(snapshot: ChannelSnapshot): Promise<void> {
    // Before the first bind the cursor has not been set to the channel's newest
    // message, so "pending" would be the whole history.
    if (this.state.boundSessionId === null) return
    const pending = snapshot.files.filter((file) => /^\d{4}/u.test(file.filename) && file.filename.slice(0, 4) > this.state.cursor)
    if (pending.length === 0) return
    const agent = this.boundAgent()

    const halt = pending.find((file) => isHumanHalt(file.filename, file.text))
    if (halt !== undefined) {
      await this.haltNow(agent, halt, snapshot)
      return
    }
    if (agent === undefined) return

    for (const file of pending) {
      const id = await this.deliverOne(agent, file, snapshot)
      await this.persist({
        cursor: file.filename.slice(0, 4),
        ...(id === undefined ? {} : { deliveredIds: [...this.state.deliveredIds, id] }),
      })
    }
  }

  /**
   * Stop this side for a human HALT (SPEC "投递": cancel the turn, deliver nothing after).
   *
   * Decided from the file name and first line alone, so a HALT with broken or
   * wrong fields still halts; those problems are only labelled. No supersedes
   * can suppress it, and messages queued before it are not delivered.
   */
  private async haltNow(agent: Agent | undefined, file: ArchivedFile, snapshot: ChannelSnapshot): Promise<void> {
    const seq = file.filename.slice(0, 4)
    const saving = this.persist({ halted: true, cursor: seq })
    saving.catch(() => undefined)
    if (agent !== undefined) {
      agent.cancel({ kind: 'user' })
      try {
        this.deliver(agent, this.haltText(file, snapshot))
      } catch (error) {
        warn(this.ctx, `could not deliver the HALT text: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      await saving
    } catch (error) {
      warn(this.ctx, `halted, but could not save the state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private haltText(file: ArchivedFile, snapshot: ChannelSnapshot): string {
    const seq = file.filename.slice(0, 4)
    const parsed = snapshot.parsed.get(file.filename)
    if (parsed?.ok === true) {
      const problems = (snapshot.view.analysis.issues.get(file.filename) ?? []).map((error) => error.message)
      const note = problems.length === 0 ? '' : `[LG HALT #${seq}] field problems, acting as a HALT regardless: ${problems.join('; ')}\n`
      return `${note}${this.renderDelivery(parsed.message, file.text)}`
    }
    const reasons = parsed === undefined || parsed.ok ? [] : parsed.errors.map((error) => error.message)
    return `[LG #${seq} HALT from human]\n[LG HALT #${seq}] unreadable message, acting as a HALT regardless: ${reasons.join('; ')}\n${file.text.slice(0, HALT_PREVIEW_CHARS)}`
  }

  /**
   * Post one ISOLATION_REPORT per newly seen lost-integrity finding (CH-12).
   *
   * Runs after the fetch so it sees the archive as it stands. A finding counts
   * as reported only once the report is in the channel, so a failed post is
   * retried on the next poll; the reported set survives a restart.
   */
  private async reportSentCopyMismatches(snapshot: ChannelSnapshot): Promise<void> {
    const mismatches = await this.compareCopies(snapshot.files)
    const fresh = mismatches.filter((entry) => entry.key === undefined || !this.state.reportedMismatches.includes(entry.key))
    if (fresh.length === 0) return
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
      const keys = fresh.flatMap((entry) => (entry.key === undefined ? [] : [entry.key]))
      await this.persist({ reportedMismatches: [...this.state.reportedMismatches, ...keys] })
    } catch (error) {
      // Reporting must never take the poll loop down; the mismatch stays visible
      // through lg_integrity_check (IN-3) and is retried next poll.
      warn(this.ctx, `could not report a sent-copy mismatch: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Deliver one message.
   * @returns the id to record as delivered, or `undefined` when nothing was
   * delivered or the message has no id. Throws when delivery fails, so the
   * cursor stays in front of the message.
   */
  private async deliverOne(agent: Agent, file: ArchivedFile, snapshot: ChannelSnapshot): Promise<string | undefined> {
    const seq = file.filename.slice(0, 4)
    const named = parseFilename(file.filename)
    // Own messages and messages this side archived itself are never delivered back.
    if (named.ok && named.parts.sender === this.config.role) return undefined
    if (this.state.archived.includes(file.filename)) return undefined

    const parsed = snapshot.parsed.get(file.filename)
    if (parsed === undefined || !parsed.ok) {
      this.deliverInvalid(agent, seq, parsed === undefined ? ['unreadable'] : parsed.errors.map((error) => error.message))
      return undefined
    }
    const message = parsed.message
    const rawId = message.fields['id']
    const id = typeof rawId === 'string' && ID_RE.test(rawId) ? rawId : undefined

    // CH-9: an id already handed to the session is never delivered twice, even
    // after a cursor reset or a restart.
    if (id !== undefined && this.state.deliveredIds.includes(id)) return undefined

    const issues = snapshot.view.analysis.issues.get(file.filename)
    if (issues !== undefined) {
      this.deliverInvalid(agent, seq, issues.map((error) => error.message))
      return undefined
    }

    const notes = (snapshot.view.analysis.ignored.get(file.filename) ?? []).map((entry) => `[LG NOTE #${seq}] ${entry.message}; it has no effect\n`).join('')

    // CH-10: a superseded message is shown as superseded and must not be run.
    // Only a same-sender, earlier message can supersede, so name that one.
    const replacer = supersededByOf(snapshot.view.analysis, message)
    if (replacer !== undefined) {
      const by = replacer.fields['id'] ?? replacer.seq
      const body = `[LG #${seq} ${message.type} SUPERSEDED by ${String(by)}] 不要执行。\n${notes}${this.renderDelivery(message, file.text)}`
      if (this.config.role === 'global') agent.inject(this.messageFor(body))
      else this.deliver(agent, body)
      return id
    }

    // CH-4: the Global side only opens a turn for wake-class messages; anything
    // else goes into the context without waking the driver.
    const body = `${notes}${this.renderDelivery(message, file.text)}`
    if (this.config.role === 'global' && !wakesGlobal(message)) agent.inject(this.messageFor(body))
    else this.deliver(agent, body)
    return id
  }

  /** CH-5: the reason replaces the text; Global takes it as context, never as a new turn (CH-4). */
  private deliverInvalid(agent: Agent, seq: string, reasons: readonly string[]): void {
    const body = `[LG INVALID #${seq}] ${reasons.join('; ')}`
    if (this.config.role === 'global') agent.inject(this.messageFor(body))
    else this.deliver(agent, body)
  }

  /** Render one message the way the model sees it. */
  private renderDelivery(message: ParsedMessage, text: string): string {
    const newline = text.indexOf('\n')
    const rest = newline === -1 ? '' : text.slice(newline + 1)
    return `${deliveryLabel(message)}\n${rest}`
  }

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
   * @param input - type, fields, body, refs and attachments.
   * @returns the sequence, file name, commit and id that landed.
   */
  async post(input: PostInput): Promise<PostResult> {
    return await this.postAs(this.config.role as Sender, input)
  }

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

  /** A PATCH is only usable with its attachment, whose size and digest the message states (PA-1). */
  private assertPatchAttachment(type: MessageType, fields: Readonly<Record<string, unknown>>, attachments: readonly AppendAttachment[]): void {
    if (type !== 'PATCH') return
    const attachment = attachments.find((item) => item.name === fields['name'])
    if (attachment === undefined) {
      throw new ChannelError('patch-attachment', `a PATCH needs an attachment named ${JSON.stringify(fields['name'])} (the "name" field)`)
    }
    const digest = createHash('sha256').update(attachment.content).digest('hex')
    if (fields['bytes'] !== attachment.content.length || fields['sha256'] !== digest) {
      throw new ChannelError(
        'patch-attachment',
        `PATCH bytes/sha256 do not match the attachment (attachment is ${String(attachment.content.length)} bytes, sha256 ${digest})`,
      )
    }
  }

  /** The id this message will carry: generated when absent, checked when given (CH-7). */
  private resolveId(sender: Sender, given: unknown, messages: readonly ParsedMessage[]): string {
    if (given === undefined) return nextId(sender, messages)
    if (typeof given !== 'string' || !ID_RE.test(given) || !given.startsWith(ID_PREFIX[sender])) {
      throw new ChannelError('bad-id', `id must look like ${ID_PREFIX[sender]}0042 for ${sender}; got ${JSON.stringify(given)}`)
    }
    if (messages.some((message) => message.fields['id'] === given)) {
      throw new ChannelError('duplicate-id', `id ${given} is already in the channel; ids are never reused`)
    }
    if (Number.parseInt(given.slice(2), 10) <= highestIdCounter(sender, messages)) {
      throw new ChannelError('id-not-increasing', `id ${given} is not above ${sender}'s highest id; ids increase per sender`)
    }
    return given
  }

  /** PR-6: only a sender's own earlier messages can be superseded or corrected, and never a HALT. */
  private assertReferences(sender: Sender, type: MessageType, fields: Readonly<Record<string, unknown>>, id: string, messages: readonly ParsedMessage[]): void {
    const problems: MessageError[] = []
    const supersedes = fields['supersedes']
    if (Array.isArray(supersedes)) {
      for (const target of supersedes) {
        if (typeof target !== 'string') continue
        const owner = messages.find((message) => message.fields['id'] === target)
        if (target === id) problems.push({ code: 'self-supersedes', message: `a message cannot supersede itself (${target})` })
        else if (owner === undefined) problems.push({ code: 'unknown-supersedes', message: `supersedes ${target}: no message in the channel carries that id` })
        else if (owner.sender !== sender) {
          problems.push({ code: 'foreign-supersedes', message: `supersedes ${target}: it belongs to ${owner.sender}, and ${sender} may only supersede its own messages` })
        } else if (owner.type === 'HALT') problems.push({ code: 'halt-supersedes', message: `supersedes ${target}: a HALT can never be superseded` })
      }
    }
    if (type === 'CORRECTION' && typeof fields['corrects'] === 'string') {
      const named = messages.filter((message) => message.seq === fields['corrects'])
      if (named.length === 0) problems.push({ code: 'unknown-corrects', message: `corrects ${String(fields['corrects'])}: no message has that sequence` })
      else if (!named.some((message) => message.sender === sender)) {
        problems.push({ code: 'foreign-corrects', message: `corrects ${String(fields['corrects'])}: it was written by ${named[0]?.sender ?? 'another sender'}, and ${sender} may only correct its own messages` })
      }
    }
    if (problems.length > 0) throw new ChannelError(problems[0]?.code ?? 'invalid-message', problems.map((problem) => problem.message).join('; '), problems)
  }

  /**
   * Append one message under an explicit identity.
   *
   * This side's role, or `human` for `/lg-halt`; speaking as the other agent is
   * refused. The message is validated before and again against the channel it
   * lands in: its id is generated (or checked), `supersedes` and CORRECTION may
   * only name the sender's own messages, and attachments land in the same commit.
   * @param sender - identity to declare; must be allowed for the type.
   * @param input - type, fields, body, refs and attachments.
   * @returns the sequence, file name, commit and id that landed.
   */
  async postAs(sender: Sender, input: PostInput): Promise<PostResult> {
    if (sender !== this.config.role && sender !== 'human') {
      throw new ChannelError('sender-not-allowed', `this side is ${this.config.role} and cannot write as ${sender}`)
    }
    const fields = { ...input.fields }
    if (input.refs !== undefined && fields['refs'] === undefined) fields['refs'] = [...input.refs]
    const body = input.body ?? ''
    const attachments = normalizeAttachments(input.attachments)
    this.probe(sender, input.type, fields, body)
    this.assertEvidenceFresh(input)
    this.assertPatchAttachment(input.type, fields, attachments)

    let id = ''
    const result = await this.repo.append(async (seq, view) => {
      const existing: ParsedMessage[] = []
      for (const [filename, bytes] of await view.readMessages()) {
        const parsed = parseMessage(filename, bytes.toString('utf8'))
        if (parsed.ok) existing.push(parsed.message)
      }
      id = this.resolveId(sender, fields['id'], existing)
      const { id: _given, ...rest } = fields
      void _given
      const final = { id, ...rest }
      this.assertReferences(sender, input.type, final, id, existing)
      this.probe(sender, input.type, final, body)
      const rendered = formatMessage({ seq, sender, type: input.type, fields: final, body })
      return { sender, type: input.type, filename: rendered.filename, text: rendered.text, attachments }
    })
    await this.saveSentCopy(result.filename, result.text)
    // A REPORT may have just spent an approval; keep the table in step.
    if (input.type === 'REPORT') {
      await this.snapshot().then(
        (snapshot) => this.refreshApprovals(snapshot),
        () => undefined,
      )
    }
    return { seq: result.seq, filename: result.filename, commit: result.commit, id }
  }

  /**
   * Archive a relayed message byte-for-byte (§8).
   *
   * Only the first line is checked: the file name is built from it, and field
   * problems are for readers to report as `[LG INVALID #<seq>]`. The text is read
   * back from the archive and compared; a message whose id is already in the
   * channel is not archived again and the existing sequence is returned (CH-8).
   * @param text - the complete message text exactly as relayed.
   * @returns the sequence, file name, and commit that landed or already existed.
   */
  async recordRelayed(text: string): Promise<RelayResult> {
    if (!this.config.relay) {
      throw new ChannelError('relay-disabled', 'lg_record_relayed requires lg-channel config relay: true')
    }
    const firstLine = (text.split('\n')[0] ?? '').replace(/\r$/, '')
    const header = RELAY_HEADER_RE.exec(firstLine)
    if (header === null) {
      throw new ChannelError('invalid-message', 'relayed text must start with [LG <TYPE> from <human|global|local>]')
    }
    const type = header[1] as MessageType
    const sender = header[2] as Sender
    if (sender !== 'global' && sender !== 'human') {
      throw new ChannelError('relay-sender', 'relayed text must come from global or human, not from this side')
    }
    const bytes = Buffer.from(text, 'utf8')
    const id = idOfText(`9999-${sender}-${type}.md`, text)

    class Duplicate extends Error {
      constructor(readonly filename: string) {
        super('duplicate')
      }
    }
    let result: { seq: string; filename: string; commit: string }
    try {
      result = await this.repo.append(async (seq, view) => {
        if (id !== undefined) {
          for (const [filename, archived] of await view.readMessages()) {
            if (idOfText(filename, archived.toString('utf8')) === id) throw new Duplicate(filename)
          }
        }
        return { sender, type, filename: `${seq}-${sender}-${type}.md`, text }
      })
    } catch (error) {
      if (!(error instanceof Duplicate)) throw error
      const existing = await this.repo.readBytes(`messages/${error.filename}`)
      return {
        seq: error.filename.slice(0, 4),
        filename: error.filename,
        commit: (await this.repo.commitAdding(`messages/${error.filename}`)) ?? '',
        id: id as string,
        duplicate: true,
        identical: existing?.equals(bytes) === true,
      }
    }

    const archived = await this.repo.readBytes(`messages/${result.filename}`)
    if (archived === undefined || !archived.equals(bytes)) {
      throw new ChannelError(
        'readback-mismatch',
        `messages/${result.filename} was pushed but reads back different from the relayed text (${String(archived?.length ?? 0)}B vs ${String(bytes.length)}B)`,
      )
    }
    await this.saveSentCopy(result.filename, bytes)
    // CH-9: what this side archived itself is never delivered back to it. A
    // relayed HALT still halts, so it is left for the poll to act on.
    if (type !== 'HALT') {
      await this.persist({
        archived: [...this.state.archived, result.filename],
        ...(id === undefined ? {} : { deliveredIds: [...this.state.deliveredIds, id] }),
      })
    }
    return { ...result, ...(id === undefined ? {} : { id }), duplicate: false }
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
   * @throws ChannelError for a path outside `attachments/`.
   */
  async readAttachment(path: string): Promise<Buffer | undefined> {
    const parts = path.split('/')
    if (parts[0] !== 'attachments' || parts.length !== 3 || parts.some((part) => part === '' || part === '.' || part === '..') || path.includes('\\') || path.includes('\0')) {
      throw new ChannelError('invalid-path', `not an attachment path: ${JSON.stringify(path)}`)
    }
    return await this.repo.readBytes(path)
  }

  /**
   * Every message that parses, ascending, valid or not.
   *
   * Callers that grant authority must use {@link snapshot} (`view`) or
   * {@link channelState} instead: this list includes messages that failed validation.
   */
  async all(): Promise<ParsedMessage[]> {
    return [...(await this.snapshot()).messages]
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

  /** The channel's folded state: valid messages only, effective supersedes applied. */
  async channelState(): Promise<ChannelView> {
    return (await this.snapshot()).view
  }

  /** Unanswered QUESTION and OBJECTION messages. */
  async openQuestions(): Promise<readonly ParsedMessage[]> {
    return (await this.channelState()).openQuestions
  }

  /** Open questions, unresolved blocking findings and pending checkpoints (SPEC `lg_open_questions`). */
  async openItems(): Promise<OpenItem[]> {
    const state = await this.channelState()
    return [
      ...state.openQuestions.map((message): OpenItem => ({
        kind: message.type === 'OBJECTION' ? 'objection' : 'question',
        ref: message.seq,
        text: `#${message.seq} ${message.type} from ${message.sender}`,
      })),
      ...state.unresolvedFindings
        .filter((entry) => entry.finding.severity === 'blocking')
        .map((entry): OpenItem => ({
          kind: 'finding',
          ref: `${entry.review}/${entry.finding.id}`,
          text: `#${entry.review}/${entry.finding.id} blocking finding: ${entry.finding.text}`,
        })),
      ...state.pendingCheckpoints.map((message): OpenItem => ({
        kind: 'checkpoint',
        ref: message.seq,
        text: `#${message.seq} checkpoint REPORT from ${message.sender} awaiting review`,
      })),
    ]
  }

  /** Status for `/lg-status`; credentials in the repo URL never appear. */
  async statusText(): Promise<string> {
    const state = await this.channelState()
    const list = (items: readonly string[]): string => (items.length === 0 ? '(none)' : items.join(', '))
    return [
      `repo: ${redactSecrets(this.config.repo)}#${this.config.branch}`,
      `role: ${this.config.role}`,
      `bound session: ${this.state.boundSessionId ?? '(none — run /lg-bind)'}`,
      `cursor: ${this.state.cursor}`,
      `channel max: ${state.lastSeq}`,
      `directive: ${state.directive === undefined ? '(none)' : `v${String(state.directive.fields['version'])} (#${state.directive.seq})`}`,
      `open questions: ${list(state.openQuestions.map((message) => message.seq))}`,
      `unresolved findings: ${list(state.unresolvedFindings.map((entry) => `${entry.review}/${entry.finding.id} (${entry.finding.severity})`))}`,
      `pending checkpoints: ${list(state.pendingCheckpoints.map((message) => message.seq))}`,
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
    ctx.logger?.('lg-channel')?.warn?.(redactSecrets(message))
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
export function apply(ctx: Context, raw: RawChannelConfig | null | undefined): void {
  const config = resolveChannelConfig(raw)
  const runtime = new ChannelRuntime(ctx, config)
  active = runtime

  const postable = ALLOWED_SENDERS
  const typesForRole = (Object.keys(postable) as MessageType[]).filter((type) => postable[type].includes(config.role as Sender))

  ctx.tools.register({
    name: 'lg_post',
    description: 'Append one message to the Local–Global channel and push it as a single commit. The id is generated.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: typesForRole, description: 'Message type this role may send.' },
        fields: { type: 'object', description: 'Message field region as a JSON object.' },
        body: { type: 'string', description: 'Optional Markdown body after the --- terminator.' },
        refs: { type: 'array', items: { type: 'string' }, description: 'Four-digit sequences this message references.' },
        supersedes: { type: 'array', items: { type: 'string' }, description: 'Ids of your own earlier messages this one replaces.' },
        attachments: {
          type: 'array',
          description: 'Files committed with the message under attachments/<seq>/.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Plain file name, no path.' },
              content: { type: 'string' },
              encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'How content is decoded; utf8 by default.' },
            },
            required: ['name', 'content'],
          },
        },
      },
      required: ['type'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { seq: { type: 'string' }, filename: { type: 'string' }, commit: { type: 'string' }, id: { type: 'string' } },
        required: ['seq', 'filename', 'commit', 'id'],
      },
      render: (_args: unknown, value: { seq: string; filename: string; commit: string; id: string }) => [
        textBlock(`posted ${value.filename} (${value.id}) as ${value.commit.slice(0, 12)}`),
      ],
    },
    async execute(args: {
      type: MessageType
      fields?: Record<string, unknown>
      body?: string
      refs?: string[]
      supersedes?: string[]
      attachments?: AttachmentInput[]
    }) {
      const fields = { ...(args.fields ?? {}) }
      if (args.supersedes !== undefined) fields['supersedes'] = args.supersedes
      return await runtime.post({
        type: args.type,
        fields,
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.refs === undefined ? {} : { refs: args.refs }),
        ...(args.attachments === undefined ? {} : { attachments: args.attachments }),
      })
    },
  } as ToolDefinition)

  // SPEC: only offered in relay mode.
  if (config.relay) {
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
          properties: {
            seq: { type: 'string' },
            filename: { type: 'string' },
            commit: { type: 'string' },
            id: { type: 'string' },
            duplicate: { type: 'boolean' },
          },
          required: ['seq', 'filename', 'commit', 'duplicate'],
        },
        render: (_args: unknown, value: { filename: string; duplicate?: boolean }) => [
          textBlock(value.duplicate === true ? `already archived as ${value.filename}` : `archived ${value.filename}`),
        ],
      },
      async execute(args: { text: string }) {
        return await runtime.recordRelayed(args.text)
      },
    } as ToolDefinition)
  }

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
    description: 'List open QUESTION and OBJECTION messages, unresolved blocking findings, and checkpoint REPORTs awaiting review.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: { kind: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' } },
          required: ['text'],
        },
      },
      render: (_args: unknown, value: { text: string }[]) => [textBlock(value.map((item) => item.text).join('\n') || '(none open)')],
    },
    async execute() {
      return await runtime.openItems()
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
