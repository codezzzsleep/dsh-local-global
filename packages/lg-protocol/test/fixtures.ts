import { formatMessage, parseMessage, type MessageType, type ParsedMessage, type Sender } from '../src/index.js'

/** A minimal message of each type that satisfies channel-git.md §4. */
export const VALID_FIELDS: Record<MessageType, Record<string, unknown>> = {
  TASK: { goal: 'ship M1', constraints: ['no forks'], budget: { max_hours: 4, max_rounds: 20 } },
  REPORT: {
    refs: ['0001'],
    commit: '7c9ce1e63a4a750a16407727e20a8d5028b02a59',
    directive_version: 1,
    evidence: [],
    negative_tests: [],
  },
  QUESTION: { options: ['A', 'B'], blocking: false, default_action: 'wait' },
  DECISION: { answers: ['0003'], choice: 'A', reason: 'because' },
  DIRECTIVE: {
    version: 1,
    goal: 'ship M1',
    priorities: ['P1'],
    acceptance: [{ id: 'AC-1', text: 'passes' }],
    scope: { in: ['packages'], out: [] },
  },
  PATCH: {
    name: 'docs.patch',
    claim: '0003',
    base: '7c9ce1e63a4a750a16407727e20a8d5028b02a59',
    format: 'git-format-patch',
    bytes: 12,
    sha256: 'f'.repeat(64),
  },
  CLAIM: { scope: ['docs/design.md'], implementer: 'global' },
  OBJECTION: { target: '0002', evidence: ['x'] },
  CORRECTION: { corrects: '0002', replacement: 'new text' },
  REVIEW: { refs: ['0002'], verdict: 'changes-requested', findings: [{ id: 'F-1', severity: 'blocking', text: 'fix it' }] },
  ISOLATION_REPORT: { probes: [{ name: 'read-host', expected: 'fail', actual: 'fail', pass: true }] },
  STOP: { final_commit: '7c9ce1e63a4a750a16407727e20a8d5028b02a59', acceptance: [{ id: 'AC-1', evidence: ['evidence/x'] }] },
  HALT: { reason: 'human stop' },
}

/** The sender that is allowed to write each type. */
export const PRIMARY_SENDER: Record<MessageType, Sender> = {
  TASK: 'human',
  REPORT: 'local',
  QUESTION: 'local',
  DECISION: 'global',
  DIRECTIVE: 'global',
  PATCH: 'global',
  CLAIM: 'global',
  OBJECTION: 'local',
  CORRECTION: 'local',
  REVIEW: 'global',
  ISOLATION_REPORT: 'global',
  STOP: 'global',
  HALT: 'human',
}

/** Build one parsed message for a type, optionally with fields removed. */
export function makeMessage(
  type: MessageType,
  options: {
    seq?: string
    sender?: Sender
    fields?: Record<string, unknown>
    drop?: readonly string[]
  } = {},
): ParsedMessage {
  const seq = options.seq ?? '0003'
  const sender = options.sender ?? PRIMARY_SENDER[type]
  const fields = { ...(options.fields ?? VALID_FIELDS[type]) }
  for (const field of options.drop ?? []) delete fields[field]
  const formatted = formatMessage({ seq, sender, type, fields, body: 'body text' })
  const parsed = parseMessage(formatted.filename, formatted.text)
  if (!parsed.ok) throw new Error(`fixture for ${type} did not parse: ${JSON.stringify(parsed.errors)}`)
  return parsed.message
}
