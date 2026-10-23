/**
 * Semantic validation of one parsed message (docs/channel-git.md §4).
 */
import { attachmentNameProblem } from './attachments.js'
import {
  ID_PREFIX,
  ID_RE,
  ALLOWED_SENDERS,
  MESSAGE_TYPES,
  REQUIRED_FIELDS,
  isLegacyMessage,
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
 * Only the two archived pre-contract messages ({@link isLegacyMessage}) are
 * exempt (§10); everything else, including other sequences at 0001–0002, is
 * checked.
 * @param message - the parsed message.
 * @returns every rule violation; empty means valid.
 */
export function validateMessage(message: ParsedMessage): MessageError[] {
  if (isLegacyMessage(message)) return []

  const errors: MessageError[] = []
  const { type, sender, fields } = message

  if (!(MESSAGE_TYPES as readonly string[]).includes(type)) {
    return [{ code: 'unknown-type', message: `"${type}" is not a message type; STATUS belongs to status/, not messages/` }]
  }

  // id and supersedes (SPEC "字段约定", PR-6). Format is per message; uniqueness
  // and "only your own messages" are channel-wide and live in checkIdentities.
  const identity = fields['id']
  if (identity !== undefined) {
    if (typeof identity !== 'string' || !ID_RE.test(identity)) {
      errors.push({ code: 'bad-id', message: `"id" must look like G-0042, L-0107 or H-0003; got ${JSON.stringify(identity)}` })
    } else if (!identity.startsWith(ID_PREFIX[sender])) {
      errors.push({ code: 'bad-id', message: `id ${identity} does not carry the ${sender} prefix ${ID_PREFIX[sender]}` })
    }
  }
  const supersedes = fields['supersedes']
  if (supersedes !== undefined) {
    if (!Array.isArray(supersedes) || supersedes.some((item) => typeof item !== 'string' || !ID_RE.test(item))) {
      errors.push({ code: 'bad-supersedes', message: '"supersedes" must be a list of ids like G-0042' })
    }
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
      if (Object.prototype.hasOwnProperty.call(fields, 'checkpoint')) {
        check(typeof fields['checkpoint'] === 'boolean', 'checkpoint', 'a boolean')
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'meanwhile')) {
        check(isStringArray(fields['meanwhile']), 'meanwhile', 'a list of strings')
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'open_questions')) {
        check(isStringArray(fields['open_questions']), 'open_questions', 'a list of strings')
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
      const patchName = attachmentNameProblem(fields['name'])
      check(patchName === undefined, 'name', `a plain attachment file name (${patchName ?? ''})`)
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
        probes.forEach((item, index) => {
          const good =
            isRecord(item) &&
            typeof item['name'] === 'string' &&
            item['name'].length > 0 &&
            typeof item['expected'] === 'string' &&
            typeof item['actual'] === 'string' &&
            typeof item['pass'] === 'boolean'
          check(good, `probes[${String(index)}]`, '{name: string, expected: string, actual: string, pass: boolean}')
        })
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

/**
 * Channel-wide identity rules (SPEC "字段约定", PR-6).
 *
 * A per-message check cannot see these: an id has to be unique across the whole
 * channel, and `supersedes` may only point at messages the same sender wrote.
 * @param messages - parsed messages in ascending sequence order.
 * @returns one entry per violation, each naming the offending sequence.
 */
export function checkIdentities(messages: readonly ParsedMessage[]): MessageError[] {
  const errors: MessageError[] = []
  const owner = new Map<string, { seq: string; sender: string }>()

  for (const message of messages) {
    const id = message.fields['id']
    if (typeof id !== 'string') continue
    const seen = owner.get(id)
    if (seen !== undefined) {
      errors.push({
        code: 'duplicate-id',
        message: `id ${id} appears in ${seen.seq} and ${message.seq}; ids are unique per sender and never reused`,
      })
    } else {
      owner.set(id, { seq: message.seq, sender: message.sender })
    }
  }

  for (const message of messages) {
    const supersedes = message.fields['supersedes']
    if (!Array.isArray(supersedes)) continue
    for (const target of supersedes) {
      if (typeof target !== 'string') continue
      const seen = owner.get(target)
      if (seen === undefined) {
        errors.push({ code: 'unknown-supersedes', message: `${message.seq} supersedes ${target}, which no message in the channel carries` })
      } else if (seen.sender !== message.sender) {
        errors.push({
          code: 'foreign-supersedes',
          message: `${message.seq} (${message.sender}) may not supersede ${target}, which ${seen.sender} wrote in ${seen.seq}`,
        })
      }
    }
  }

  return errors
}
