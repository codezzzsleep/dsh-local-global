/**
 * `lg-action-gate` — C-class actions need an approval, once.
 *
 * A matching command is denied by the synchronous guard with its action
 * fingerprint. Local asks with a QUESTION carrying that fingerprint, Global
 * answers with a DECISION carrying `approve_action`, and the guard lets the
 * command through exactly once. The spend is written to a state file before the
 * command runs (so it survives a restart) and `lg-report-gate` requires the next
 * REPORT to list that DECISION in `consumed_approvals`.
 *
 * Approvals come from the table lg-channel keeps in memory from its own fetches;
 * the guard never reads the channel repository itself (SPEC "lg-action-gate",
 * AG-1/AG-2). Without lg-channel there is no table, so a C-class command is
 * denied with that reason: the gate fails closed.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { actionFingerprint } from '@local-global/lg-protocol'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` is declared in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

import { provide, service } from './common.js'
import { ApprovalLedger, LedgerError, type SpentApproval } from './ledger.js'
import { BUILTIN_DETECTORS } from './matchers.js'
import { SHELL_TOOLS, parseShell, type Invocation } from './shell.js'

export const name = 'lg-action-gate'
export const inject = ['tools']

/**
 * One gated action.
 *
 * `tool` is a tool name, `bash` for every shell tool (`bash`, `pwsh`, ...), or
 * `*`. `match` is a regular expression tested against the command text and
 * against each simple command the text runs, or `builtin:<id>` for one of the
 * token-aware detectors the default rules use.
 */
export interface GateRule {
  readonly id: string
  readonly tool: string
  readonly match: string
}

/** Prefix of a `match` that selects a built-in detector. */
export const BUILTIN_PREFIX = 'builtin:'

/**
 * The rules the SPEC requires at least: force push, `rm -rf`, publishing,
 * amending pushed history, rebasing a pushed branch, and touching credentials;
 * plus the other ways a command destroys work (`reset --hard`, `clean -f`,
 * `branch -D`).
 */
export const DEFAULT_RULES: readonly GateRule[] = Object.keys(BUILTIN_DETECTORS).map((id) => ({ id, tool: 'bash', match: `${BUILTIN_PREFIX}${id}` }))

/** Config for `lg-action-gate`. */
export interface ActionGateConfig {
  readonly rules: readonly GateRule[]
  /** Where the spent-approval record lives; defaults to lg-channel's state directory. */
  readonly stateDir?: string
}

/** Raw config as it arrives from the profile. */
export interface RawActionGateConfig {
  readonly rules?: unknown
  readonly stateDir?: unknown
}

/**
 * Resolve and validate the config.
 * @param raw - profile-supplied config.
 * @returns the effective config.
 * @throws {TypeError} when a rule's `match` is not a valid regular expression or a known detector.
 */
export function resolveActionGateConfig(raw: RawActionGateConfig): ActionGateConfig {
  const stateDir = typeof raw.stateDir === 'string' && raw.stateDir.length > 0 ? { stateDir: raw.stateDir } : {}
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) return { rules: DEFAULT_RULES, ...stateDir }
  const rules = raw.rules
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({ id: String(item['id']), tool: String(item['tool']), match: String(item['match']) }))
    .filter((rule) => rule.id.length > 0 && rule.tool.length > 0 && rule.match.length > 0)
  for (const rule of rules) {
    if (rule.match.startsWith(BUILTIN_PREFIX)) {
      if (BUILTIN_DETECTORS[rule.match.slice(BUILTIN_PREFIX.length)] === undefined) throw new TypeError(`lg-action-gate: rule "${rule.id}" names an unknown detector ${rule.match}`)
      continue
    }
    try {
      new RegExp(rule.match)
    } catch {
      throw new TypeError(`lg-action-gate: rule "${rule.id}" has an invalid match expression`)
    }
  }
  return { rules: rules.length === 0 ? DEFAULT_RULES : rules, ...stateDir }
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

/** A rule a call trips, with its fingerprint. */
export interface GateMatch {
  readonly rule: GateRule
  readonly fingerprint: string
  readonly text: string
  /** What the detector saw, when it can say. */
  readonly detail?: string
}

function toolApplies(rule: GateRule, toolName: string): boolean {
  return rule.tool === '*' || rule.tool === toolName || ((rule.tool === 'bash' || rule.tool === 'shell') && SHELL_TOOLS.includes(toolName))
}

function ruleDetail(rule: GateRule, text: string, commands: readonly Invocation[]): string | undefined {
  if (rule.match.startsWith(BUILTIN_PREFIX)) {
    const detector = BUILTIN_DETECTORS[rule.match.slice(BUILTIN_PREFIX.length)]
    if (detector === undefined) return undefined
    for (const command of commands) {
      const found = detector(command)
      if (found !== undefined) return found
    }
    return undefined
  }
  const pattern = new RegExp(rule.match)
  return pattern.test(text) || commands.some((command) => pattern.test(command.text)) ? `matches /${rule.match}/` : undefined
}

/**
 * Every rule, at most once each, that this call trips.
 * @param config - effective config.
 * @param toolName - the tool being called.
 * @param args - its arguments.
 * @returns the matches in rule order; empty when nothing is gated.
 */
