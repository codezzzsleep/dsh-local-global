/**
 * Message vocabulary. Deliberately small: five things flow between the two
 * sides (reports, questions, directives, verdicts, flags) plus human tasks
 * and free notes.
 *
 * These rules check that traffic is well-formed and that each side uses the
 * channel the way it is meant to. They are a contract, not a security
 * boundary; see README.md for what actually isolates Global.
 */

export const ROLES = Object.freeze(['local', 'global', 'human'])

export const RULES = Object.freeze({
  report: { from: ['local'], to: ['global'] },
  question: { from: ['local'], to: ['global'] },
  directive: { from: ['global'], to: ['local'] },
  verdict: { from: ['global'], to: ['local'] },
  flag: { from: ['global'], to: ['human'] },
  task: { from: ['human'], to: ['local', 'global'] },
  note: { from: ['local', 'global', 'human'], to: ['local', 'global', 'human'] },
})

export const STATUSES = Object.freeze(['progress', 'done', 'blocked', 'objection'])
export const VERDICTS = Object.freeze(['accepted', 'needs_work', 'unverified'])

export const ID_RE = /^\d{15}-[0-9a-f]{8}$/
export const COMMIT_RE = /^[0-9a-f]{40}$/
/** Only work branches can be published; the code sandbox enforces the same rule. */
export const WORK_BRANCH_RE = /^work\/[A-Za-z0-9._/-]{1,80}$/

export const LIMITS = Object.freeze({
  summaryChars: 500,
  bodyChars: 20000,
  artifacts: 20,
  artifactBytes: 5 * 1024 * 1024,
  listItems: 20,
})

export class ProtocolError extends Error {
  constructor(errors) {
    super(`invalid message: ${errors.join('; ')}`)
    this.name = 'ProtocolError'
    this.errors = errors
  }
}

function isStringArray(value, max) {
  return Array.isArray(value) && value.length <= max && value.every((v) => typeof v === 'string')
}

/** Throws ProtocolError listing every problem; returns the message when valid. */
export function validateMessage(m) {
  if (!m || typeof m !== 'object') throw new ProtocolError(['message must be an object'])
  const errors = []

  const rule = RULES[m.kind]
  if (!rule) {
    errors.push(`unknown kind: ${m.kind}`)
  } else {
    if (!rule.from.includes(m.from)) errors.push(`${m.kind} cannot be sent by ${m.from}`)
    if (!rule.to.includes(m.to)) errors.push(`${m.kind} cannot be sent to ${m.to}`)
  }

  if (typeof m.summary !== 'string' || m.summary.trim() === '') {
    errors.push('summary is required')
  } else if (m.summary.length > LIMITS.summaryChars) {
    errors.push(`summary longer than ${LIMITS.summaryChars} characters`)
  }

  if (m.body !== undefined && (typeof m.body !== 'string' || m.body.length > LIMITS.bodyChars)) {
    errors.push(`body must be a string of at most ${LIMITS.bodyChars} characters`)
  }
  if (m.id !== undefined && !(typeof m.id === 'string' && ID_RE.test(m.id))) {
    errors.push('id is malformed')
  }
  if (m.re !== undefined && !(typeof m.re === 'string' && ID_RE.test(m.re))) {
    errors.push('re must be a message id')
  }
  if (m.status !== undefined && !STATUSES.includes(m.status)) {
    errors.push(`status must be one of ${STATUSES.join(', ')}`)
  }
  if (m.verdict !== undefined && !VERDICTS.includes(m.verdict)) {
    errors.push(`verdict must be one of ${VERDICTS.join(', ')}`)
  }
  if (m.kind === 'verdict' && m.re === undefined) {
    errors.push('a verdict must name the message it judges (re)')
  }
  if (m.artifacts !== undefined && !Array.isArray(m.artifacts)) {
    errors.push('artifacts must be an array')
  }
  if (m.acceptance !== undefined && !isStringArray(m.acceptance, LIMITS.listItems)) {
    errors.push(`acceptance must be an array of at most ${LIMITS.listItems} strings`)
  }
  if (m.findings !== undefined && !isStringArray(m.findings, LIMITS.listItems)) {
    errors.push(`findings must be an array of at most ${LIMITS.listItems} strings`)
  }

  if (m.commit !== undefined && m.commit !== null && !(typeof m.commit === 'string' && COMMIT_RE.test(m.commit))) {
    errors.push('commit must be a full 40-character sha')
  }
  if (
    m.published_branch !== undefined &&
    m.published_branch !== null &&
    !(typeof m.published_branch === 'string' && WORK_BRANCH_RE.test(m.published_branch))
  ) {
    errors.push('published_branch must be a work/* branch')
  }
  if (m.dirty !== undefined && typeof m.dirty !== 'boolean') errors.push('dirty must be a boolean')
  if (m.client_id !== undefined && !(typeof m.client_id === 'string' && m.client_id.length > 0 && m.client_id.length <= 80)) {
    errors.push('client_id must be a string of 1 to 80 characters')
  }

  if (errors.length > 0) throw new ProtocolError(errors)
  return m
}
