/**
 * The rules `lg_directive`, `lg_review` and `lg_decision` enforce before a
 * message is written. Pure functions: every refusal can be tested without a
 * channel, a mirror or a model.
 *
 * Each check collects *all* its problems so one refusal tells the model
 * everything to fix.
 */
import type { ParsedMessage } from '@local-global/lg-protocol'

/** A spec requirement id such as `GD-1` or `QA-4`. */
const REQUIREMENT_ID = /\b[A-Z]{2,3}-\d+\b/gu
/** Prefixes that look like requirement ids but are not (`AC-1` is a criterion, `UTF-8` an encoding). */
const NOT_REQUIREMENTS = new Set(['AC', 'UTF', 'SHA', 'ISO', 'RFC'])

/** The distinct requirement ids a text cites. */
export function citedRequirements(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(REQUIREMENT_ID)) {
    if (!NOT_REQUIREMENTS.has(match[0].split('-')[0] ?? '')) found.add(match[0])
  }
  return [...found]
}

/**
 * The requirement ids a spec defines: the first cell of its requirement tables
 * (`| GD-1 | ... |`), or every id it mentions when it has no such table.
 */
export function specRequirementIds(spec: string): Set<string> {
  const defined = new Set<string>()
  for (const match of spec.matchAll(/^\|\s*([A-Z]{2,3}-\d+)\s*\|/gmu)) defined.add(match[1] ?? '')
  return defined.size > 0 ? defined : new Set(citedRequirements(spec))
}

/**
 * Phrases that make a DIRECTIVE field depend on an earlier version instead of
 * stating the work. A DIRECTIVE replaces the previous one as a whole, so every
 * goal, priority, criterion and scope entry must stand on its own.
 */
