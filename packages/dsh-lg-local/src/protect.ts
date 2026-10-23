/**
 * `lg-protect` — keep Local's tools off the areas it must not touch.
 *
 * The protected set is Global's DSH_HOME and workspace, and the repository
 * sandbox's storage and DSH_HOME. Path arguments are resolved physically
 * (symlinks, `..`, `~`) against the session's current directory, and shell text
 * is tokenized and every word checked. Text matching stops mistakes and a model
 * wandering off, not a determined bypass (a path assembled at run time, a
 * script, a glob), and the documentation says so (SPEC "lg-protect", PT-1).
 */
import { homedir } from 'node:os'
import { basename, resolve as resolvePath } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` is declared in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

import { expandTilde, physicalPath, provide, sessionCwd, within } from './common.js'
import { parseShell } from './shell.js'

export const name = 'lg-protect'
export const inject = ['tools']

/**
 * Protected when nothing is configured: the directory convention of
 * docs/implementation.md puts Global's DSH_HOME (`home/`) and workspace under
 * `~/.lg-global`. A repository sandbox adds its storage dir through config.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = ['~/.lg-global']

/** Arguments that hold one path, whichever tool carries them. */
const PATH_KEYS: readonly string[] = ['file_path', 'path', 'cwd', 'workdir', 'dir', 'directory']

/** Arguments that hold a list of paths (`lg_evidence_add.raw`). */
const PATH_LIST_KEYS: readonly string[] = ['raw', 'paths', 'files']

/** Tools whose missing `path` means the current directory. */
const CWD_DEFAULT_TOOLS: readonly string[] = ['glob', 'grep']

/** Config for `lg-protect`. */
export interface ProtectConfig {
  /** Absolute, `~`-expanded roots. */
  readonly protectedPaths: readonly string[]
}

/** Raw config as it arrives from the profile. */
export interface RawProtectConfig {
  readonly protectedPaths?: unknown
}

/**
 * Resolve and validate the config.
 *
 * An absent `protectedPaths` means {@link DEFAULT_PROTECTED_PATHS}; an explicit
 * list, even an empty one, is taken as written.
 * @param raw - profile-supplied config.
 * @returns the effective config.
 */
export function resolveProtectConfig(raw: RawProtectConfig): ProtectConfig {
  const listed = Array.isArray(raw.protectedPaths) ? raw.protectedPaths.map((value) => String(value)) : [...DEFAULT_PROTECTED_PATHS]
  const protectedPaths = listed.filter((value) => value.trim().length > 0).map((value) => resolvePath(expandTilde(value.trim())))
  return { protectedPaths }
}

/** Whether a root, lexically or physically, contains `target`. */
function inside(root: string, target: string): boolean {
  return within(root, target) || within(physicalPath(root), target)
}

/**
 * Whether a path sits inside one of the protected roots.
 *
 * Both the path as written and its physical location are tested, against both
 * the roots as written and their physical locations.
 * @param config - effective config.
 * @param target - absolute path to test.
 * @returns the offending root, or `undefined`.
 */
export function protectedHit(config: ProtectConfig, target: string): string | undefined {
  const lexical = resolvePath(target)
  const physical = physicalPath(lexical)
  return config.protectedPaths.find((root) => inside(root, lexical) || inside(root, physical))
}

/** The string arguments a call uses as paths, with the static prefix of a `glob` pattern. */
function pathArguments(toolName: string, args: unknown, cwd: string): string[] {
  if (typeof args !== 'object' || args === null) return []
  const record = args as Record<string, unknown>
  const found: string[] = []
  for (const key of PATH_KEYS) if (typeof record[key] === 'string' && record[key] !== '') found.push(record[key] as string)
  for (const key of PATH_LIST_KEYS) {
    const list = record[key]
    if (Array.isArray(list)) for (const item of list) if (typeof item === 'string' && item !== '') found.push(item)
  }
  if (found.length === 0 && CWD_DEFAULT_TOOLS.includes(toolName)) found.push(cwd)
  if (toolName === 'glob' && typeof record['pattern'] === 'string') {
    const pattern = record['pattern']
    const meta = pattern.search(/[*?[{]/)
    const prefix = meta === -1 ? pattern : pattern.slice(0, meta)
    const base = typeof record['path'] === 'string' ? resolvePath(cwd, expandTilde(record['path'])) : cwd
    found.push(resolvePath(base, expandTilde(prefix)))
  }
  return found
}

/** Candidate paths a shell word may stand for. */
function wordPaths(word: string): string[] {
  const expanded = word.replace(/\$\{?(HOME|DSH_HOME|DSH_AGENTS_HOME|XDG_CONFIG_HOME)\}?/g, (_all, name: string) =>
    name === 'HOME' ? homedir() : (process.env[name] ?? `$${name}`),
  )
  let text = expanded
  if (text.startsWith('-')) {
    const eq = text.indexOf('=')
    if (eq === -1) return []
    text = text.slice(eq + 1)
  }
  const parts = [text]
  const eq = text.indexOf('=')
  if (eq > 0) parts.push(text.slice(eq + 1))
  return parts.flatMap((part) => part.split(':')).filter((part) => part !== '' && !part.includes('$'))
}

/**
 * Judge shell text: raw text, then every word of every command it would run.
 *
 * `cd` inside the text moves the directory later relative words resolve against.
 * @param config - effective config.
 * @param text - the shell text.
 * @param cwd - the directory the shell starts in.
 * @param dialect - `pwsh` changes how backticks parse.
 * @returns the offending root, or `undefined`.
 */
export function commandHit(config: ProtectConfig, text: string, cwd: string, dialect: 'posix' | 'pwsh' = 'posix'): string | undefined {
  const expanded = text.replace(/(^|[\s"'=:(])~(?=\/|$|[\s"'])/g, (_all, lead: string) => `${lead}${homedir()}`)
  const plain = config.protectedPaths.find((root) =>
    [root, physicalPath(root)].some((form) => text.includes(form) || expanded.includes(form)),
  )
  if (plain !== undefined) return plain

  let here = cwd
  for (const command of parseShell(text, { dialect })) {
    const head = basename(command.argv[0] ?? '')
    const moves = head === 'cd' || head === 'pushd' || head === 'popd'
    const stuck = protectedHit(config, here)
    if (stuck !== undefined && !moves && command.argv.length > 0) return stuck

    const words = command.words.filter((word, index) => index > 0 || word.includes('/'))
    const candidates = [...words, ...command.redirects, ...command.assignments.map((entry) => entry.value)]
    for (const word of candidates) {
      for (const candidate of wordPaths(word)) {
        const hit = protectedHit(config, resolvePath(here, expandTilde(candidate)))
        if (hit !== undefined) return hit
      }
    }
    if (moves) {
      const target = command.argv.slice(1).find((arg) => !arg.startsWith('-'))
      if (head !== 'popd') here = target === undefined ? homedir() : target === '-' ? here : physicalPath(target, here)
    }
  }
  return undefined
}

/**
 * Judge one tool call.
 *
 * Split out from the guard so the rule is testable without a live registry.
 * @param config - effective config.
 * @param toolName - the tool being called.
 * @param args - its arguments.
 * @param cwd - the session's current directory, for relative paths.
 * @returns a denial reason, or `undefined` to let the call through.
 */
export function protectReason(config: ProtectConfig, toolName: string, args: unknown, cwd: string): string | undefined {
  if (config.protectedPaths.length === 0) return undefined
  for (const raw of pathArguments(toolName, args, cwd)) {
    const hit = protectedHit(config, resolvePath(cwd, expandTilde(raw)))
    if (hit !== undefined) return `lg-protect: ${toolName} targets a protected path (${hit})`
  }
  const text = typeof args === 'object' && args !== null ? (args as Record<string, unknown>)['command'] : undefined
  if (typeof text === 'string') {
    const hit = commandHit(config, text, cwd, toolName === 'pwsh' || toolName === 'powershell' ? 'pwsh' : 'posix')
    if (hit !== undefined) return `lg-protect: the command text names a protected path (${hit})`
  }
  return undefined
}

/** The service other Local plugins use to apply the same check to their own tools. */
export interface ProtectService {
  check(toolName: string, args: unknown, cwd: string): string | undefined
}

export function apply(ctx: Context, raw: RawProtectConfig = {}): void {
  const config = resolveProtectConfig(raw)
  ctx.effect(() => provide(ctx, 'lgProtect', { check: (toolName, args, cwd) => protectReason(config, toolName, args, cwd) } satisfies ProtectService))
  ctx.tools.guard((exec: { name: string; arguments: unknown; agent?: unknown }) => {
    try {
      return protectReason(config, exec.name, exec.arguments, sessionCwd(ctx, exec.agent))
    } catch (error) {
      return `lg-protect: the call could not be analysed (${error instanceof Error ? error.message : String(error)}); refusing`
    }
  })
}
