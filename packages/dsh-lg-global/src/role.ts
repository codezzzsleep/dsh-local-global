/**
 * `lg-role` — the only source of a Global session's instructions.
 *
 * `dsh-agent-instructions` is deliberately not composed: it loads
 * `$DSH_AGENTS_HOME/AGENTS.md`, walks directories after `read`/`write`/`edit`,
 * and accepts `AGENTS.local.md`/`CLAUDE.local.md`. All three are files Local can
 * write, which would let the audited side author its auditor's instructions.
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.systemPrompt` lives in dsh-system-prompt.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { lgState } from './state.js'

/** Raw plugin config. */
export interface RawRoleConfig {
  readonly roleFile?: unknown
  /** The Global workspace; a relative `roleFile` is resolved against it. */
  readonly workspace?: unknown
  /** Explicit base directory; wins over `workspace` when both are given. */
  readonly baseDir?: unknown
}

/** Resolved role configuration. */
export interface RoleConfig {
  readonly roleFile: string
}

/**
 * Validate raw config and resolve the role file path.
 * @param raw - composition config.
 * @returns the absolute role file path.
 * @throws TypeError when `roleFile` is missing.
 */
export function resolveRoleConfig(raw: RawRoleConfig): RoleConfig {
  const file = typeof raw.roleFile === 'string' && raw.roleFile.length > 0 ? raw.roleFile : 'LG-ROLE.md'
  // SPEC "lg-role": `roleFile` (default LG-ROLE.md) is relative to the
  // workspace. Resolving it against process.cwd() made Global pause forever
  // whenever dsh happened to be launched from another directory.
  const explicitBase = typeof raw.baseDir === 'string' ? raw.baseDir : undefined
  const workspace = typeof raw.workspace === 'string' && raw.workspace.length > 0 ? raw.workspace : undefined
  const base = resolvePath(explicitBase ?? workspace ?? process.cwd())
  return { roleFile: isAbsolute(file) ? file : resolvePath(base, file) }
}

/** Section name and order used in the system prompt. */
export const ROLE_SECTION = 'lg-role'
export const ROLE_ORDER = 100

/** Cordis plugin name. */
export const name = 'lg-role'

/** Services this plugin reads. */
export const inject = ['systemPrompt']

/**
 * Read the role file once and contribute it as a system-prompt section.
 * @param ctx - plugin context.
 * @param raw - composition config.
 */
export function apply(ctx: Context, raw: RawRoleConfig): void {
  const provided = (ctx as unknown as { get?: (name: string) => unknown }).get?.('lgWorkspace')
  const config = resolveRoleConfig(provided === undefined ? raw : { ...raw, workspace: raw.workspace ?? provided })
  let text: string
  try {
    text = readFileSync(config.roleFile, 'utf8')
  } catch (error) {
    lgState.pause('role-file', `cannot read ${config.roleFile}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (text.trim().length === 0) {
    lgState.pause('role-file', `${config.roleFile} is empty`)
    return
  }
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: ROLE_SECTION,
      order: ROLE_ORDER,
      text,
    }),
  )
}
