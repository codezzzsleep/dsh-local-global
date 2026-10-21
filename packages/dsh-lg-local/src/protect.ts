/**
 * `lg-protect` — keep Local's tools off the two areas it must not touch.
 *
 * The protected set is Global's DSH_HOME and workspace, and the repository
 * sandbox's storage and DSH_HOME. Paths are resolved the way each tool resolves
 * them, and bash command text is matched too — text matching stops mistakes and
 * a model wandering off, not a determined bypass, and the documentation says so
 * (SPEC "lg-protect", PT-1).
 */
import { isAbsolute, resolve as resolvePath } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` is declared in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'lg-protect'
export const inject = ['tools']

/** Tools whose `file_path`/`path` argument is a filesystem path. */
export const PATH_TOOLS: readonly string[] = ['read', 'read_image', 'write', 'edit', 'glob', 'grep']

/** Tools whose whole argument is command text. */
export const COMMAND_TOOLS: readonly string[] = ['bash', 'pwsh']

/** Config for `lg-protect`. */
export interface ProtectConfig {
  readonly protectedPaths: readonly string[]
}

/** Raw config as it arrives from the profile. */
export interface RawProtectConfig {
  readonly protectedPaths?: unknown
}

/**
 * Resolve and validate the config.
 * @param raw - profile-supplied config.
 * @returns the effective config.
 */
export function resolveProtectConfig(raw: RawProtectConfig): ProtectConfig {
  const protectedPaths = Array.isArray(raw.protectedPaths) ? raw.protectedPaths.map((value) => resolvePath(String(value))) : []
  return { protectedPaths }
}

/** The path argument a tool carries, whichever name it uses. */
function pathArgument(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const key of ['file_path', 'path']) {
    if (typeof record[key] === 'string') return record[key] as string
  }
  return undefined
}

/** The command text a shell tool carries. */
function commandText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  return typeof record['command'] === 'string' ? (record['command'] as string) : undefined
}

/**
 * Whether a resolved path sits inside one of the protected roots.
 * @param config - effective config.
 * @param target - absolute path to test.
 * @returns the offending root, or `undefined`.
 */
export function protectedHit(config: ProtectConfig, target: string): string | undefined {
  const absolute = resolvePath(target)
  return config.protectedPaths.find((root) => absolute === root || absolute.startsWith(root.endsWith('/') ? root : `${root}/`))
}

/**
 * Judge one tool call.
 *
 * Split out from the guard so the rule is testable without a live registry.
 * @param config - effective config.
 * @param toolName - the tool being called.
 * @param args - its arguments.
 * @param cwd - session working directory, for relative paths.
 * @returns a denial reason, or `undefined` to let the call through.
 */
export function protectReason(config: ProtectConfig, toolName: string, args: unknown, cwd: string): string | undefined {
  if (config.protectedPaths.length === 0) return undefined
  if ((PATH_TOOLS as readonly string[]).includes(toolName)) {
    const raw = pathArgument(args)
    if (raw === undefined) return undefined
    const target = isAbsolute(raw) ? raw : resolvePath(cwd, raw)
    const hit = protectedHit(config, target)
    return hit === undefined ? undefined : `lg-protect: ${toolName} targets a protected path (${hit})`
  }
  if ((COMMAND_TOOLS as readonly string[]).includes(toolName)) {
    const text = commandText(args)
    if (text === undefined) return undefined
    const hit = config.protectedPaths.find((root) => text.includes(root))
    return hit === undefined ? undefined : `lg-protect: the command text names a protected path (${hit})`
  }
  return undefined
}

export function apply(ctx: Context, raw: RawProtectConfig = {}): void {
  const config = resolveProtectConfig(raw)
  ctx.tools.guard((exec: { name: string; arguments: unknown; agent?: unknown }) => {
    const cwd = (exec.agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd ?? process.cwd()
    return protectReason(config, exec.name, exec.arguments, cwd)
  })
}
