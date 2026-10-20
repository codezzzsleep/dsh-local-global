/**
 * `lg-scope` — what a Global session may touch.
 *
 * Two enforcement points, because they have different strengths:
 * - `ctx.tools.guard` is synchronous and monotonic, so it owns path checks.
 * - `tools/pre-execute` is a waterfall and may await, so it owns DNS checks.
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { basename, dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` and the tools/* events live in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

/** Tools that read or write through a path argument. */
export const PATH_TOOLS = ['read', 'read_image', 'write', 'edit', 'glob', 'grep'] as const

/** Tool-name prefixes a Global session must never see, whatever the preset says. */
export const DENIED_TOOL_PREFIXES = ['bash', 'pwsh', 'terminal', 'job_', 'subagent', 'task'] as const

/** Fully resolved scope configuration. */
export interface ScopeConfig {
  /** Absolute Global workspace; every path argument must land inside it. */
  readonly workspace: string
  /** Hosts `web_fetch` may reach, matched exactly or as a subdomain. */
  readonly allowDomains: readonly string[]
  /** Extra restriction for write/edit; defaults to `<workspace>/drafts`. */
  readonly writeRoots: readonly string[]
}

/** Raw plugin config. */
export interface RawScopeConfig {
  readonly workspace?: unknown
  readonly allowDomains?: unknown
  readonly writeRoots?: unknown
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

/**
 * Validate raw config and fill defaults.
 * @param raw - composition config.
 * @returns the resolved configuration.
 * @throws TypeError when the workspace is missing or not absolute.
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
  return { workspace, allowDomains, writeRoots }
}

/** Resolve a path through its nearest existing ancestor, so `..` and symlinks cannot escape. */
export function realpathInside(path: string): string {
  let current = resolvePath(path)
  const tail: string[] = []
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(current)) {
      const real = realpathSync(current)
      return tail.length === 0 ? real : resolvePath(real, ...tail.reverse())
    }
    const parent = dirname(current)
    if (parent === current) break
    tail.push(basename(current))
    current = parent
  }
  return resolvePath(current, ...tail.reverse())
}

/** True when `candidate` is the root itself or lies beneath it. */
export function isInside(root: string, candidate: string): boolean {
  const realRoot = realpathInside(root)
  const realCandidate = realpathInside(candidate)
  return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${sep}`)
}

/** True for loopback, link-local, private, and otherwise non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const octets = address.split('.').map((part) => Number.parseInt(part, 10))
    const [a = 0, b = 0] = octets
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (family === 6) {
    const lower = address.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7))
    return false
  }
  return false
}

/** True when the host is in the allowlist, exactly or as a subdomain. */
export function hostAllowed(host: string, allowDomains: readonly string[]): boolean {
  const lower = host.toLowerCase()
  return allowDomains.some((domain) => lower === domain || lower.endsWith(`.${domain}`))
}

/** Extract the path argument of a path-scoped tool call. */
export function pathArgument(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Decide one path argument; returns a denial reason or undefined. */
export function checkPath(config: ScopeConfig, tool: string, rawPath: string): string | undefined {
  const absolute = isAbsolute(rawPath) ? rawPath : resolvePath(config.workspace, rawPath)
  if (!isInside(config.workspace, absolute)) {
    return `lg-scope: ${tool} path escapes the Global workspace: ${rawPath}`
  }
  if (tool === 'write' || tool === 'edit') {
    const allowed = config.writeRoots.some((root) => isInside(root, absolute))
    if (!allowed) {
      return `lg-scope: ${tool} may only write inside ${config.writeRoots.join(', ')}: ${rawPath}`
    }
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
  const host = parsed.hostname
  if (!hostAllowed(host, config.allowDomains)) {
    return `lg-scope: web_fetch host is not in the allowlist: ${host}`
  }
  if (isIP(host) !== 0) {
    return isPrivateAddress(host) ? `lg-scope: web_fetch refuses a private address: ${host}` : undefined
  }
  try {
    const records = await lookup(host, { all: true, verbatim: true })
    const privateOne = records.find((record) => isPrivateAddress(record.address))
    if (privateOne !== undefined) {
      return `lg-scope: web_fetch resolved ${host} to a private address: ${privateOne.address}`
    }
  } catch (error) {
    return `lg-scope: web_fetch could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`
  }
  return undefined
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
  const config = resolveScopeConfig(raw)

  ctx.tools.guard((exec) => {
    const toolName = exec.name
    for (const prefix of DENIED_TOOL_PREFIXES) {
      if (toolName === prefix || toolName.startsWith(prefix)) {
        return `lg-scope: ${toolName} is an execution or derivation tool and is not available to Global`
      }
    }
    if (!(PATH_TOOLS as readonly string[]).includes(toolName)) return undefined
    const target = pathArgument(exec.arguments)
    if (target === undefined) return undefined
    return checkPath(config, toolName, target)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'web_fetch') return await next()
    const args = exec.arguments
    const url = typeof args === 'object' && args !== null ? (args as Record<string, unknown>)['url'] : undefined
    if (typeof url !== 'string') return { kind: 'deny' as const, reason: 'lg-scope: web_fetch without a url' }
    const reason = await checkFetchTarget(config, url)
    if (reason !== undefined) return { kind: 'deny' as const, reason }
    return await next()
  })
}

/** Exposed for the acceptance harness: the effective configuration. */
export function scopeConfigOf(raw: RawScopeConfig): ScopeConfig {
  return resolveScopeConfig(raw)
}

/** Exposed for tests: whether a path is a directory that exists. */
export function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
