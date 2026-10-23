/**
 * What a reader may act on: valid messages with effective references only.
 *
 * `foldState` is a pure fold over whatever it is handed. A channel is
 * untrusted input, so anything that grants approvals, opens questions or
 * suppresses a message must go through {@link analyzeChannel} /
 * {@link foldChannel} instead (PR-2, PR-6).
 */
import { foldState, type ChannelState } from './fold.js'
import { validateMessage } from './validate.js'
import { ID_RE, isLegacyMessage, type MessageError, type ParsedMessage } from './types.js'

/** A `supersedes` or `corrects` reference that does not take effect. */
export interface IgnoredReference {
  readonly kind: 'supersedes' | 'corrects'
  readonly target: string
  readonly code:
    | 'unknown-supersedes'
    | 'foreign-supersedes'
    | 'self-supersedes'
    | 'halt-supersedes'
    | 'unknown-corrects'
    | 'foreign-corrects'
  readonly message: string
}

/** The channel after validation and identity checks. Maps are keyed by file name. */
export interface ChannelAnalysis {
  /** Every message, ascending by sequence. */
  readonly ordered: readonly ParsedMessage[]
  /** Valid messages (no legacy ones): the only ones state may be built from. */
  readonly effective: readonly ParsedMessage[]
  /** The archived pre-contract messages, exempt from validation and inert in state. */
  readonly legacy: readonly ParsedMessage[]
  /** Why a message is not effective: validation errors plus `duplicate-id`. */
  readonly issues: ReadonlyMap<string, readonly MessageError[]>
  /** References that were dropped, per referencing message. */
  readonly ignored: ReadonlyMap<string, readonly IgnoredReference[]>
  /** id → the message that effectively supersedes it. A HALT is never a key. */
  readonly supersededBy: ReadonlyMap<string, ParsedMessage>
  /** Every HALT from human, valid or not (a broken HALT still halts). */
  readonly halts: readonly ParsedMessage[]
}

function byOrder(a: ParsedMessage, b: ParsedMessage): number {
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1
  return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0
}

function ownId(message: ParsedMessage): string | undefined {
  const id = message.fields['id']
  return typeof id === 'string' && ID_RE.test(id) ? id : undefined
}

/**
 * Validate a whole channel and resolve which references count.
 *
 * - A message with validation errors, or one reusing an id an earlier message
 *   already carries, is not effective.
 * - Only an effective message's `supersedes` can take effect, and only on an
 *   earlier message of the same sender. Unknown, foreign, self-referencing and
 *   HALT targets are dropped and recorded in `ignored`.
 * - A CORRECTION naming another sender's message (or none) is recorded the same way.
 * @param messages - parsed messages in any order.
 * @returns the analysis.
 */
