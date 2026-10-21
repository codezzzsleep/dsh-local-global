/**
 * `lg-report-gate` — a turn may not end while something is unreported.
 *
 * On `agent/turn-stopping`, if the work of this turn is not represented in the
 * channel, the gate steers one prompt asking for a REPORT before the turn
 * closes. Four conditions, from the SPEC (RG-1):
 *
 * 1. HEAD is in no REPORT's `commit`.
 * 2. The newest DIRECTIVE's version is not confirmed by any REPORT.
 * 3. Evidence was produced without a manifest — asked of the evidence plugin.
 * 4. A blocking finding is unresolved while the turn claims completion.
 */
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` is declared in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'lg-report-gate'

/** What the gate needs to know about the channel. */
export interface GateFacts {
  readonly head: string
  readonly reportedCommits: readonly string[]
  readonly directiveVersion?: number
  readonly reportedDirectiveVersions: readonly number[]
  readonly unresolvedBlocking: number
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
  if (!facts.reportedCommits.includes(facts.head)) reasons.push(`HEAD ${facts.head.slice(0, 12)} is in no REPORT`)
  if (facts.directiveVersion !== undefined && !facts.reportedDirectiveVersions.includes(facts.directiveVersion)) {
    reasons.push(`DIRECTIVE v${String(facts.directiveVersion)} is not confirmed by any REPORT`)
  }
  if (missingManifests.length > 0) reasons.push(`evidence without a manifest: ${missingManifests.join(', ')}`)
  if (facts.unresolvedBlocking > 0) reasons.push(`${String(facts.unresolvedBlocking)} blocking finding(s) unresolved`)
  return reasons
}

/** The prompt the gate steers. */
export function gateMessage(reasons: readonly string[]): string {
  return [
    'lg-report-gate: 这个回合还不能结束——以下事项尚未在频道里体现：',
    ...reasons.map((reason) => `- ${reason}`),
    '先发一条 REPORT（字段区带 commit 与 directive_version，证据要有清单），再结束回合。',
  ].join('\n')
}

/** The slice of the channel runtime the gate reads. */
interface ChannelFacts {
  all: () => Promise<readonly { seq: string; type: string; fields: Readonly<Record<string, unknown>> }[]>
  head?: () => Promise<string>
}

/** Fold the channel messages into the facts the gate judges. */
export async function collectFacts(channel: ChannelFacts, head: string): Promise<GateFacts> {
  const messages = await channel.all()
  const reportedCommits: string[] = []
  const reportedDirectiveVersions: number[] = []
  let directiveVersion: number | undefined
  for (const message of messages) {
    if (message.type === 'REPORT') {
      const commit = message.fields['commit']
      if (typeof commit === 'string') reportedCommits.push(commit)
      const version = message.fields['directive_version']
      if (typeof version === 'number') reportedDirectiveVersions.push(version)
    }
    if (message.type === 'DIRECTIVE') {
      const version = message.fields['version']
      if (typeof version === 'number' && (directiveVersion === undefined || version > directiveVersion)) directiveVersion = version
    }
  }
  const { foldState } = await import('@local-global/lg-protocol')
  const state = foldState(messages as never)
  const unresolvedBlocking = state.unresolvedFindings.filter((entry) => entry.finding.severity === 'blocking').length
  return {
    head,
    reportedCommits,
    ...(directiveVersion === undefined ? {} : { directiveVersion }),
    reportedDirectiveVersions,
    unresolvedBlocking,
  }
}

export function apply(ctx: Context): void {
  ctx.on('agent/turn-stopping', async (payload: { agent: { session?: { header?: { cwd?: string } } }; turn: number }) => {
    const channel = (ctx as unknown as { get?: (name: string) => unknown }).get?.('lgChannel') as ChannelFacts | undefined
    if (channel?.all === undefined) return
    const cwd = payload.agent.session?.header?.cwd
    if (cwd === undefined) return

    // HEAD of the worktree this session works in.
    const { execFileSync } = await import('node:child_process')
    let head = ''
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    } catch {
      return
    }

    const evidence = (ctx as unknown as { get?: (name: string) => unknown }).get?.('lgEvidence') as
      | { missingManifests?: () => readonly string[] }
      | undefined
    const missing = evidence?.missingManifests?.() ?? []

    const facts = await collectFacts(channel, head)
    const reasons = gateReasons(facts, missing)
    if (reasons.length === 0) return
    ;(payload.agent as unknown as { steer?: (message: unknown) => void }).steer?.({
      id: `${String(payload.turn)}-lg-report-gate`,
      role: 'user',
      content: [{ type: 'text', text: gateMessage(reasons) }],
      source: { kind: 'user' },
    })
  })
}
