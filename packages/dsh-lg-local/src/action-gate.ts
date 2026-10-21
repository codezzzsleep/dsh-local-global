/**
 * `lg-action-gate` — C-class actions need an approval, once.
 *
 * A matching command is denied by the synchronous guard with its action
 * fingerprint. Local asks with a QUESTION carrying that fingerprint, Global
 * answers with a DECISION carrying `approve_action`, and the guard lets the
 * command through exactly once, registering that DECISION in the next REPORT's
 * `consumed_approvals`.
 *
 * The approval table is the one lg-channel already keeps in memory from its own
 * fetches; the guard never reads the channel itself (SPEC "lg-action-gate",
 * AG-1/AG-2).
 */
import { actionFingerprint } from '@local-global/lg-protocol'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` is declared in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'lg-action-gate'
export const inject = ['tools']

/** One gated action. `match` is a regular expression over the command text. */
export interface GateRule {
  readonly id: string
  readonly tool: string
  readonly match: string
}

/**
 * The rules the SPEC requires at least: force push, `rm -rf`, publishing,
 * amending pushed history, rebasing a pushed branch, and touching credentials.
 */
export const DEFAULT_RULES: readonly GateRule[] = [
  { id: 'force-push', tool: 'bash', match: 'push\\b.*(--force\\b|\\s-f\\b)' },
  { id: 'rm-rf', tool: 'bash', match: 'rm\\s+(-[A-Za-z]*[rR][A-Za-z]*\\s+)+' },
  { id: 'publish', tool: 'bash', match: '(npm|pnpm)\\s+publish' },
  { id: 'commit-amend', tool: 'bash', match: 'commit\\b.*--amend' },
  { id: 'history-rewrite', tool: 'bash', match: '\\b(rebase|filter-branch|filter-repo)\\b' },
  { id: 'credentials', tool: 'bash', match: '(\\.netrc|credentials|GIT_ASKPASS)' },
]

/** Config for `lg-action-gate`. */
export interface ActionGateConfig {
  readonly rules: readonly GateRule[]
}

/** Raw config as it arrives from the profile. */
export interface RawActionGateConfig {
  readonly rules?: unknown
}

/**
 * Resolve and validate the config.
 * @param raw - profile-supplied config.
 * @returns the effective config.
 */
export function resolveActionGateConfig(raw: RawActionGateConfig): ActionGateConfig {
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) return { rules: DEFAULT_RULES }
  const rules = raw.rules
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({ id: String(item['id']), tool: String(item['tool']), match: String(item['match']) }))
    .filter((rule) => rule.id.length > 0 && rule.tool.length > 0 && rule.match.length > 0)
  return { rules: rules.length === 0 ? DEFAULT_RULES : rules }
}

/** The command text a shell tool carries. */
function commandText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  return typeof record['command'] === 'string' ? (record['command'] as string) : undefined
}

/** One unused approval as lg-channel knows it. */
export interface KnownApproval {
  readonly decision: string
  readonly fingerprint: string
}

/** The rule a call matches, with its fingerprint. */
export interface GateMatch {
  readonly rule: GateRule
  readonly fingerprint: string
  readonly text: string
}

/**
 * Which rule, if any, this call trips.
 * @param config - effective config.
 * @param toolName - the tool being called.
 * @param args - its arguments.
 * @returns the match, or `undefined` when nothing is gated.
 */
export function matchRule(config: ActionGateConfig, toolName: string, args: unknown): GateMatch | undefined {
  const text = commandText(args)
  if (text === undefined) return undefined
  for (const rule of config.rules) {
    if (rule.tool !== toolName) continue
    if (!new RegExp(rule.match).test(text)) continue
    return { rule, fingerprint: actionFingerprint(rule.id, text), text }
  }
  return undefined
}

/**
 * Judge one gated call.
 *
 * `consume` is called only when an unused approval lets this call through, so a
 * caller can register the DECISION in the next REPORT.
 * @param config - effective config.
 * @param toolName - the tool being called.
 * @param args - its arguments.
 * @param approvals - unused approvals, as lg-channel holds them in memory.
 * @param consume - invoked with the DECISION sequence that was spent.
 * @returns a denial reason, or `undefined` to allow this one call.
 */
export function gateReason(
  config: ActionGateConfig,
  toolName: string,
  args: unknown,
  approvals: readonly KnownApproval[],
  consume: (decision: string) => void,
): string | undefined {
  const match = matchRule(config, toolName, args)
  if (match === undefined) return undefined
  const granted = approvals.find((approval) => approval.fingerprint === match.fingerprint)
  if (granted !== undefined) {
    consume(granted.decision)
    return undefined
  }
  return `lg-action-gate: ${match.rule.id} is a C-class action; fingerprint ${match.fingerprint}. Ask with a QUESTION carrying this fingerprint and wait for a DECISION that approves it.`
}

export function apply(ctx: Context, raw: RawActionGateConfig = {}): void {
  const config = resolveActionGateConfig(raw)
  const consumed: string[] = []

  /** The in-memory approval table lg-channel maintains from its own fetches. */
  const approvals = (): readonly KnownApproval[] => {
    const channel = (ctx as unknown as { get?: (name: string) => unknown }).get?.('lgChannel') as
      | { approvals?: () => readonly KnownApproval[] }
      | undefined
    return channel?.approvals?.() ?? []
  }

  ctx.effect(() => {
    const release = (ctx as unknown as { provide?: (name: string, value: unknown) => () => void }).provide?.('lgActionGate', {
      pendingConsumed: () => [...consumed],
    })
    return () => release?.()
  })

  ctx.tools.guard((exec: { name: string; arguments: unknown }) =>
    gateReason(config, exec.name, exec.arguments, approvals(), (decision) => {
      consumed.push(decision)
      ctx.logger?.('lg-action-gate')?.info?.(`lg-action-gate: spent the approval from DECISION ${decision}`)
    }),
  )
}