export function matchRules(config: ActionGateConfig, toolName: string, args: unknown): GateMatch[] {
  const text = commandText(args)
  if (text === undefined) return []
  const applicable = config.rules.filter((rule) => toolApplies(rule, toolName))
  if (applicable.length === 0) return []
  const commands = parseShell(text, { dialect: toolName === 'pwsh' || toolName === 'powershell' ? 'pwsh' : 'posix' })
  const found: GateMatch[] = []
  for (const rule of applicable) {
    if (found.some((entry) => entry.rule.id === rule.id)) continue
    const detail = ruleDetail(rule, text, commands)
    if (detail !== undefined) found.push({ rule, fingerprint: actionFingerprint(rule.id, text), text, detail })
  }
  return found
}

/**
 * The first rule this call trips, with its fingerprint.
 * @param config - effective config.
 * @param toolName - the tool being called.
 * @param args - its arguments.
 * @returns the match, or `undefined` when nothing is gated.
 */
export function matchRule(config: ActionGateConfig, toolName: string, args: unknown): GateMatch | undefined {
  return matchRules(config, toolName, args)[0]
}

function denial(match: GateMatch): string {
  return `lg-action-gate: ${match.rule.id} is a C-class action (${match.detail ?? 'matched'}); fingerprint ${match.fingerprint}. Ask with a QUESTION carrying this fingerprint and wait for a DECISION that approves it.`
}

/**
 * Judge one gated call.
 *
 * Every rule the command trips needs its own approval; `consume` is called for
 * each only once all of them are covered, so a caller can record the spend.
 * A `consume` that throws denies the call: an approval that cannot be recorded
 * as spent is not granted.
 * @param config - effective config.
 * @param toolName - the tool being called.
 * @param args - its arguments.
 * @param approvals - unused approvals.
 * @param consume - invoked with the DECISION sequence and fingerprint that were spent.
 * @returns a denial reason, or `undefined` to allow this one call.
 */
export function gateReason(
  config: ActionGateConfig,
  toolName: string,
  args: unknown,
  approvals: readonly KnownApproval[],
  consume: (decision: string, fingerprint: string) => void,
): string | undefined {
  const matches = matchRules(config, toolName, args)
  if (matches.length === 0) return undefined
  const used = new Set<string>()
  const grants: KnownApproval[] = []
  for (const match of matches) {
    const granted = approvals.find((approval) => approval.fingerprint === match.fingerprint && !used.has(approval.decision))
    if (granted === undefined) return denial(match)
    used.add(granted.decision)
    grants.push(granted)
  }
  try {
    for (const grant of grants) consume(grant.decision, grant.fingerprint)
  } catch (error) {
    return `lg-action-gate: ${matches[0]?.rule.id ?? 'action'} was approved but the spend could not be recorded (${error instanceof Error ? error.message : String(error)}); refusing.`
  }
  return undefined
}

/** The slice of lg-channel this plugin reads. */
interface ChannelLike {
  approvals?: () => readonly KnownApproval[]
  config?: { stateDir?: string; repo?: string }
}

/** What other Local plugins can ask of the gate. */
export interface ActionGateService {
  /** Judge a command as the guard would, spending an approval when one applies. */
  authorize(toolName: string, args: unknown): string | undefined
  /** Every approval this process or an earlier one has spent, for the report gate. */
  consumed(): readonly SpentApproval[]
}

export function apply(ctx: Context, raw: RawActionGateConfig = {}): void {
  const config = resolveActionGateConfig(raw)

  const ledgerFor = (channel: ChannelLike): ApprovalLedger => {
    const home = process.env['DSH_HOME']
    const dsh = home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
    const dir = config.stateDir ?? channel.config?.stateDir ?? join(dsh, 'lg', 'state')
    return new ApprovalLedger(dir, channel.config?.repo ?? '')
  }

  const authorize = (toolName: string, args: unknown): string | undefined => {
    const first = matchRules(config, toolName, args)[0]
    if (first === undefined) return undefined

    const channel = service<ChannelLike>(ctx, 'lgChannel')
    if (channel?.approvals === undefined) {
      return `${denial(first)} lg-channel is not composed, so no approval can be read: install @local-global/dsh-lg-common.`
    }
    try {
      const ledger = ledgerFor(channel)
      const spent = new Set(ledger.list().map((entry) => entry.decision))
      const unused = channel.approvals().filter((approval) => !spent.has(approval.decision))
      return gateReason(config, toolName, args, unused, (decision, fingerprint) => {
        ledger.spend([{ decision, fingerprint, consumedAt: new Date().toISOString() }])
        ctx.logger?.('lg-action-gate')?.info?.(`lg-action-gate: spent the approval from DECISION ${decision}`)
      })
    } catch (error) {
      const why = error instanceof LedgerError ? error.message : `the approval table cannot be read (${error instanceof Error ? error.message : String(error)})`
      return `lg-action-gate: ${first.rule.id} is a C-class action and ${why}; refusing.`
    }
  }

  const consumed = (): readonly SpentApproval[] => {
    const channel = service<ChannelLike>(ctx, 'lgChannel')
    return channel === undefined ? [] : ledgerFor(channel).list()
  }

  ctx.effect(() => provide(ctx, 'lgActionGate', { authorize, consumed } satisfies ActionGateService))
  ctx.tools.guard((exec: { name: string; arguments: unknown }) => authorize(exec.name, exec.arguments))
}
