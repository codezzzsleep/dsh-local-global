/**
 * `lg-scope` — what a Global session may touch.
 *
 * Two enforcement points, chosen by what each can actually guarantee:
 * - `ctx.tools.guard` is synchronous, monotonic, and runs after the
 *   `tools/pre-execute` waterfall, so **every denial happens here**. A
 *   pre-execute listener can be prepended and return `allow` without calling
 *   `next()`, which skips later listeners entirely — so pre-execute may only
 *   prepare, never decide.
 * - `tools/pre-execute` does the async part (DNS); the guard reads its verdict
 *   and fails closed when the verdict is missing or bound to another URL.
 *
 * A bad configuration never throws out of `apply()` (dsh would only log a
 * warning and keep every other plugin running): the guard is still registered,
 * refuses everything, and the shared state stays paused with the reason.
 */
import { lookup } from 'node:dns/promises'
import { realpathSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` and the tools/* events live in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'
import { GuardState, lgState } from './state.js'
import { CANARY_TOOL, DEFAULT_ALLOWED_TOOLS, serviceOf } from './tools.js'

/** How one path-bearing tool names and uses its path argument. */
export interface PathRule {
  /** Argument holding the path. */
  readonly arg: string
  /** A call without it is refused (otherwise the tool defaults to the cwd). */
  readonly required: boolean
  /** The tool writes there: write roots and protected paths apply. */
  readonly write: boolean
  /** The tool normalises lexically before touching the disk, so check that spelling too. */
  readonly lexical?: boolean
}

/**
 * Every tool that takes a path, keyed by name with the argument the tool itself
 * reads (`dsh-tool-fs`: `file_path`; `dsh-tool-fs-search`: `path`;
 * `dsh-tool-working-directory`: `cd`). Any tool that writes must say so here.
 */
export const PATH_RULES: Readonly<Record<string, PathRule>> = {
  read: { arg: 'file_path', required: true, write: false },
  read_image: { arg: 'file_path', required: true, write: false },
  write: { arg: 'file_path', required: true, write: true },
  edit: { arg: 'file_path', required: true, write: true },
  glob: { arg: 'path', required: false, write: false },
  grep: { arg: 'path', required: false, write: false },
  working_directory: { arg: 'cd', required: false, write: false },
  // CH-12 evidence export: `dsh-lg-common` writes `out` with a lexical resolve.
  lg_evidence_session: { arg: 'out', required: true, write: true, lexical: true },
}

/** Tools that read or write through a path argument. */
export const PATH_TOOLS = ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'working_directory'] as const

/** Project tools that write a file, keyed by their own argument name. */
export const TOOL_PATH_ARGUMENTS: Readonly<Record<string, string>> = { lg_evidence_session: 'out' }

/** Tools whose missing path means "the session working directory". */
export const CWD_DEFAULT_TOOLS = ['glob', 'grep'] as const

/** Tool-name prefixes a Global session must never see, whatever the preset says. */
export const DENIED_TOOL_PREFIXES = ['bash', 'pwsh', 'terminal', 'job_', 'subagent', 'task'] as const

/** Fully resolved scope configuration. */
export interface ScopeConfig {
  /** Absolute Global workspace; every resolved path must land inside it. */
  readonly workspace: string
  /** Hosts `web_fetch` may reach, matched exactly or as a subdomain. */
  readonly allowDomains: readonly string[]
  /** Extra restriction for every writing tool; defaults to `<workspace>/drafts`. */
  readonly writeRoots: readonly string[]
  /** The role file; no tool may write it, whatever the write roots say (invariant 8). */
  readonly roleFile: string
  /** Exact tool names a call may name. */
  readonly allowedTools: readonly string[]
}

/** Raw plugin config. */
export interface RawScopeConfig {
  readonly workspace?: unknown
  readonly allowDomains?: unknown
  readonly writeRoots?: unknown
  readonly roleFile?: unknown
  readonly allowedTools?: unknown
}

/** Default fetch allowlist: GitHub's own hosts, whose DNS an attacker cannot steer. */
export const DEFAULT_ALLOW_DOMAINS = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'gist.github.com',
  'gist.githubusercontent.com',
] as const

/** A decision recorded by the async pre-execute stage. */
export interface NetworkVerdict {
  readonly url: string
  readonly allow: boolean
  readonly reason?: string
}

/** Lexical containment, for validating configuration before any file exists. */
function lexicallyInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Validate raw config and fill defaults.
 * @param raw - composition config.
 * @returns the resolved configuration.
 * @throws TypeError when the workspace is missing, a write root leaves it, or the tool list names a shell.
 */
export function resolveScopeConfig(raw: RawScopeConfig): ScopeConfig {
  if (typeof raw.workspace !== 'string' || !isAbsolute(raw.workspace)) {
    throw new TypeError('lg-scope: "workspace" is required and must be an absolute path')
  }
  const workspace = resolvePath(raw.workspace)
  const allowDomains =
    Array.isArray(raw.allowDomains) && raw.allowDomains.length > 0
      ? raw.allowDomains.map((value) => String(value).toLowerCase())
      : [...DEFAULT_ALLOW_DOMAINS]
  const writeRoots =
    Array.isArray(raw.writeRoots) && raw.writeRoots.length > 0
      ? raw.writeRoots.map((value) => resolvePath(workspace, String(value)))
      : [resolvePath(workspace, 'drafts')]
  for (const root of writeRoots) {
    if (!lexicallyInside(workspace, root)) throw new TypeError(`lg-scope: write root is outside the workspace: ${root}`)
  }
  const roleName = typeof raw.roleFile === 'string' && raw.roleFile.length > 0 ? raw.roleFile : 'LG-ROLE.md'
  const roleFile = resolvePath(workspace, roleName)
  const allowedTools =
    Array.isArray(raw.allowedTools) && raw.allowedTools.length > 0
      ? raw.allowedTools.map((value) => String(value))
      : [...DEFAULT_ALLOWED_TOOLS]
  for (const tool of allowedTools) {
    if (deniedPrefix(tool) !== undefined) throw new TypeError(`lg-scope: "${tool}" is an execution or derivation tool and cannot be allowed`)
  }
  return { workspace, allowDomains, writeRoots, roleFile, allowedTools }
}

function deniedPrefix(tool: string): string | undefined {
  return DENIED_TOOL_PREFIXES.find((prefix) => tool === prefix || tool.startsWith(prefix))
}

const DOT_DOT = /(?:^|[\\/])\.\.(?:[\\/]|$)/u

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
}

/**
 * Resolve a path exactly as `dsh-fs-local` does for the tools
 * (`resolveLocalTarget`, dsh-fs-local `lib/index.js:154-212`): a path that
 * contains `..` keeps its spelling so the kernel walks symlinks physically
 * (`link/..` is the *target's* parent); otherwise it is normalised. The longest
 * existing prefix is then realpath'd and the missing tail appended, however
 * deep it is.
 * @param cwd - absolute base for a relative `path`.
 * @param path - the model's argument.
 * @returns the physical path the tool will touch.
 * @throws Error when the tool itself would refuse to resolve it.
 */
export function resolveToolPath(cwd: string, path: string): string {
  if (path.trim().length === 0) throw new Error('empty path')
  if (path.includes('\0')) throw new Error('path contains a NUL byte')
  if (!isAbsolute(cwd)) throw new Error(`working directory is not absolute: ${cwd}`)
  const raw = isAbsolute(path) ? path : `${cwd}${sep}${path}`
  const display = DOT_DOT.test(raw) ? raw : resolvePath(cwd, path)
  try {
    return realpathSync.native(display)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  const missing = [basename(display)]
  let ancestor = dirname(display)
  for (;;) {
    try {
      const real = realpathSync.native(ancestor)
      if (missing.includes('..')) throw new Error('parent traversal crosses a missing directory')
      return join(real, ...missing)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) return display
    missing.unshift(basename(ancestor))
    ancestor = parent
  }
}

/** Resolve an absolute path through its longest existing prefix, with no depth cap. */
export function realpathInside(path: string): string {
  return resolveToolPath('/', isAbsolute(path) ? path : resolvePath(path))
}

/** True when `candidate` is the root itself or lies beneath it; unresolvable means no. */
export function isInside(root: string, candidate: string): boolean {
  try {
    return lexicallyInside(realpathInside(root), realpathInside(candidate))
  } catch {
    return false
  }
}

const V4_BLOCKED: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function v4Bytes(address: string): number[] {
  return address.split('.').map((part) => Number.parseInt(part, 10))
}

function prefixMatch(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit += 8) {
    const mask = bits - bit >= 8 ? 0xff : (0xff << (8 - (bits - bit))) & 0xff
    if (((bytes[bit / 8] ?? 0) & mask) !== ((prefix[bit / 8] ?? 0) & mask)) return false
  }
  return true
}

/** Expand an IPv6 literal (with `::` and an optional dotted tail) to 16 bytes. */
function v6Bytes(address: string): number[] | undefined {
  let text = address
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  let tail: number[] = []
  const lastColon = text.lastIndexOf(':')
  if (text.slice(lastColon + 1).includes('.')) {
    const dotted = text.slice(lastColon + 1)
    if (isIP(dotted) !== 4) return undefined
    const [a = 0, b = 0, c = 0, d = 0] = v4Bytes(dotted)
    tail = [a, b, c, d]
    text = `${text.slice(0, lastColon + 1)}0:0`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const parse = (part: string): number[] | undefined => {
    if (part === '') return []
    const words: number[] = []
    for (const word of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/iu.test(word)) return undefined
      words.push(Number.parseInt(word, 16))
    }
    return words
  }
  const head = parse(halves[0] ?? '')
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : []
  if (head === undefined || rest === undefined) return undefined
  const fill = 8 - head.length - rest.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined
  const words = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest]
  const bytes = words.flatMap((word) => [word >> 8, word & 0xff])
  if (tail.length === 4) bytes.splice(12, 4, ...tail)
  return bytes
}

const V6_BLOCKED: readonly (readonly [readonly number[], number])[] = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96], // ::/96: unspecified, loopback, IPv4-compatible
  [[0x01, 0, 0, 0, 0, 0, 0, 0], 64], // 100::/64 discard
  [[0x20, 0x01, 0, 0], 32], // 2001::/32 Teredo
  [[0x20, 0x01, 0x0d, 0xb8], 32], // 2001:db8::/32 documentation
  [[0x3f, 0xff, 0], 20], // 3fff::/20 documentation
  [[0x64, 0xff, 0x9b, 0x00, 0x01], 48], // 64:ff9b:1::/48 local-use NAT64
  [[0xfc], 7], // fc00::/7 unique local
  [[0xfe, 0x80], 10], // fe80::/10 link-local
  [[0xfe, 0xc0], 10], // fec0::/10 site-local
  [[0xff], 8], // ff00::/8 multicast
]

/**
 * True for loopback, link-local, private, multicast, reserved, and otherwise
 * non-public addresses, including IPv6 forms that embed an IPv4 address
 * (mapped, translated, NAT64, 6to4, ISATAP).
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address.includes('%') ? address.slice(0, address.indexOf('%')) : address)
  if (family === 4) {
    const bytes = v4Bytes(address)
    return V4_BLOCKED.some(([base, bits]) => prefixMatch(bytes, v4Bytes(base), bits))
  }
  if (family !== 6) return false
  const bytes = v6Bytes(address)
  if (bytes === undefined) return true
  const embedded = (offset: number): boolean => isPrivateAddress(bytes.slice(offset, offset + 4).join('.'))
  if (V6_BLOCKED.some(([prefix, bits]) => prefixMatch(bytes, prefix, bits))) return true
  if (prefixMatch(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return embedded(12) // ::ffff:a.b.c.d
  if (prefixMatch(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0], 96)) return embedded(12) // ::ffff:0:a.b.c.d
  if (prefixMatch(bytes, [0x00, 0x64, 0xff, 0x9b], 96)) return embedded(12) // 64:ff9b::/96
  if (prefixMatch(bytes, [0x20, 0x02], 16)) return embedded(2) // 6to4
  if ((bytes[8] === 0 || bytes[8] === 2) && bytes[9] === 0 && bytes[10] === 0x5e && bytes[11] === 0xfe) return embedded(12) // ISATAP
  return false
}

/** True when the host is in the allowlist, exactly or as a subdomain. */
export function hostAllowed(host: string, allowDomains: readonly string[]): boolean {
  const lower = host.toLowerCase()
  return allowDomains.some((domain) => lower === domain || lower.endsWith(`.${domain}`))
}

/** Extract the path argument of a path-scoped tool call, by the tool's own argument name. */
export function pathArgument(args: unknown, tool?: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const named = tool === undefined ? undefined : PATH_RULES[tool]?.arg
  for (const key of named === undefined ? ['file_path', 'path', 'filePath', 'cd'] : [named]) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** The current and the frozen creation working directory of one session. */
export interface SessionCwds {
  /** What the working-directory service tracks now; dsh tools resolve against this. */
  readonly current?: string
  /** `session.header.cwd`, fixed at creation. */
  readonly frozen?: string
}

/**
 * Decide one path argument the way the tool itself will resolve it.
 *
 * Relative paths resolve against the **current** working directory the
 * working-directory service tracks (`dsh-tool-fs` calls
 * `workingDirectory.ensure`), physically, through the longest existing prefix.
 * @param config - scope configuration.
 * @param tool - tool name.
 * @param rawPath - the argument, or undefined when the tool defaults to cwd.
 * @param cwd - the working directory relative paths resolve against.
 * @param extra - protected paths in addition to the role file.
 * @returns a denial reason, or undefined to allow.
 */
export function checkPath(
  config: ScopeConfig,
  tool: string,
  rawPath: string | undefined,
  cwd: string | undefined,
  extra: readonly string[] = [],
): string | undefined {
  if (cwd === undefined) return `lg-scope: ${tool} needs the session working directory, which is unknown`
  if (!isInside(config.workspace, cwd)) {
    return `lg-scope: session working directory is outside the Global workspace: ${cwd}`
  }
  const rule = PATH_RULES[tool]
  const write = rule?.write ?? false
  const target = rawPath === undefined ? cwd : rawPath
  const absolutes = new Set<string>()
  try {
    absolutes.add(resolveToolPath(cwd, target))
    if (rule?.lexical === true) absolutes.add(resolveToolPath(cwd, resolvePath(cwd, target)))
  } catch (error) {
    return `lg-scope: ${tool} path cannot be resolved (${error instanceof Error ? error.message : String(error)}): ${target}`
  }
  const workspaceReal = realpathInside(config.workspace)
  for (const absolute of absolutes) {
    if (!lexicallyInside(workspaceReal, absolute)) return `lg-scope: ${tool} path escapes the Global workspace: ${target}`
    if (!write) continue
    for (const guarded of [config.roleFile, ...extra]) {
      if (lexicallyInside(realpathInside(guarded), absolute)) return `lg-scope: ${tool} may not write the protected path ${guarded}: ${target}`
    }
    const allowed = config.writeRoots.some((root) => lexicallyInside(realpathInside(root), absolute))
    if (!allowed) return `lg-scope: ${tool} may only write inside ${config.writeRoots.join(', ')}: ${target}`
  }
  return undefined
}

/** Decide one fetch target; returns a denial reason or undefined. */
export async function checkFetchTarget(config: ScopeConfig, url: string): Promise<string | undefined> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `lg-scope: web_fetch target is not a URL: ${url}`
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `lg-scope: web_fetch only allows http and https, got ${parsed.protocol}`
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, '')
  if (!hostAllowed(host, config.allowDomains)) {
    return `lg-scope: web_fetch host is not in the allowlist: ${host}`
  }
  if (isIP(host) !== 0) {
    return isPrivateAddress(host) ? `lg-scope: web_fetch refuses a private address: ${host}` : undefined
  }
  try {
    const records = await lookup(host, { all: true, verbatim: true })
    if (records.length === 0) return `lg-scope: web_fetch could not resolve ${host}: no addresses`
    const privateOne = records.find((record) => isPrivateAddress(record.address))
    if (privateOne !== undefined) {
      return `lg-scope: web_fetch resolved ${host} to a private address: ${privateOne.address}`
    }
  } catch (error) {
    return `lg-scope: web_fetch could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`
  }
  return undefined
}

/** Read the creation working directory (`session.header.cwd`) from an agent. */
export function sessionCwd(agent: unknown): string | undefined {
  const session = (agent as { session?: Record<string, unknown> } | undefined)?.session
  if (session === undefined) return undefined
  const header = session['header'] as Record<string, unknown> | undefined
  for (const candidate of [header?.['cwd'], session['cwd'], (session['meta'] as Record<string, unknown> | undefined)?.['cwd']]) {
    if (typeof candidate === 'string' && isAbsolute(candidate)) return candidate
  }
  return undefined
}

/**
 * Both working directories of one session. `current` comes from the
 * working-directory service (`dsh-working-directory` `get(session)`, the value
 * every dsh tool resolves relative paths against); a missing service leaves it
 * undefined so path tools fail closed.
 */
export function sessionCwds(ctx: unknown, agent: unknown): SessionCwds {
  const service = serviceOf<{ get(session: unknown): string | undefined }>(ctx, 'workingDirectory')
  const session = (agent as { session?: unknown } | undefined)?.session
  let current: string | undefined
  try {
    const value = service === undefined || session === undefined ? undefined : service.get(session)
    if (typeof value === 'string' && isAbsolute(value)) current = value
  } catch {
    current = undefined
  }
  const frozen = sessionCwd(agent)
  return { ...(current === undefined ? {} : { current }), ...(frozen === undefined ? {} : { frozen }) }
}

/** Exposed for tests: whether a path is a directory that exists. */
export function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Dependencies of the guard, injectable so tests need no running dsh. */
export interface ScopeRuntimeDeps {
  /** Resolved configuration, or undefined when it was invalid. */
  readonly config: ScopeConfig | undefined
  /** Why the configuration is invalid. */
  readonly configError?: string
  readonly state: GuardState
  /** Working directories of the calling agent. */
  readonly cwds: (agent: unknown) => SessionCwds
}

/** The two halves of the scope enforcement. */
export interface ScopeRuntime {
  /** Async preparation; records a network verdict, never decides. */
  preExecute(exec: { name: string; arguments?: unknown; callId: string; token?: unknown }): Promise<void>
  /** Synchronous, monotonic decision: a denial reason, or undefined to allow. */
  guard(exec: { name: string; arguments?: unknown; callId: string; token?: unknown; agent?: unknown }): string | undefined
}

const VERDICT_LIMIT = 1024

/**
 * Build the pre-execute preparation and the synchronous guard.
 * @param deps - configuration, shared state, and the working-directory source.
 * @returns both halves; the plugin wires them to cordis.
 */
export function createScopeRuntime(deps: ScopeRuntimeDeps): ScopeRuntime {
  const { config, state } = deps
  const verdicts = new Map<unknown, NetworkVerdict>()
  const allowed = new Set(config?.allowedTools ?? [])
  const keyOf = (exec: { callId: string; token?: unknown }): unknown => exec.token ?? exec.callId
  const urlOf = (args: unknown): unknown => (typeof args === 'object' && args !== null ? (args as Record<string, unknown>)['url'] : undefined)

  return {
    async preExecute(exec) {
      if (config === undefined || exec.name !== 'web_fetch') return
      const url = urlOf(exec.arguments)
      if (typeof url !== 'string') return
      const reason = await checkFetchTarget(config, url)
      verdicts.set(keyOf(exec), reason === undefined ? { url, allow: true } : { url, allow: false, reason })
      if (verdicts.size > VERDICT_LIMIT) verdicts.delete(verdicts.keys().next().value)
    },

    guard(exec) {
      const toolName = exec.name
      // The self-test's probe: proves this guard is registered, whatever the pause state.
      if (toolName === CANARY_TOOL) return 'lg-scope: canary call refused'
      if (state.paused && toolName !== 'lg_integrity_check') return state.denial()
      if (config === undefined) return toolName === 'lg_integrity_check' ? undefined : `lg-scope: configuration invalid — ${deps.configError ?? 'unknown'}`

      const prefix = deniedPrefix(toolName)
      if (prefix !== undefined) {
        return `lg-scope: ${toolName} is an execution or derivation tool and is not available to Global`
      }
      if (!allowed.has(toolName)) {
        state.pause('tool-whitelist', `call to a tool outside the whitelist: ${toolName}`)
        return `lg-scope: ${toolName} is not an allowed Global tool`
      }
      if (toolName !== 'lg_integrity_check' && !state.isAgentReady(exec.agent)) {
        return 'lg-scope: the integrity check for this session has not completed'
      }

      if (toolName === 'web_fetch') {
        const url = urlOf(exec.arguments)
        const key = keyOf(exec)
        const verdict = verdicts.get(key)
        verdicts.delete(key)
        if (typeof url !== 'string') return 'lg-scope: web_fetch without a url'
        if (verdict === undefined) return 'lg-scope: no network verdict for this call'
        if (verdict.url !== url) return `lg-scope: network verdict does not match the requested url: ${url}`
        return verdict.allow ? undefined : (verdict.reason ?? 'lg-scope: web_fetch denied')
      }

      if (toolName === 'lg_evidence_session') {
        const session = (exec.arguments as Record<string, unknown> | undefined)?.['session']
        if (session !== undefined && (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(session) || session.includes('..'))) {
          return 'lg-scope: lg_evidence_session: "session" must be a plain session id'
        }
      }

      const rule = PATH_RULES[toolName]
      if (rule === undefined) return undefined
      const args = exec.arguments as Record<string, unknown> | undefined
      const value = args?.[rule.arg]
      if (value !== undefined && typeof value !== 'string') return `lg-scope: ${toolName}: "${rule.arg}" must be a string`
      if (value === undefined && rule.required) return `lg-scope: ${toolName} without a ${rule.arg}`
      if (value === '') return `lg-scope: ${toolName}: "${rule.arg}" is empty`
      const cwds = deps.cwds(exec.agent)
      const bases: string[] = []
      if (rule.lexical === true) {
        for (const base of [cwds.current, cwds.frozen]) if (base !== undefined && !bases.includes(base)) bases.push(base)
      } else if (cwds.current !== undefined) {
        bases.push(cwds.current)
        // `ensure()` falls back to the creation directory when the current one vanished.
        if (!isExistingDirectory(cwds.current) && cwds.frozen !== undefined) bases.push(cwds.frozen)
      }
      if (bases.length === 0) return `lg-scope: ${toolName} needs the session working directory, which is unknown`
      for (const base of bases) {
        const reason = checkPath(config, toolName, value, base, state.protectedList())
        if (reason !== undefined) return reason
      }
      return undefined
    },
  }
}

/** Cordis plugin name. */
export const name = 'lg-scope'

/** Services this plugin reads. */
export const inject = ['tools']

/**
 * Compose the scope guards.
 * @param ctx - plugin context.
 * @param raw - composition config.
 */
export function apply(ctx: Context, raw: RawScopeConfig): void {
  let config: ScopeConfig | undefined
  let configError: string | undefined
  try {
    config = resolveScopeConfig(raw)
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error)
    lgState.pause('scope-config', configError)
  }
  if (config !== undefined) {
    lgState.resume('scope-config')
    lgState.setComponent('scope', config)
    lgState.protect(config.roleFile)
  }
  const runtime = createScopeRuntime({
    config,
    ...(configError === undefined ? {} : { configError }),
    state: lgState,
    cwds: (agent) => sessionCwds(ctx, agent),
  })

  ctx.effect(() => {
    const provide = (ctx as unknown as { provide?: (name: string, value: unknown) => () => void }).provide
    const releases = config === undefined ? [] : [provide?.call(ctx, 'lgWorkspace', config.workspace), provide?.call(ctx, 'lgRoleFile', config.roleFile)]
    return () => {
      for (const release of releases) release?.()
    }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    await runtime.preExecute(exec)
    return await next()
  })

  ctx.tools.guard((exec) => runtime.guard(exec))
}
