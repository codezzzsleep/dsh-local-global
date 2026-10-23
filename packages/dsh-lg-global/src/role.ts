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

/** Read the role file; pauses and throws when it is unreadable or empty (RL-2). */
function readRole(file: string): string {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const detail = `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`
    lgState.pause('role-file', detail)
    throw new Error(`lg-role: ${detail}`)
  }
  if (text.trim().length === 0) {
    lgState.pause('role-file', `${file} is empty`)
    throw new Error(`lg-role: ${file} is empty`)
  }
  return text
}

/**
 * Contribute the role file as a system-prompt section.
 *
 * The section reads the file at each assembly, so a role file that was
 * unreadable at mount time can never leave an unpaused session without its
 * instructions: the pause that integrity lifts after a re-check and the prompt
 * that Global runs under always agree.
 * @param ctx - plugin context.
 * @param raw - composition config.
 */
export function apply(ctx: Context, raw: RawRoleConfig): void {
  const provided = (ctx as unknown as { get?: (name: string) => unknown }).get?.('lgWorkspace')
  const config = resolveRoleConfig(provided === undefined ? raw : { ...raw, workspace: raw.workspace ?? provided })
  // lg-integrity cross-checks this against lg-scope's own role file path.
  lgState.setComponent('role', { roleFile: config.roleFile })

  try {
    readRole(config.roleFile)
  } catch {
    // Paused above; the section below keeps refusing until the file is readable.
  }
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: ROLE_SECTION,
      order: ROLE_ORDER,
      text: () => readRole(config.roleFile),
    }),
  )
}
