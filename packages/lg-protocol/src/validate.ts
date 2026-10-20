/**
 * Semantic validation of one parsed message (docs/channel-git.md §4).
 */
import {
  ALLOWED_SENDERS,
  MESSAGE_TYPES,
  REQUIRED_FIELDS,
  isLegacySeq,
  type MessageError,
  type MessageType,
  type ParsedMessage,
} from './types.js'

const SEQ_RE = /^\d{4}$/
const SHA40_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const AC_ID_RE = /^AC-\d+$/
const FINDING_ID_RE = /^F-\d+$/
/** A `resolves` entry names both the REVIEW and the finding, so ids may repeat across REVIEWs. */
const RESOLVES_RE = /^\d{4}\/F-\d+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function seqList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !SEQ_RE.test(item)) return undefined
    out.push(item)
  }
  return out
}

/**
 * Validate one parsed message against the sender, field, and shape rules of §4.
 *
 * Messages at or below {@link isLegacySeq} are exempt (§10).
 * @param message - the parsed message.
 * @returns every rule violation; empty means valid.
 */
export function validateMessage(message: ParsedMessage): MessageError[] {
  if (isLegacySeq(message.seq)) return []

  const errors: MessageError[] = []
  const { type, sender, fields } = message

  if (!(MESSAGE_TYPES as readonly string[]).includes(type)) {
    return [{ code: 'unknown-type', message: `"${type}" is not a message type; STATUS belongs to status/, not messages/` }]
  }

  const allowed = ALLOWED_SENDERS[type as MessageType]
  if (!allowed.includes(sender)) {
    errors.push({
      code: 'sender-not-allowed',
      message: `${sender} may not send ${type}; allowed senders are ${allowed.join(', ')}`,
    })
  }

  for (const field of REQUIRED_FIELDS[type as MessageType]) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) {
      errors.push({ code: 'missing-field', message: `${type} requires field "${field}"` })
    }
  }

  if (errors.some((error) => error.code === 'missing-field')) return errors

  const check = (condition: boolean, field: string, expectation: string): void => {
    if (!condition) errors.push({ code: 'field-shape', message: `${type}.${field} must be ${expectation}` })
  }

  if (Object.prototype.hasOwnProperty.call(fields, 'refs') && seqList(fields['refs']) === undefined) {
    check(false, 'refs', 'a list of four-digit sequence strings')
  }

  switch (type) {
    case 'TASK': {
      check(typeof fields['goal'] === 'string', 'goal', 'a string')
      check(isStringArray(fields['constraints']), 'constraints', 'a list of strings')
      const budget = fields['budget']
      if (!isRecord(budget)) {
        check(false, 'budget', 'a mapping with max_hours and max_rounds')
      } else {
        check(isFiniteNumber(budget['max_hours']), 'budget.max_hours', 'a number')
        check(isInteger(budget['max_rounds']), 'budget.max_rounds', 'an integer')
      }
      break
    }
    case 'REPORT': {
      check(SHA40_RE.test(String(fields['commit'] ?? '')), 'commit', 'a full 40-character SHA')
      check(isInteger(fields['directive_version']), 'directive_version', 'an integer')
      check(Array.isArray(fields['evidence']), 'evidence', 'a list (possibly empty)')
      check(Array.isArray(fields['negative_tests']), 'negative_tests', 'a list (possibly empty)')
      if (Object.prototype.hasOwnProperty.call(fields, 'consumed_approvals') && seqList(fields['consumed_approvals']) === undefined) {
        check(false, 'consumed_approvals', 'a list of four-digit sequence strings')
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'resolves')) {
        const resolves = fields['resolves']
        check(
          Array.isArray(resolves) && resolves.every((item) => typeof item === 'string' && RESOLVES_RE.test(item)),
          'resolves',
          'a list of "<review sequence>/F-<n>" strings',
        )
      }
      break
    }
    case 'QUESTION': {
      check(Array.isArray(fields['options']), 'options', 'a list')
      check(typeof fields['blocking'] === 'boolean', 'blocking', 'a boolean')
      check(typeof fields['default_action'] === 'string', 'default_action', 'a string')
      if (Object.prototype.hasOwnProperty.call(fields, 'action')) {
        check(typeof fields['action'] === 'string', 'action', 'an action fingerprint string')
      }
      break
    }
    case 'DECISION': {
      check(seqList(fields['answers']) !== undefined, 'answers', 'a list of four-digit sequence strings')
      check(typeof fields['choice'] === 'string', 'choice', 'a string')
      check(typeof fields['reason'] === 'string', 'reason', 'a string')
      if (Object.prototype.hasOwnProperty.call(fields, 'approve_action')) {
        check(typeof fields['approve_action'] === 'string', 'approve_action', 'an action fingerprint string')
      }
      break
    }
    case 'DIRECTIVE': {
      check(isInteger(fields['version']) && (fields['version'] as number) >= 1, 'version', 'an integer >= 1')
      check(typeof fields['goal'] === 'string', 'goal', 'a string')
      check(isStringArray(fields['priorities']), 'priorities', 'a list of strings')
      const acceptance = fields['acceptance']
      check(Array.isArray(acceptance), 'acceptance', 'a list of {id, text}')
      if (Array.isArray(acceptance)) {
        for (const item of acceptance) {
          if (!isRecord(item) || typeof item['id'] !== 'string' || !AC_ID_RE.test(item['id']) || typeof item['text'] !== 'string') {
            check(false, 'acceptance[]', 'a list of {id: AC-<n>, text: <string>}')
            break
          }
        }
      }
      const scope = fields['scope']
      if (!isRecord(scope)) {
        check(false, 'scope', 'a mapping with in and out lists')
      } else {
        check(isStringArray(scope['in']), 'scope.in', 'a list of strings')
        check(isStringArray(scope['out']), 'scope.out', 'a list of strings')
      }
      break
    }
    case 'PATCH': {
      check(typeof fields['name'] === 'string', 'name', 'a string')
      check(SEQ_RE.test(String(fields['claim'] ?? '')), 'claim', 'a four-digit sequence string')
      check(SHA40_RE.test(String(fields['base'] ?? '')), 'base', 'a full 40-character SHA')
      check(fields['format'] === 'git-format-patch', 'format', '"git-format-patch"')
      check(isInteger(fields['bytes']) && (fields['bytes'] as number) >= 0, 'bytes', 'a non-negative integer')
      check(SHA256_RE.test(String(fields['sha256'] ?? '')), 'sha256', 'a 64-character hex digest')
      break
    }
    case 'CLAIM': {
      check(Array.isArray(fields['scope']), 'scope', 'a list of paths or features')
      check(fields['implementer'] === 'global' || fields['implementer'] === 'local', 'implementer', '"global" or "local"')
      break
    }
    case 'OBJECTION': {
      check(SEQ_RE.test(String(fields['target'] ?? '')), 'target', 'a four-digit sequence string')
      check(Array.isArray(fields['evidence']), 'evidence', 'a list')
      break
    }
    case 'CORRECTION': {
      check(SEQ_RE.test(String(fields['corrects'] ?? '')), 'corrects', 'a four-digit sequence string')
      check(typeof fields['replacement'] === 'string', 'replacement', 'a string')
      break
    }
    case 'REVIEW': {
      check(fields['verdict'] === 'accepted' || fields['verdict'] === 'changes-requested', 'verdict', '"accepted" or "changes-requested"')
      const findings = fields['findings']
      check(Array.isArray(findings), 'findings', 'a list of {id, severity, text}')
      if (Array.isArray(findings)) {
        for (const item of findings) {
          if (
            !isRecord(item) ||
            typeof item['id'] !== 'string' ||
            !FINDING_ID_RE.test(item['id']) ||
            (item['severity'] !== 'blocking' && item['severity'] !== 'minor') ||
            typeof item['text'] !== 'string'
          ) {
            check(false, 'findings[]', 'a list of {id: F-<n>, severity: blocking|minor, text: <string>}')
            break
          }
        }
      }
      break
    }
    case 'ISOLATION_REPORT': {
      const probes = fields['probes']
      check(Array.isArray(probes), 'probes', 'a list of {name, expected, actual, pass}')
      if (Array.isArray(probes)) {
        for (const item of probes) {
          if (!isRecord(item) || typeof item['name'] !== 'string' || typeof item['pass'] !== 'boolean') {
            check(false, 'probes[]', 'a list of {name, expected, actual, pass}')
            break
          }
        }
      }
      break
    }
    case 'STOP': {
      check(SHA40_RE.test(String(fields['final_commit'] ?? '')), 'final_commit', 'a full 40-character SHA')
      const acceptance = fields['acceptance']
      check(Array.isArray(acceptance), 'acceptance', 'a list of {id, evidence}')
      if (Array.isArray(acceptance)) {
        for (const item of acceptance) {
          if (!isRecord(item) || typeof item['id'] !== 'string' || !AC_ID_RE.test(item['id']) || !Array.isArray(item['evidence'])) {
            check(false, 'acceptance[]', 'a list of {id: AC-<n>, evidence: [...]}')
            break
          }
        }
      }
      break
    }
    case 'HALT': {
      check(typeof fields['reason'] === 'string', 'reason', 'a string')
      break
    }
    default:
      break
  }

  return errors
}
