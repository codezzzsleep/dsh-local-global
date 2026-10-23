/**
 * `lg-report-gate` — a turn may not end while something is unreported.
 *
 * On `agent/turn-stopping`, if the work of this turn is not represented in the
 * channel, the gate steers one prompt asking for a REPORT before the turn
 * closes. The conditions, from the SPEC (RG-1, AG-1):
 *
 * 1. HEAD is in no REPORT's `commit`.
 * 2. The newest DIRECTIVE's version is not confirmed by any REPORT.
 * 3. Evidence was produced this turn without a manifest — asked of the evidence plugin.
 * 4. A blocking finding is unresolved while the turn claims completion.
 * 5. An approval was spent that no REPORT lists in `consumed_approvals`.
 *
 * It fails closed: if HEAD or the channel cannot be read that is itself a
 * reason. It cannot steer forever: after `maxSteersPerTurn` reminders in one
 * turn it logs what is still open and lets the turn end.
 *
 * Without lg-channel there is nothing to compare against, so the gate is
 * inactive and says so in the log (it is installed with the Local bundle but
 * only means something next to lg-channel from @local-global/dsh-lg-common).
 */
import { execFileSync } from 'node:child_process'

import { foldChannel, type ParsedMessage } from '@local-global/lg-protocol'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` is declared in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

import { service, sessionCwd } from './common.js'
import type { ActionGateService } from './action-gate.js'

export const name = 'lg-report-gate'

/** What the gate needs to know about the channel. */
export interface GateFacts {
  readonly head: string
  /** Why HEAD could not be read; `head` is empty then. */
  readonly headError?: string
  readonly reportedCommits: readonly string[]
  readonly directiveVersion?: number
  readonly reportedDirectiveVersions: readonly number[]
  readonly unresolvedBlocking: number
  /** Whether the turn's last message claims the work is done; absent means unknown, treated as a claim. */
  readonly claimsCompletion?: boolean
  /** Spent approvals (DECISION sequences) that no REPORT lists in `consumed_approvals`. */
  readonly unreportedApprovals?: readonly string[]
}

/**
 * Which conditions hold.
 *
 * Pure so each can be tested without a live channel or agent.
 * @param facts - the folded channel facts.
 * @param missingManifests - evidence topics the evidence plugin says lack a manifest.
 * @returns the conditions that hold, in the SPEC's order.
 */
export function gateReasons(facts: GateFacts, missingManifests: readonly string[] = []): string[] {
  const reasons: string[] = []
  if (facts.headError !== undefined) reasons.push(`HEAD cannot be read (${facts.headError}); fix the worktree or say why in the REPORT`)
  else if (!facts.reportedCommits.includes(facts.head)) reasons.push(`HEAD ${facts.head.slice(0, 12)} is in no REPORT`)
  if (facts.directiveVersion !== undefined && !facts.reportedDirectiveVersions.includes(facts.directiveVersion)) {
    reasons.push(`DIRECTIVE v${String(facts.directiveVersion)} is not confirmed by any REPORT`)
  }
  if (missingManifests.length > 0) reasons.push(`evidence without a manifest: ${missingManifests.join(', ')}`)
  if (facts.unresolvedBlocking > 0 && facts.claimsCompletion !== false) {
    reasons.push(`${String(facts.unresolvedBlocking)} blocking finding(s) unresolved while the turn claims completion`)
  }
  const unreported = facts.unreportedApprovals ?? []
  if (unreported.length > 0) reasons.push(`approval(s) spent but not in any REPORT's consumed_approvals: ${unreported.join(', ')}`)
  return reasons
}

/** The prompt the gate steers. */
export function gateMessage(reasons: readonly string[], lastReminder = false): string {
  return [
    'lg-report-gate: 这个回合还不能结束——以下事项尚未在频道里体现：',
    ...reasons.map((reason) => `- ${reason}`),
    '先发一条 REPORT（字段区带 commit 与 directive_version，证据要有清单，用过的批准写进 consumed_approvals），再结束回合。',
    ...(lastReminder ? ['这是本回合最后一次提醒：如果确实无法发出 REPORT，请在最终回复里写明原因。'] : []),
  ].join('\n')
}

