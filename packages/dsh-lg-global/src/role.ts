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
  /** Base directory for a relative `roleFile`; defaults to the workspace. */
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
  const base = typeof raw.baseDir === 'string' ? resolvePath(raw.baseDir) : process.cwd()
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
  const config = resolveRoleConfig(raw)
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
