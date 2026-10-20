/**
 * Derived channel state (docs/channel-git.md §7).
 *
 * Everything here is folded from `messages/` on read: nothing is stored twice.
 */
import type { Finding, ParsedMessage } from './types.js'

/** State a reader derives from the message list. */
export interface ChannelState {
  /** The DIRECTIVE with the highest `version`, if any. */
  readonly directive?: ParsedMessage
  /** QUESTION and OBJECTION messages no DECISION has answered. */
  readonly openQuestions: readonly ParsedMessage[]
  /** Fingerprints of approved C-class actions that are still unused. */
  readonly approvals: readonly Approval[]
  /** Findings from REVIEW messages that no REPORT has resolved yet. */
  readonly unresolvedFindings: readonly OpenFinding[]
  /** The most recent HALT, if any. */
  readonly halt?: ParsedMessage
  /** Highest sequence seen, or `0000` for an empty channel. */
  readonly lastSeq: string
}

/** One REVIEW finding still waiting on a REPORT `resolves` entry. */
export interface OpenFinding {
  /** Sequence of the REVIEW that raised it. */
  readonly review: string
  readonly finding: Finding
}

/** One unused approval granted by a DECISION. */
export interface Approval {
  /** Sequence of the DECISION that granted it. */
  readonly decision: string
  /** `<rule id>:<sha256 prefix>` fingerprint (see `actionFingerprint`). */
  readonly fingerprint: string
}

function directiveVersion(message: ParsedMessage): number {
  const version = message.fields['version']
  return typeof version === 'number' && Number.isInteger(version) ? version : -1
}

function seqListField(message: ParsedMessage, field: string): string[] {
  const value = message.fields[field]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * Fold the message list into the current directive, open questions, usable
 * approvals, and the last HALT.
 * @param messages - parsed messages in ascending sequence order.
 * @returns the derived state.
 */
export function foldState(messages: readonly ParsedMessage[]): ChannelState {
  let directive: ParsedMessage | undefined
  let halt: ParsedMessage | undefined
  let lastSeq = '0000'
  const answered = new Set<string>()
  const consumed = new Set<string>()
  const questions: ParsedMessage[] = []
  const grants: Approval[] = []
  const reviews: { review: string; finding: Finding }[] = []
  const resolved = new Set<string>()

  for (const message of messages) {
    if (message.seq > lastSeq) lastSeq = message.seq
    switch (message.type) {
      case 'DIRECTIVE': {
        if (directive === undefined || directiveVersion(message) >= directiveVersion(directive)) {
          directive = message
        }
        break
      }
      case 'HALT': {
        halt = message
        break
      }
      case 'DECISION': {
        for (const seq of seqListField(message, 'answers')) answered.add(seq)
        const fingerprint = message.fields['approve_action']
        if (typeof fingerprint === 'string') {
          grants.push({ decision: message.seq, fingerprint })
        }
        break
      }
      case 'QUESTION':
      case 'OBJECTION': {
        questions.push(message)
        break
      }
      case 'REPORT': {
        for (const seq of seqListField(message, 'consumed_approvals')) consumed.add(seq)
        // Key by REVIEW sequence + finding id: every REVIEW restarts its ids at F-1.
        for (const key of seqListField(message, 'resolves')) resolved.add(key)
        break
      }
      case 'REVIEW': {
        const findings = message.fields['findings']
        if (Array.isArray(findings)) {
          for (const item of findings) {
            if (typeof item !== 'object' || item === null) continue
            const record = item as Record<string, unknown>
            if (typeof record['id'] !== 'string' || typeof record['text'] !== 'string') continue
            const severity = record['severity'] === 'blocking' ? 'blocking' : 'minor'
            reviews.push({ review: message.seq, finding: { id: record['id'], severity, text: record['text'] } })
          }
        }
        break
      }
      default:
        break
    }
  }

  return {
    ...(directive === undefined ? {} : { directive }),
    openQuestions: questions.filter((message) => !answered.has(message.seq)),
    unresolvedFindings: reviews.filter((entry) => !resolved.has(`${entry.review}/${entry.finding.id}`)),
    approvals: grants.filter((grant) => !consumed.has(grant.decision)),
    ...(halt === undefined ? {} : { halt }),
    lastSeq,
  }
}