const NEGATED =
  /\b(?:not|n't|never|no longer|yet to|isn't|hasn't|haven't|wasn't|won't)\b[^.!?\n]{0,30}?\b(?:done|complete[d]?|finished|ready|fixed|resolved|implemented)\b|(?:尚未|未能|没有|没能|还没|并未|不)[^。！？\n]{0,6}?(?:完成|做完|修复|解决|实现)|未(?:完成|修复|解决)/gi
const COMPLETED =
  /\b(?:done|complete[d]?|finished|ready (?:for|to)|all set|fixed|resolved|implemented|wrapped up|good to go|shipped|all (?:tests )?pass(?:es|ing)?)\b|完成|做完|搞定|已修复|已解决|已实现|全部通过|可以验收|收工/i

/**
 * Whether a message claims the work is finished.
 * @param text - the turn's last assistant text; `undefined` when unknown.
 * @returns true for a completion claim; unknown text counts as one (fail closed).
 */
export function claimsCompletion(text: string | undefined): boolean {
  if (text === undefined) return true
  return COMPLETED.test(text.replace(NEGATED, ' '))
}

/** The slice of the channel runtime the gate reads. */
interface ChannelFacts {
  all?: () => Promise<readonly ParsedMessage[]>
}

/** What `collectFacts` takes besides the channel and HEAD. */
export interface FactsExtra {
  /** DECISION sequences the approval ledger says were spent. */
  readonly consumed?: readonly string[]
  readonly claimsCompletion?: boolean
  readonly headError?: string
}

/** Fold the channel messages into the facts the gate judges. */
export async function collectFacts(channel: ChannelFacts, head: string, extra: FactsExtra = {}): Promise<GateFacts> {
  // The channel is untrusted input: only valid messages count as a report, a
  // directive or a finding, so a malformed or misattributed REPORT cannot
  // satisfy the gate (PR-2, PR-6).
  const view = foldChannel((await channel.all?.()) ?? [])
  const reportedCommits: string[] = []
  const reportedDirectiveVersions: number[] = []
  const reportedApprovals = new Set<string>()
  let directiveVersion: number | undefined
  for (const message of view.analysis.effective) {
    if (message.type === 'REPORT') {
      const commit = message.fields['commit']
      if (typeof commit === 'string') reportedCommits.push(commit)
      const version = message.fields['directive_version']
      if (typeof version === 'number') reportedDirectiveVersions.push(version)
      const consumed = message.fields['consumed_approvals']
      if (Array.isArray(consumed)) for (const decision of consumed) if (typeof decision === 'string') reportedApprovals.add(decision)
    }
    if (message.type === 'DIRECTIVE') {
      const version = message.fields['version']
      if (typeof version === 'number' && (directiveVersion === undefined || version > directiveVersion)) directiveVersion = version
    }
  }
  const unresolvedBlocking = view.unresolvedFindings.filter((entry) => entry.finding.severity === 'blocking').length
  return {
    head,
    ...(extra.headError === undefined ? {} : { headError: extra.headError }),
    reportedCommits,
    ...(directiveVersion === undefined ? {} : { directiveVersion }),
    reportedDirectiveVersions,
    unresolvedBlocking,
    ...(extra.claimsCompletion === undefined ? {} : { claimsCompletion: extra.claimsCompletion }),
    unreportedApprovals: (extra.consumed ?? []).filter((decision) => !reportedApprovals.has(decision)),
  }
}

/** Config for `lg-report-gate`. */
export interface RawReportGateConfig {
  readonly maxSteersPerTurn?: unknown
}

/** Reminders one turn gets before the gate gives up and only logs. */
export const DEFAULT_MAX_STEERS = 3

interface TurnState {
  turn: number
  steers: number
  /** Evidence written after this instant counts as this turn's. */
  since: number
  lastStop: number
}