const DELTA: readonly (readonly [RegExp, string])[] = [
  [/\bdirective\s*(?:#|v(?:ersion)?\s*)?\d+\b/iu, 'names another DIRECTIVE version'],
  [/\bv\d+\s+(?:directive|acceptance|criteria|priorities|goal|scope)\b/iu, 'names another DIRECTIVE version'],
  [/\b(?:previous|prior|last|earlier|former|preceding)\s+(?:directive|version|acceptance|criteria|criterion|priorities|goal|scope)\b/iu, 'points at the previous version'],
  [
    /\b(?:same as|as in|as per|unchanged from|carry(?:ing)? over|carried over|continue with|on top of|in addition to)\b[^.\n]{0,40}\b(?:directive|acceptance|criteria|priorities|goal|scope|AC-\d+|v\d+)\b/iu,
    'refers to existing criteria instead of restating them',
  ],
  [/\b(?:incremental|delta|addendum|amendment)\b/iu, 'is phrased as an amendment'],
  [/上一版|上个版本|上一个版本|前一版|旧版|之前的?(?:指令|版本|验收)|原(?:有|来)的?(?:验收|优先级|目标|范围|标准)/u, 'points at the previous version'],
  [/(?:验收标准|验收|优先级|目标|范围|指令)[^。\n]{0,8}(?:同上|同前|不变|沿用|照旧)|同上|同前|沿用上/u, 'refers to existing criteria instead of restating them'],
  [/增量|追加指令|补充指令/u, 'is phrased as an amendment'],
]

/** Why a piece of DIRECTIVE text reads as incremental, or undefined. */
export function incrementalReason(text: string): string | undefined {
  for (const [pattern, why] of DELTA) if (pattern.test(text)) return why
  return undefined
}

/** The fields of a DIRECTIVE the tool writes. */
export interface DirectiveFields {
  readonly goal: string
  readonly priorities: string[]
  readonly acceptance: { id: string; text: string }[]
  readonly scope: { in: string[]; out: string[] }
}

/** Outcome of a rule check: the fields to write, or every problem found. */
export type Checked<T> = { readonly ok: true; readonly fields: T } | { readonly ok: false; readonly problems: string[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A non-empty string, trimmed. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function stringList(value: unknown, label: string, problems: string[], options: { allowEmpty?: boolean } = {}): string[] {
  if (!Array.isArray(value)) {
    problems.push(`${label} is missing; it must be a list of strings`)
    return []
  }
  const out: string[] = []
  value.forEach((item, index) => {
    const text = nonEmpty(item)
    if (text === undefined) problems.push(`${label}[${String(index + 1)}] is empty or not a string`)
    else out.push(text)
  })
  if (out.length === 0 && options.allowEmpty !== true && problems.every((problem) => !problem.startsWith(`${label}[`))) problems.push(`${label} must not be empty`)
  return out
}

/**
 * Check a DIRECTIVE against GD-1: complete, non-incremental, and every
 * criterion tied to a requirement of the spec.
 * @param input - what the model passed.
 * @param spec - requirement ids the spec defines, or undefined when it could not be read (then the pattern alone decides).
 */
export function checkDirective(
  input: { goal?: unknown; priorities?: unknown; acceptance?: unknown; scope?: unknown },
  spec: ReadonlySet<string> | undefined,
): Checked<DirectiveFields> {
  const problems: string[] = []
  const goal = nonEmpty(input.goal)
  if (goal === undefined) problems.push('goal is missing or empty')
  const priorities = stringList(input.priorities, 'priorities', problems)

  const acceptance: { id: string; text: string }[] = []
  if (!Array.isArray(input.acceptance) || input.acceptance.length === 0) {
    problems.push('acceptance is missing or empty; a DIRECTIVE needs at least one criterion')
  } else {
    input.acceptance.forEach((item, index) => {
      const want = `AC-${String(index + 1)}`
      const text = nonEmpty(isRecord(item) ? item['text'] : item)
      if (text === undefined) {
        problems.push(`acceptance[${String(index + 1)}] has no text`)
        return
      }
      const id = isRecord(item) && item['id'] !== undefined ? item['id'] : want
      // A DIRECTIVE restates every criterion, so numbering always starts at AC-1; a list that
      // starts later (or skips) is a delta against the previous version.
      if (id !== want) problems.push(`acceptance[${String(index + 1)}] has id ${JSON.stringify(id)}; a DIRECTIVE is a complete replacement, number the criteria AC-1, AC-2, ... in order (expected ${want})`)
      acceptance.push({ id: want, text })
    })
  }

  const scopeInput = input.scope
  let scopeIn: string[] = []
  let scopeOut: string[] = []
  if (!isRecord(scopeInput)) problems.push('scope is missing; it must be {in: [...], out: [...]}')
  else {
    scopeIn = stringList(scopeInput['in'], 'scope.in', problems)
    scopeOut = stringList(scopeInput['out'], 'scope.out', problems, { allowEmpty: true })
  }

  for (const [label, text] of [
    ['goal', goal ?? ''],
    ...priorities.map((priority, index): [string, string] => [`priorities[${String(index + 1)}]`, priority]),
    ...acceptance.map((entry): [string, string] => [entry.id, entry.text]),
    ...scopeIn.map((entry, index): [string, string] => [`scope.in[${String(index + 1)}]`, entry]),
    ...scopeOut.map((entry, index): [string, string] => [`scope.out[${String(index + 1)}]`, entry]),
  ] as [string, string][]) {
    const why = incrementalReason(text)
    if (why !== undefined) problems.push(`${label} ${why}; a DIRECTIVE replaces the previous one, so restate the work in full instead of referring to an earlier version`)
  }

  for (const entry of acceptance) {
    const cited = citedRequirements(entry.text)
    if (cited.length === 0) {
      problems.push(`${entry.id} cites no spec requirement id; name the requirement it verifies, e.g. "GD-1"`)
      continue
    }
    if (spec !== undefined) {
      const unknown = cited.filter((id) => !spec.has(id))
      if (unknown.length > 0) problems.push(`${entry.id} cites ${unknown.join(', ')}, which the spec does not define`)
    }
  }

  if (problems.length > 0 || goal === undefined) return { ok: false, problems }
  return { ok: true, fields: { goal, priorities, acceptance, scope: { in: scopeIn, out: scopeOut } } }
}

/** The fields of a REVIEW the tool writes. */
export interface ReviewFields {
  readonly refs: string[]
  readonly verdict: 'accepted' | 'changes-requested'
  readonly findings: { id: string; severity: 'blocking' | 'minor'; text: string }[]
}

/**
 * Check a REVIEW. Findings are numbered here, F-1 upward *within this REVIEW*:
 * every REVIEW restarts at F-1 and a REPORT resolves `<review seq>/F-<n>` (PR-7).
 * @param input - what the model passed.
 * @param known - sequences of every message in the channel.
 */
export function checkReview(input: { refs?: unknown; verdict?: unknown; findings?: unknown }, known: ReadonlySet<string>): Checked<ReviewFields> {
  const problems: string[] = []
  const refs: string[] = []
  if (!Array.isArray(input.refs) || input.refs.length === 0) problems.push('refs is missing or empty; name the messages this REVIEW is about, e.g. ["0042"]')
  else {
    for (const ref of input.refs) {
      if (typeof ref !== 'string' || !/^\d{4}$/u.test(ref)) problems.push(`refs entry ${JSON.stringify(ref)} is not a four-digit sequence`)
      else if (!known.has(ref)) problems.push(`refs entry ${ref} is not a message in the channel`)
      else if (!refs.includes(ref)) refs.push(ref)
    }
  }
  const verdict = input.verdict
  if (verdict !== 'accepted' && verdict !== 'changes-requested') problems.push('verdict must be "accepted" or "changes-requested"')

  const findings: ReviewFields['findings'] = []
  if (!Array.isArray(input.findings)) problems.push('findings is missing; pass a list (empty when there is nothing to raise)')
  else {
    input.findings.forEach((item, index) => {
      const id = `F-${String(index + 1)}`
      const text = nonEmpty(isRecord(item) ? item['text'] : undefined)
      const severity = isRecord(item) ? item['severity'] : undefined
      if (text === undefined) problems.push(`findings[${String(index + 1)}] has no text`)
      if (severity !== 'blocking' && severity !== 'minor') problems.push(`findings[${String(index + 1)}].severity must be "blocking" or "minor"`)
      if (isRecord(item) && item['id'] !== undefined && item['id'] !== id) problems.push(`findings[${String(index + 1)}] has id ${JSON.stringify(item['id'])}; the tool numbers findings, this one is ${id}`)
      if (text !== undefined && (severity === 'blocking' || severity === 'minor')) findings.push({ id, severity, text })
    })
  }
  if (verdict === 'accepted' && findings.some((finding) => finding.severity === 'blocking')) problems.push('verdict "accepted" cannot carry a blocking finding')
  if (verdict === 'changes-requested' && Array.isArray(input.findings) && input.findings.length === 0) problems.push('verdict "changes-requested" needs at least one finding saying what to change')

  if (problems.length > 0 || (verdict !== 'accepted' && verdict !== 'changes-requested')) return { ok: false, problems }
  return { ok: true, fields: { refs, verdict, findings } }
}

/** The fields of a DECISION the tool writes. */
export interface DecisionFields {
  readonly answers: string[]
  readonly choice: string
  readonly reason: string
  readonly approve_action?: string
}

const FINGERPRINT = /^\S+:[0-9a-f]{12}$/u

/**
 * Check a DECISION: it may only answer items that are still open, and an
 * approval has to be for the very action the question named.
 * @param input - what the model passed.
 * @param open - the QUESTIONs and OBJECTIONs no DECISION has answered yet.
 */
export function checkDecision(
  input: { answers?: unknown; choice?: unknown; reason?: unknown; approve_action?: unknown },
  open: readonly ParsedMessage[],
): Checked<DecisionFields> {
  const problems: string[] = []
  const answers: string[] = []
  const answered: ParsedMessage[] = []
  if (!Array.isArray(input.answers) || input.answers.length === 0) problems.push('answers is missing or empty; name the open QUESTION or OBJECTION sequences')
  else {
    for (const seq of input.answers) {
      if (typeof seq !== 'string' || !/^\d{4}$/u.test(seq)) {
        problems.push(`answers entry ${JSON.stringify(seq)} is not a four-digit sequence`)
        continue
      }
      const target = open.find((message) => message.seq === seq)
      if (target === undefined) problems.push(`#${seq} is not an open QUESTION or OBJECTION (it does not exist, is not one, or is already answered)`)
      else if (!answers.includes(seq)) {
        answers.push(seq)
        answered.push(target)
      }
    }
  }
  const choice = nonEmpty(input.choice)
  if (choice === undefined) problems.push('choice is missing or empty')
  const reason = nonEmpty(input.reason)
  if (reason === undefined) problems.push('reason is missing or empty')

  let approve: string | undefined
  if (input.approve_action !== undefined) {
    if (typeof input.approve_action !== 'string' || !FINGERPRINT.test(input.approve_action)) {
      problems.push('approve_action must be an action fingerprint like "force-push:0123456789ab"')
    } else {
      approve = input.approve_action
      const actions = answered.map((message) => message.fields['action']).filter((action): action is string => typeof action === 'string')
      if (actions.length === 0) problems.push('approve_action given, but none of the answered questions carries an action fingerprint to approve')
      else if (actions.some((action) => action !== approve)) {
        problems.push(`approve_action ${approve} does not match the fingerprint the question asked about (${[...new Set(actions)].join(', ')})`)
      }
    }
  }

  if (problems.length > 0 || choice === undefined || reason === undefined) return { ok: false, problems }
  return { ok: true, fields: { answers, choice, reason, ...(approve === undefined ? {} : { approve_action: approve }) } }
}
