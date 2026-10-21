/**
 * Message vocabulary of the git channel contract (docs/channel-git.md §2–§4).
 */

/** Every type allowed in `messages/`. STATUS lives under `status/` and is not one of these. */
export const MESSAGE_TYPES = [
  'TASK',
  'REPORT',
  'QUESTION',
  'DECISION',
  'DIRECTIVE',
  'PATCH',
  'CLAIM',
  'OBJECTION',
  'CORRECTION',
  'REVIEW',
  'ISOLATION_REPORT',
  'STOP',
  'HALT',
] as const

export type MessageType = (typeof MESSAGE_TYPES)[number]

/** The three identities that may appear on the first line and in the file name. */
export const SENDERS = ['human', 'global', 'local'] as const

export type Sender = (typeof SENDERS)[number]

/** Sender values that may write a message of a given type (channel-git.md §4). */
export const ALLOWED_SENDERS: Readonly<Record<MessageType, readonly Sender[]>> = {
  TASK: ['human'],
  REPORT: ['local'],
  QUESTION: ['local'],
  DECISION: ['global'],
  DIRECTIVE: ['global'],
  PATCH: ['global'],
  CLAIM: ['global', 'local'],
  OBJECTION: ['local'],
  CORRECTION: ['global', 'local', 'human'],
  REVIEW: ['global'],
  ISOLATION_REPORT: ['global', 'local'],
  STOP: ['global'],
  HALT: ['human'],
}

/** Fields every message of a type must carry (channel-git.md §4). */
export const REQUIRED_FIELDS: Readonly<Record<MessageType, readonly string[]>> = {
  TASK: ['goal', 'constraints', 'budget'],
  REPORT: ['refs', 'commit', 'directive_version', 'evidence', 'negative_tests'],
  QUESTION: ['options', 'blocking', 'default_action'],
  DECISION: ['answers', 'choice', 'reason'],
  DIRECTIVE: ['version', 'goal', 'priorities', 'acceptance', 'scope'],
  PATCH: ['name', 'claim', 'base', 'format', 'bytes', 'sha256'],
  CLAIM: ['scope', 'implementer'],
  OBJECTION: ['target', 'evidence'],
  CORRECTION: ['corrects', 'replacement'],
  REVIEW: ['refs', 'verdict', 'findings'],
  ISOLATION_REPORT: ['probes'],
  STOP: ['final_commit', 'acceptance'],
  HALT: ['reason'],
}

/** Optional fields the contract names explicitly; anything else is still allowed by §3. */
/** Every type may carry these (SPEC "消息协议": refs, id and supersedes). */
export const COMMON_OPTIONAL_FIELDS = ['refs', 'id', 'supersedes'] as const

/** `G-0042`, `L-0107`, `H-0003`: sender prefix, dash, four or more digits. */
export const ID_RE = /^[GLH]-\d{4,}$/

/** One sender's identity prefix. */
export const ID_PREFIX: Readonly<Record<Sender, string>> = { global: 'G-', local: 'L-', human: 'H-' }

export const OPTIONAL_FIELDS: Readonly<Record<MessageType, readonly string[]>> = {
  TASK: [...COMMON_OPTIONAL_FIELDS],
  REPORT: ['open_questions', 'consumed_approvals', 'resolves', 'checkpoint', 'meanwhile', ...COMMON_OPTIONAL_FIELDS],
  QUESTION: ['action', ...COMMON_OPTIONAL_FIELDS],
  DECISION: ['approve_action', ...COMMON_OPTIONAL_FIELDS],
  DIRECTIVE: [...COMMON_OPTIONAL_FIELDS],
  PATCH: [...COMMON_OPTIONAL_FIELDS],
  CLAIM: [...COMMON_OPTIONAL_FIELDS],
  OBJECTION: [...COMMON_OPTIONAL_FIELDS],
  CORRECTION: [...COMMON_OPTIONAL_FIELDS],
  REVIEW: [...COMMON_OPTIONAL_FIELDS],
  ISOLATION_REPORT: [...COMMON_OPTIONAL_FIELDS],
  STOP: [...COMMON_OPTIONAL_FIELDS],
  HALT: [...COMMON_OPTIONAL_FIELDS],
}

/** The conclusion a REVIEW carries. */
export const REVIEW_VERDICTS = ['accepted', 'changes-requested'] as const

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

/** How much a REVIEW finding blocks the work it names. */
export const FINDING_SEVERITIES = ['blocking', 'minor'] as const

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

/** One item a REVIEW asks Local to change. */
export interface Finding {
  /** `F-<n>`, stable across the REVIEW and its later REPORT. */
  readonly id: string
  readonly severity: FindingSeverity
  readonly text: string
}

/** One structural problem with a message. `code` is stable so callers can switch on it. */
export interface MessageError {
  readonly code: string
  readonly message: string
}

/** A message that parsed far enough to be identified, before field validation. */
export interface ParsedMessage {
  /** Four-digit sequence taken from the file name. */
  readonly seq: string
  readonly sender: Sender
  readonly type: MessageType
  /** `messages/<seq>-<sender>-<type>.md`. */
  readonly filename: string
  /** YAML field region, already parsed into plain data. */
  readonly fields: Readonly<Record<string, unknown>>
  /** Everything after the `---` terminator, verbatim. */
  readonly body: string
  /** The complete file text exactly as read. */
  readonly raw: string
}

/** Result of {@link parseMessage}. */
export type ParseResult =
  | { readonly ok: true; readonly message: ParsedMessage }
  | { readonly ok: false; readonly errors: readonly MessageError[] }

/** Sequence numbers at or below this one predate the contract and are exempt (channel-git.md §10). */
export const LEGACY_MAX_SEQ = '0002'

/** True for messages that must be validated against the §4 field rules. */
export function isLegacySeq(seq: string): boolean {
  return seq <= LEGACY_MAX_SEQ
}

/** Human-readable prefix of a message rendered into the bound session. */
export function deliveryLabel(message: Pick<ParsedMessage, 'seq' | 'type' | 'sender' | 'fields'>): string {
  if (message.type === 'DIRECTIVE') {
    const version = message.fields['version']
    return `[LG #${message.seq} DIRECTIVE v${String(version)} from ${message.sender}]`
  }
  return `[LG #${message.seq} ${message.type} from ${message.sender}]`
}