export function apply(ctx: Context, raw: RawReportGateConfig = {}): void {
  const limit = typeof raw.maxSteersPerTurn === 'number' && Number.isInteger(raw.maxSteersPerTurn) && raw.maxSteersPerTurn >= 0 ? raw.maxSteersPerTurn : DEFAULT_MAX_STEERS
  const log = (level: 'warn' | 'info', message: string): void => {
    ;(ctx.logger?.('lg-report-gate') as unknown as Record<string, ((text: string) => void) | undefined> | undefined)?.[level]?.(message)
  }
  const startedAt = Date.now()
  const turns = new WeakMap<object, TurnState>()
  const lastText = new WeakMap<object, string>()
  const liveText = new WeakMap<object, string>()
  let warnedNoChannel = false

  // The turn's last assistant message, to tell a completion claim from a status update.
  ctx.on(
    'agent/assistant-stream',
    (payload: { agent: object; frame: { type: string; chunk?: { type?: string; text?: string }; outcome?: { kind?: string } } }) => {
      const { agent, frame } = payload
      if (frame.type === 'start') liveText.set(agent, '')
      else if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') liveText.set(agent, `${liveText.get(agent) ?? ''}${frame.chunk.text ?? ''}`)
      else if (frame.type === 'end' && frame.outcome?.kind === 'committed') lastText.set(agent, liveText.get(agent) ?? '')
    },
  )

  ctx.on('agent/turn-stopping', async (payload: { agent: object; turn: number }) => {
    const agent = payload.agent
    const channel = service<ChannelFacts>(ctx, 'lgChannel')
    if (channel?.all === undefined) {
      if (!warnedNoChannel) {
        warnedNoChannel = true
        log('warn', 'lg-report-gate: lg-channel is not composed, so there is nothing to report to; the gate is inactive (install @local-global/dsh-lg-common)')
      }
      return
    }

    const now = Date.now()
    const previous = turns.get(agent)
    const state: TurnState =
      previous === undefined
        ? { turn: payload.turn, steers: 0, since: startedAt, lastStop: now }
        : previous.turn === payload.turn
          ? previous
          : { turn: payload.turn, steers: 0, since: previous.lastStop, lastStop: now }
    state.lastStop = now
    turns.set(agent, state)

    const cwd = sessionCwd(ctx, agent)
    let head = ''
    let headError: string | undefined
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch (error) {
      headError = `git rev-parse HEAD in ${cwd}: ${(error as { stderr?: Buffer | string }).stderr?.toString().trim() || (error instanceof Error ? error.message : String(error))}`
    }

    const evidence = service<{ missingManifests?: (sinceMs?: number) => readonly string[] }>(ctx, 'lgEvidence')
    const gate = service<ActionGateService>(ctx, 'lgActionGate')
    let reasons: string[]
    try {
      const consumed = gate?.consumed?.().map((entry) => entry.decision) ?? []
      const facts = await collectFacts(channel, head, {
        consumed,
        claimsCompletion: claimsCompletion(lastText.get(agent)),
        ...(headError === undefined ? {} : { headError }),
      })
      reasons = gateReasons(facts, evidence?.missingManifests?.(state.since) ?? [])
    } catch (error) {
      reasons = [`the channel or the approval record cannot be read (${error instanceof Error ? error.message : String(error)})`]
    }
    if (reasons.length === 0) return

    state.steers += 1
    if (state.steers > limit) {
      log('warn', `lg-report-gate: ending turn ${String(payload.turn)} with ${String(reasons.length)} open item(s) after ${String(limit)} reminder(s): ${reasons.join('; ')}`)
      return
    }
    ;(agent as { steer?: (message: unknown) => void }).steer?.({
      id: `${String(payload.turn)}-lg-report-gate-${String(state.steers)}`,
      role: 'user',
      content: [{ type: 'text', text: gateMessage(reasons, state.steers === limit) }],
      source: { kind: 'user' },
    })
  })
}