export function analyzeChannel(messages: readonly ParsedMessage[]): ChannelAnalysis {
  const ordered = [...messages].sort(byOrder)
  const issues = new Map<string, MessageError[]>()
  const ignored = new Map<string, IgnoredReference[]>()
  const supersededBy = new Map<string, ParsedMessage>()
  const effective: ParsedMessage[] = []
  const legacy: ParsedMessage[] = []
  const owners = new Map<string, ParsedMessage>()

  for (const message of ordered) {
    if (isLegacyMessage(message)) {
      legacy.push(message)
      continue
    }
    const errors = validateMessage(message)
    const id = ownId(message)
    if (id !== undefined) {
      const first = owners.get(id)
      if (first !== undefined) {
        errors.push({
          code: 'duplicate-id',
          message: `id ${id} was already used by ${first.seq}; ids are unique per sender and never reused`,
        })
      } else {
        owners.set(id, message)
      }
    }
    if (errors.length > 0) issues.set(message.filename, errors)
    else effective.push(message)
  }

  const note = (message: ParsedMessage, entry: IgnoredReference): void => {
    const list = ignored.get(message.filename) ?? []
    list.push(entry)
    ignored.set(message.filename, list)
  }

  for (const message of effective) {
    const supersedes = message.fields['supersedes']
    if (Array.isArray(supersedes)) {
      for (const target of supersedes) {
        if (typeof target !== 'string') continue
        const owner = owners.get(target)
        const drop = (code: IgnoredReference['code'], why: string): void =>
          note(message, { kind: 'supersedes', target, code, message: `supersedes ${target} ignored: ${why}` })
        if (owner === undefined) drop('unknown-supersedes', 'no message in the channel carries that id')
        else if (owner.sender !== message.sender) drop('foreign-supersedes', `it belongs to ${owner.sender}, and only a sender's own messages can be superseded`)
        else if (owner === message || owner.seq >= message.seq) drop('self-supersedes', 'a message can only supersede an earlier one')
        else if (owner.type === 'HALT') drop('halt-supersedes', 'a HALT can never be superseded')
        else supersededBy.set(target, message)
      }
    }
    if (message.type === 'CORRECTION') {
      const corrects = message.fields['corrects']
      if (typeof corrects === 'string') {
        const named = ordered.filter((candidate) => candidate.seq === corrects)
        const drop = (code: IgnoredReference['code'], why: string): void =>
          note(message, { kind: 'corrects', target: corrects, code, message: `corrects ${corrects} ignored: ${why}` })
        if (named.length === 0) drop('unknown-corrects', 'no message has that sequence')
        else if (!named.some((candidate) => candidate.sender === message.sender)) {
          drop('foreign-corrects', `it was written by ${named[0]?.sender ?? 'another sender'}, and only a sender's own messages can be corrected`)
        }
      }
    }
  }

  return {
    ordered,
    effective,
    legacy,
    issues,
    ignored,
    supersededBy,
    halts: ordered.filter((message) => message.type === 'HALT' && message.sender === 'human'),
  }
}

/**
 * The message that effectively supersedes this one, if any.
 * @param analysis - result of {@link analyzeChannel}.
 * @param message - the message to look up.
 * @returns the superseding message; always `undefined` for a HALT.
 */
export function supersededByOf(analysis: ChannelAnalysis, message: ParsedMessage): ParsedMessage | undefined {
  const id = ownId(message)
  if (id === undefined || message.type === 'HALT') return undefined
  return analysis.supersededBy.get(id)
}

/** Folded state plus the analysis it came from. */
export interface ChannelView extends ChannelState {
  readonly analysis: ChannelAnalysis
}

function sequences(message: ParsedMessage, field: string): string[] {
  const value = message.fields[field]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Fold only what a reader may trust (SPEC "折叠状态").
 *
 * Invalid and legacy messages contribute nothing; superseded ones are dropped
 * before folding, so a superseded DECISION grants no approval and a superseded
 * QUESTION is not open. Two deliberate exceptions keep it fail-closed:
 * a superseded REPORT still spends the approvals it registered, and any human
 * HALT counts, valid or not.
 * @param messages - parsed messages in any order.
 * @returns the derived state.
 */
export function foldChannel(messages: readonly ParsedMessage[]): ChannelView {
  const analysis = analyzeChannel(messages)
  const live = analysis.effective.filter((message) => supersededByOf(analysis, message) === undefined)
  const state = foldState(live)

  const spent = new Set<string>()
  for (const message of analysis.effective) {
    if (message.type === 'REPORT' && supersededByOf(analysis, message) !== undefined) {
      for (const seq of sequences(message, 'consumed_approvals')) spent.add(seq)
    }
  }

  // Every valid HALT is human, so a state with no HALT here has none in `analysis.halts` either.
  const halt = analysis.halts.at(-1)
  const lastSeq = analysis.ordered.at(-1)?.seq ?? '0000'
  return {
    ...state,
    approvals: state.approvals.filter((approval) => !spent.has(approval.decision)),
    superseded: [...analysis.supersededBy.keys()],
    ...(halt === undefined ? {} : { halt }),
    lastSeq,
    analysis,
  }
}
