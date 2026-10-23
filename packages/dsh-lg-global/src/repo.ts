/**
 * `lg-repo` — the only way a Global session reads the artifact repository.
 *
 * The mirror is bare and read-only by construction: no tool pushes, the origin
 * push URL is neutralized, and a startup probe proves the credentials cannot
 * write. Reads use plumbing only, so a checkout never exists to be tampered
 * with beyond the refs a resync rewrites. Every model-supplied revision and
 * path is validated and resolved before it reaches git's argv.
 *
 * A bad configuration or a failed mirror setup never throws out of `apply()`:
 * the tools are still registered, refuse with the reason, and the shared state
 * stays paused.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` and the tools/* events live in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'
import { GuardState, lgState, type ProbeResult } from './state.js'
import { redact, serviceOf } from './tools.js'

/** A credential that never prints: JSON, string conversion, and inspect all redact it. */
export class Secret {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  /** The raw value; call only where it is handed to git. */
  reveal(): string {
    return this.#value
  }

  toJSON(): string {
    return '[redacted]'
  }

  toString(): string {
    return '[redacted]'
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]'
  }
}

/** Fully resolved repository configuration. */
export interface RepoConfig {
  /** Real remote URL (what the push probe must talk to). */
  readonly remote: string
  readonly branch: string
  /** Bare mirror directory. */
  readonly mirrorDir: string
  /** Optional HTTP proxy for every git call, passed as `-c http.proxy=`. */
  readonly httpProxy?: string
  /** Global's channel-write credential, used only by the push probe (GD-4). */
  readonly channelToken?: Secret
  /** Username paired with the channel token in HTTP basic auth. */
  readonly channelTokenUser?: string
}

/** Raw plugin config. */
export interface RawRepoConfig {
  readonly remote?: unknown
  readonly branch?: unknown
  readonly mirrorDir?: unknown
  readonly workspace?: unknown
  readonly httpProxy?: unknown
  /** Channel-write token; the probe must still be denied by the code repository. */
  readonly channelToken?: unknown
  /** Name of an environment variable holding the channel-write token. */
  readonly channelTokenEnv?: unknown
  /** Username for the token (default `x-access-token`). */
  readonly channelTokenUser?: unknown
}

/** One git invocation result. */
export interface GitResult {
  readonly stdout: string
  readonly stderr: string
}

/** A failed git invocation, keeping git's own stderr apart from the command line. */
export class GitError extends Error {
  readonly stderr: string
  readonly stdout: string
  readonly exitCode: number | null
  readonly timedOut: boolean

  constructor(message: string, details: { stderr: string; stdout: string; exitCode: number | null; timedOut: boolean }) {
    super(message)
    this.name = 'GitError'
    this.stderr = details.stderr
    this.stdout = details.stdout
    this.exitCode = details.exitCode
    this.timedOut = details.timedOut
  }
}

/** Options for one git call. */
export interface GitOptions {
  cwd?: string
  input?: string
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  /** Extra `-c key=value` pairs, appended after the fixed ones. */
  config?: readonly string[]
  /** Allow the `file` transport; off unless a test builds a local remote on purpose. */
  allowFile?: boolean
  /** Values to scrub from every message this call can produce. */
  secrets?: readonly string[]
  /** Kill the call when stdout grows beyond this many bytes. */
  maxBytes?: number
}

/**
 * The environment git runs under (RP-4): built from nothing, so no `HOME`,
 * `SSH_AUTH_SOCK`, user git config, askpass helper, or transport override of
 * the parent survives. Only `PATH` and `LANG` are inherited.
 * @param allowFile - also permit the `file` transport.
 * @param extra - call-specific additions, applied last.
 * @returns the complete environment.
 */
export function gitEnv(allowFile = false, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    LANG: process.env['LANG'] ?? 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_SSH_COMMAND: '/bin/false',
    GIT_ALLOW_PROTOCOL: allowFile ? 'https:http:file' : 'https:http',
    // No HOME: git would otherwise read $HOME/.netrc credentials that
    // bypass credential.helper entirely.
    HOME: '/nonexistent-lg-home',
    XDG_CONFIG_HOME: '/nonexistent-lg-home',
    ...extra,
  }
}

/** `-c` pairs on every call: no helpers, hooks, or transports beyond the ones we name. */
function baseConfig(allowFile: boolean): string[] {
  return [
    'credential.helper=',
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'core.sshCommand=/bin/false',
    'protocol.allow=never',
    'protocol.https.allow=always',
    'protocol.http.allow=always',
    `protocol.file.allow=${allowFile ? 'always' : 'never'}`,
  ]
}

/**
 * Run git with a fixed argv (never a shell) and return raw stdout bytes.
 * @param args - argv after `git`.
 * @param options - working directory, stdin, extra environment.
 * @returns stdout bytes and stderr text.
 * @throws GitError carrying git's stderr when the command fails.
 */
export async function runGitBytes(args: readonly string[], options: GitOptions = {}): Promise<{ stdout: Buffer; stderr: string }> {
  const secrets = options.secrets ?? []
  const allowFile = options.allowFile === true
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  return await new Promise((resolve, reject) => {
    const configArgs = [...baseConfig(allowFile), ...(options.config ?? [])].flatMap((pair) => ['-c', pair])
    const child = spawn('git', [...configArgs, ...args], {
      cwd: options.cwd,
      env: gitEnv(allowFile, options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    let outBytes = 0
    let stderr = ''
    let timedOut = false
    let overflow = false
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > maxBytes) {
        overflow = true
        child.kill('SIGKILL')
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 1024 * 1024) stderr += chunk
    })
    child.stdin.on('error', () => {})
    // A hanging remote must not hang the profile: every git call is bounded.
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 60000)
    const command = redact(`git ${args.join(' ')}`, secrets)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new GitError(redact(error.message, secrets), { stderr: '', stdout: '', exitCode: null, timedOut: false }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out)
      const cleanStderr = redact(stderr, secrets)
      if (code === 0 && !timedOut && !overflow) {
        resolve({ stdout, stderr: cleanStderr })
        return
      }
      const reason = timedOut
        ? `timed out after ${String(options.timeoutMs ?? 60000)}ms`
        : overflow
          ? `output exceeded ${String(maxBytes)} bytes`
          : `failed (exit ${String(code)}): ${redact((cleanStderr || stdout.toString('utf8')).trim(), secrets)}`
      reject(new GitError(`${command} ${reason}`, { stderr: cleanStderr, stdout: redact(stdout.toString('utf8'), secrets), exitCode: code, timedOut }))
    })
    child.stdin.end(options.input ?? '')
  })
}

/**
 * Run git with a fixed argv (never a shell).
 * @param args - argv after `git`.
 * @param options - working directory, stdin, extra environment.
 * @returns stdout and stderr as text.
 * @throws GitError carrying git's stderr when the command fails.
 */
export async function runGit(args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const { stdout, stderr } = await runGitBytes(args, options)
  return { stdout: stdout.toString('utf8'), stderr }
}

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u

/** A branch name git accepts that cannot be read as an option or a revision operator. */
function validBranch(branch: string): boolean {
  return (
    BRANCH_PATTERN.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.endsWith('.lock') &&
    !branch.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  )
}

/**
 * Accept only the two remote shapes the spec names (RP-3): an `https` URL
 * without credentials, or the repository sandbox's `http://127.0.0.1:<port>/`.
 */
function validateRemote(remote: string): void {
  let parsed: URL
  try {
    parsed = new URL(remote)
  } catch {
    throw new TypeError('lg-repo: "remote" must be an https URL; ssh, git@ and local paths are refused')
  }
  const authority = remote.slice(remote.indexOf('//') + 2).split(/[/?#]/u)[0] ?? ''
  if (authority.includes('@') || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('lg-repo: "remote" must not carry a username or token — Global must use an anonymous read-only URL')
  }
  if (parsed.protocol === 'https:' && parsed.hostname !== '') return
  if (parsed.protocol === 'http:' && /^http:\/\/127\.0\.0\.1:[0-9]{1,5}(?:[/?#]|$)/u.test(remote)) return
  throw new TypeError('lg-repo: "remote" must be an https URL or the repository sandbox http://127.0.0.1:<port>/ ; ssh, git@ and file:// are refused')
}

/**
 * Validate raw config and fill defaults.
 * @param raw - composition config.
 * @returns the resolved configuration.
 * @throws TypeError when the remote, branch, mirror directory, proxy or credential is unusable.
 */
export function resolveRepoConfig(raw: RawRepoConfig): RepoConfig {
  if (typeof raw.remote !== 'string' || raw.remote.trim().length === 0) {
    throw new TypeError('lg-repo: "remote" is required (git URL of the artifact repository)')
  }
  validateRemote(raw.remote)
  const branch = raw.branch === undefined ? 'main' : String(raw.branch)
  if (!validBranch(branch)) throw new TypeError(`lg-repo: "branch" is not a plain branch name: ${branch}`)
  const base = typeof raw.workspace === 'string' ? resolvePath(raw.workspace) : undefined
  if (raw.mirrorDir === undefined && base === undefined) {
    throw new TypeError('lg-repo: set "mirrorDir" or run with an lg-scope workspace')
  }
  const mirrorDir = raw.mirrorDir === undefined ? join(base ?? '', 'repo.git') : resolvePath(String(raw.mirrorDir))
  if (!isAbsolute(mirrorDir)) throw new TypeError('lg-repo: "mirrorDir" must be absolute')
  let httpProxy: string | undefined
  if (raw.httpProxy !== undefined) {
    if (typeof raw.httpProxy !== 'string' || !/^https?:\/\//.test(raw.httpProxy)) {
      throw new TypeError('lg-repo: "httpProxy" must be an http(s) URL, e.g. http://127.0.0.1:7890')
    }
    httpProxy = raw.httpProxy
  }
  let token: string | undefined
  if (raw.channelToken !== undefined) {
    if (typeof raw.channelToken !== 'string' || raw.channelToken.length === 0) throw new TypeError('lg-repo: "channelToken" must be a non-empty string')
    token = raw.channelToken
  }
  if (raw.channelTokenEnv !== undefined) {
    const value = typeof raw.channelTokenEnv === 'string' ? process.env[raw.channelTokenEnv] : undefined
    if (value === undefined || value.length === 0) throw new TypeError('lg-repo: "channelTokenEnv" names an environment variable that is not set')
    token = value
  }
  const user = raw.channelTokenUser === undefined ? 'x-access-token' : String(raw.channelTokenUser)
  if (user.length === 0 || /[:\s]/u.test(user)) throw new TypeError('lg-repo: "channelTokenUser" is not a valid username')
  return {
    remote: raw.remote,
    branch,
    mirrorDir,
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(token === undefined ? {} : { channelToken: new Secret(token), channelTokenUser: user }),
  }
}

/** The effective configuration with every secret removed, for the configuration hash. */
export function repoSnapshot(config: RepoConfig): Record<string, unknown> {
  let proxy: string | undefined
  if (config.httpProxy !== undefined) {
    try {
      const url = new URL(config.httpProxy)
      url.username = ''
      url.password = ''
      proxy = url.href
    } catch {
      proxy = '[unparseable]'
    }
  }
  return {
    remote: config.remote,
    branch: config.branch,
    mirrorDir: config.mirrorDir,
    httpProxy: proxy ?? null,
    channelCredential: config.channelToken === undefined ? 'none' : 'configured',
  }
}

/**
 * Apply one probe outcome to the shared state.
 *
 * The rule from SPEC "lg-repo": `writable` pauses, `denied` passes,
 * `inconclusive` is a warning that never pauses and never lifts a pause: only
 * `denied` is proof the credential cannot write.
 * @param state - the shared guard state.
 * @param probe - the probe outcome and its raw detail.
 * @returns which branch was taken, for the caller's logging.
 */
export function recordProbeOutcome(state: GuardState, probe: PushProbe): 'pause' | 'pass' | 'warn' {
  if (probe.verdict === 'writable') {
    state.pause('push-probe', `writable: ${probe.detail}`)
    state.clearWarning('push-probe')
    return 'pause'
  }
  if (probe.verdict === 'denied') {
    state.resume('push-probe')
    state.clearWarning('push-probe')
    return 'pass'
  }
  state.warn('push-probe', `inconclusive: ${probe.detail.slice(0, 300)}`)
  return 'warn'
}

/** The mirror config values the plugin itself writes, keyed by canonical git key. */
export interface MirrorExpectations {
  readonly remote: string
  readonly httpProxy?: string
}

const isBool = (value: string): boolean => value === 'true' || value === 'false'

/**
 * Git config keys a mirror may hold, each with the values it may take.
 *
 * `git init --bare` writes the `core.*` defaults, the plugin writes the three
 * `remote.origin.*` keys (the push URL is deliberately `file:///dev/null`), and
 * `http.proxy` appears only when a proxy is configured. Anything else means
 * someone edited the mirror (SPEC "lg-repo", RP-5). Keys are canonical: section
 * and variable lowercase, subsection exactly as written (git compares a
 * subsection case-sensitively, so `remote.ORIGIN.pushurl` is a different key).
 */
const MIRROR_KEYS: Readonly<Record<string, (value: string, expect: MirrorExpectations | undefined) => boolean>> = {
  'core.repositoryformatversion': (value) => value === '0',
  'core.filemode': isBool,
  'core.bare': (value) => value === 'true',
  'core.logallrefupdates': isBool,
  'remote.origin.url': (value, expect) => expect === undefined || value === expect.remote,
  'remote.origin.fetch': (value) => value === '+refs/heads/*:refs/remotes/origin/*',
  'remote.origin.pushurl': (value) => value === 'file:///dev/null',
  'http.proxy': (value, expect) => expect === undefined || (expect.httpProxy !== undefined && value === expect.httpProxy),
}

/** The allowed key names, for reference and tests. */
export const ALLOWED_MIRROR_KEYS = Object.keys(MIRROR_KEYS)

/** `section.sub.variable` with section and variable lowercased and the subsection untouched. */
function canonicalKey(key: string): string {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  if (first === -1) return key.toLowerCase()
  if (first === last) return key.toLowerCase()
  return `${key.slice(0, first).toLowerCase()}.${key.slice(first + 1, last)}.${key.slice(last + 1).toLowerCase()}`
}

/**
 * Everything wrong with the mirror's own git config: unknown keys, keys set
 * twice, and allowed keys holding values the plugin did not write.
 * @param mirrorDir - the bare mirror.
 * @param expect - the values the plugin writes; without it only keys are checked.
 * @returns one entry per violation (key names only, never values).
 */
export async function mirrorConfigViolations(mirrorDir: string, expect?: MirrorExpectations): Promise<string[]> {
  const { stdout } = await runGit(['config', '--local', '--list', '-z'], { cwd: mirrorDir })
  const seen = new Set<string>()
  const violations: string[] = []
  for (const entry of stdout.split('\0')) {
    if (entry.length === 0) continue
    const newline = entry.indexOf('\n')
    const key = canonicalKey(newline === -1 ? entry : entry.slice(0, newline))
    const value = newline === -1 ? '' : entry.slice(newline + 1)
    const check = Object.prototype.hasOwnProperty.call(MIRROR_KEYS, key) ? MIRROR_KEYS[key] : undefined
    if (check === undefined) {
      violations.push(key)
    } else if (seen.has(key)) {
      violations.push(`${key} (set twice)`)
    } else if (!check(value, expect)) {
      violations.push(`${key} (unexpected value)`)
    }
    seen.add(key)
  }
  return violations
}

/** Config keys in the mirror that the plugin did not write. */
export async function foreignMirrorKeys(mirrorDir: string, expect?: MirrorExpectations): Promise<string[]> {
  return await mirrorConfigViolations(mirrorDir, expect)
}

/** `-c http.proxy=` pairs for a configuration, empty when no proxy is set. */
export function proxyConfig(config: RepoConfig): readonly string[] {
  return config.httpProxy === undefined ? [] : [`http.proxy=${config.httpProxy}`]
}

/** Outcome of the write-capability probe. */
export interface PushProbe {
  /** `denied` means the credentials cannot write; `writable` is a hard failure. */
  readonly verdict: 'denied' | 'writable' | 'inconclusive'
  readonly exitCode: number | null
  readonly detail: string
}

/** Failures that say nothing about permissions; checked before any permission marker. */
const NETWORK_MARKERS = [
  /could not resolve host/iu,
  /failed to connect/iu,
  /connection (?:refused|timed out|reset)/iu,
  /operation timed out/iu,
  /network is unreachable/iu,
  /no route to host/iu,
  /ssl|tls|certificate/iu,
  /proxy/iu,
]

/**
 * Client-side refusals of a ref update. Git only gets this far after the
 * receive-pack advertisement was served, i.e. the credential may write.
 */
const REJECTED_MARKERS = [/!\s+\[rejected\]/iu, /\((?:fetch first|non-fast-forward)\)/iu]

/** SPEC "lg-repo" markers for a refused write, matched on git's own message only. */
const PERMISSION_MARKERS = [
  /permission denied/iu,
  /permission to .{1,200}? denied/iu,
  /\bdenied\b/iu,
  /returned error: 403\b/iu,
  /\bHTTP(?:\/[\d.]+)? 403\b/iu,
  /\b403 forbidden\b/iu,
  /read-only/iu,
  /could not read (?:username|password)/iu,
  /authentication failed/iu,
]

/**
 * Classify a failed push by git's stderr alone.
 *
 * The command line and the URL are not evidence: a DNS failure for
 * `https://host/read-only.git` mentions "read-only" and must stay inconclusive.
 * @param stderr - git's standard error.
 * @param remote - the remote URL, removed before matching.
 * @returns `writable` for a client-side ref rejection, `denied` only for a permission marker with no network failure.
 */
export function classifyPushFailure(stderr: string, remote: string): 'writable' | 'denied' | 'inconclusive' {
  const cleaned = stderr
    .split(remote)
    .join('<remote>')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/giu, '<url>')
    .replace(/(could not resolve host:)\s*\S+/giu, '$1 <host>')
  if (NETWORK_MARKERS.some((marker) => marker.test(cleaned))) return 'inconclusive'
  // Lines the server sent ("remote: ...") are not evidence of what git did.
  const local = cleaned.split('\n').filter((line) => !/^\s*remote:/iu.test(line)).join('\n')
  if (REJECTED_MARKERS.some((marker) => marker.test(local))) return 'writable'
  return PERMISSION_MARKERS.some((marker) => marker.test(cleaned)) ? 'denied' : 'inconclusive'
}

/** Git config and environment that attach the channel-write credential to the remote's origin only. */
function credentialEnv(config: RepoConfig): { env: Record<string, string>; secrets: string[] } {
  if (config.channelToken === undefined) return { env: {}, secrets: [] }
  const token = config.channelToken.reveal()
  const basic = Buffer.from(`${config.channelTokenUser ?? 'x-access-token'}:${token}`).toString('base64')
  const origin = `${new URL(config.remote).origin}/`
  return {
    // Environment, not argv: the token must not show up in a process listing.
    env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${origin}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` },
    secrets: [token, basic],
  }
}

/**
 * Prove the configured credentials cannot write to the real remote.
 *
 * The probe talks to `config.remote` directly, not to the mirror's (deliberately
 * broken) push URL: a failure caused by an invalid URL proves nothing. When a
 * channel-write credential is configured the probe sends it, so GD-4 holds for
 * the credential Global actually has, not just for an anonymous client.
 * @param config - repository configuration.
 * @param options - `allowFile` lets a test use a local bare repository as remote.
 * @returns the verdict and the original git output.
 */
export async function probePushDenied(config: RepoConfig, options: { allowFile?: boolean } = {}): Promise<PushProbe> {
  const proxyArgs = proxyConfig(config)
  const allowFile = options.allowFile === true
  const credential = credentialEnv(config)
  // A scratch repository with one commit: the probe must not depend on the
  // mirror having a HEAD, or the first boot can only produce `inconclusive`.
  const scratch = mkdtempSync(join(tmpdir(), 'lg-push-probe-'))
  const identity = {
    GIT_AUTHOR_NAME: 'lg-probe',
    GIT_AUTHOR_EMAIL: 'lg-probe@invalid',
    GIT_COMMITTER_NAME: 'lg-probe',
    GIT_COMMITTER_EMAIL: 'lg-probe@invalid',
  }
  try {
    try {
      await runGit(['init', '--quiet', '--initial-branch', config.branch, scratch], { env: identity, config: proxyArgs })
      const tree = (await runGit(['mktree'], { cwd: scratch, input: '', env: identity, config: proxyArgs })).stdout.trim()
      const commit = (await runGit(['commit-tree', tree, '-m', 'probe'], { cwd: scratch, env: identity, config: proxyArgs })).stdout.trim()
      await runGit(['update-ref', `refs/heads/${config.branch}`, commit], { cwd: scratch, env: identity, config: proxyArgs })
    } catch (error) {
      return { verdict: 'inconclusive', exitCode: null, detail: `probe setup failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      // A fresh ref cannot be rejected as non-fast-forward, so an existing branch does not mask a writable credential.
      const probeRef = `refs/heads/lg-probe-${randomBytes(8).toString('hex')}`
      const result = await runGit(['push', '--dry-run', '--no-verify', '--', config.remote, `HEAD:${probeRef}`], {
        cwd: scratch,
        config: proxyArgs,
        allowFile,
        env: credential.env,
        secrets: credential.secrets,
      })
      return { verdict: 'writable', exitCode: 0, detail: `${result.stdout}${result.stderr}`.trim() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!(error instanceof GitError) || error.timedOut) return { verdict: 'inconclusive', exitCode: null, detail: message }
      return { verdict: classifyPushFailure(error.stderr, config.remote), exitCode: error.exitCode, detail: message }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Thrown when the mirror's own git config was edited. */
export class MirrorConfigError extends Error {}

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const REV_MAX = 256
const PATH_MAX = 4096

/** Shape a revision must have before it is even handed to `rev-parse`. */
function checkRevisionSyntax(rev: unknown, label: string): string {
  if (typeof rev !== 'string' || rev.length === 0 || rev.length > REV_MAX) throw new TypeError(`lg-repo: ${label} must be a revision of 1-${String(REV_MAX)} characters`)
  if (rev.startsWith('-')) throw new TypeError(`lg-repo: ${label} must not start with "-": ${rev}`)
  if (/[\u0000-\u0020\u007f]/u.test(rev)) throw new TypeError(`lg-repo: ${label} must not contain whitespace or control characters`)
  return rev
}

/** Shape a repository-relative path must have: no option look-alikes, absolute paths, or `..`. */
export function checkRepoPath(path: unknown, label = 'path'): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > PATH_MAX) throw new TypeError(`lg-repo: ${label} must be a path of 1-${String(PATH_MAX)} characters`)
  if (path.includes('\0')) throw new TypeError(`lg-repo: ${label} must not contain a NUL byte`)
  if (path.startsWith('-')) throw new TypeError(`lg-repo: ${label} must not start with "-" (write ./${path} instead)`)
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/u.test(path)) throw new TypeError(`lg-repo: ${label} must be relative to the repository root`)
  if (path.split(/[\\/]/u).includes('..')) throw new TypeError(`lg-repo: ${label} must not contain ".."`)
  return path
}

/** A file read from the mirror. */
export interface ShowResult {
  /** `utf8` when the bytes are valid UTF-8; otherwise `base64`, never a lossy decode. */
  readonly encoding: 'utf8' | 'base64'
  readonly text: string
  /** Size of the original blob in bytes. */
  readonly bytes: number
}

/** Options for a mirror. */
export interface MirrorOptions {
  /** Permit the `file` transport; tests only, never from plugin config. */
  readonly allowFile?: boolean
  /** State the config check reports to; the process-wide one by default. */
  readonly state?: GuardState
}

/** Read-only mirror over one artifact repository. */
export class RepoMirror {
  readonly config: RepoConfig
  private readonly proxyArgs: readonly string[]
  private readonly allowFile: boolean
  private readonly state: GuardState

  /** Optional sink for diagnostics; the plugin sets it in its effect. */
  diagnostic: ((message: string) => void) | undefined

  constructor(config: RepoConfig, options: MirrorOptions = {}) {
    this.config = config
    this.proxyArgs = proxyConfig(config)
    this.allowFile = options.allowFile === true
    this.state = options.state ?? lgState
  }

  private async git(args: readonly string[], input?: string): Promise<GitResult> {
    return await runGit(args, {
      cwd: this.config.mirrorDir,
      config: this.proxyArgs,
      allowFile: this.allowFile,
      ...(input === undefined ? {} : { input }),
    })
  }

  /**
   * Create the bare mirror on first use, repair what a resync repairs, and check
   * its own config (RP-5).
   * @returns the config violations; empty when the mirror is clean.
   */
  async ensure(): Promise<string[]> {
    await mkdir(this.config.mirrorDir, { recursive: true })
    if (!existsSync(join(this.config.mirrorDir, 'HEAD'))) {
      await runGit(['init', '--bare', '--initial-branch', this.config.branch, this.config.mirrorDir], { config: this.proxyArgs })
      await this.git(['remote', 'add', 'origin', this.config.remote])
    }
    // Keep the mirror pointed at the configured remote even if it was created
    // under an earlier configuration. A failure here is a failed setup, not a
    // detail to swallow.
    await this.git(['remote', 'set-url', 'origin', this.config.remote])
    // Defense in depth: even a code path that tried to push through origin
    // would hit an unusable URL. The probe deliberately bypasses it.
    await this.git(['remote', 'set-url', '--push', 'origin', 'file:///dev/null'])

    // SPEC "lg-repo": the mirror's own config may only hold keys this plugin
    // wrote; checked at startup and on every sync.
    const violations = await mirrorConfigViolations(this.config.mirrorDir, {
      remote: this.config.remote,
      ...(this.config.httpProxy === undefined ? {} : { httpProxy: this.config.httpProxy }),
    })
    if (violations.length > 0) {
      this.state.pause('mirror-config', `mirror config is not what the plugin wrote: ${violations.join(', ')}`)
      this.diagnostic?.(`lg-repo: mirror config violations: ${violations.join(', ')}`)
    } else {
      this.state.resume('mirror-config')
    }
    return violations
  }

  /** Fetch the remote branch and hard-reset the local ref to it. */
  async sync(): Promise<{ head: string; remoteHead: string }> {
    const violations = await this.ensure()
    if (violations.length > 0) throw new MirrorConfigError(`lg-repo: refusing to sync, mirror config is not what the plugin wrote: ${violations.join(', ')}`)
    const branch = this.config.branch
    await this.git(['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'])
    const remoteHead = (await this.git(['rev-parse', '--verify', '--end-of-options', `refs/remotes/origin/${branch}^{commit}`])).stdout.trim()
    await this.git(['update-ref', `refs/heads/${branch}`, remoteHead])
    const head = (await this.git(['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`])).stdout.trim()
    return { head, remoteHead }
  }

  /** Current mirror HEAD. */
  async head(): Promise<string> {
    return (await this.git(['rev-parse', '--verify', '--end-of-options', `refs/heads/${this.config.branch}^{commit}`])).stdout.trim()
  }

  /** Resolve a model-supplied revision to a full commit id inside the mirror. */
  async resolveCommit(rev: unknown, label = 'revision'): Promise<string> {
    const checked = checkRevisionSyntax(rev, label)
    let sha: string
    try {
      sha = (await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${checked}^{commit}`])).stdout.trim()
    } catch {
      throw new Error(`lg-repo: ${label} is not a commit in the mirror: ${checked}`)
    }
    if (!SHA_PATTERN.test(sha)) throw new Error(`lg-repo: ${label} is not a commit in the mirror: ${checked}`)
    return sha
  }

  /** List commits, newest first. */
  async log(limit: unknown = 20): Promise<{ sha: string; subject: string }[]> {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('lg-repo: limit must be an integer from 1 to 1000')
    }
    const { stdout } = await this.git(['log', `--max-count=${String(limit)}`, '--format=%H%x00%s', '--end-of-options', `refs/heads/${this.config.branch}`])
    return stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha = '', subject = ''] = line.split('\u0000')
        return { sha, subject }
      })
  }

  /** Diff two commits, optionally limited to a path. */
  async diff(from: unknown, to: unknown, path?: unknown): Promise<string> {
    const [a, b] = [await this.resolveCommit(from, 'from'), await this.resolveCommit(to, 'to')]
    const args = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', a, b]
    if (path !== undefined) args.push('--', checkRepoPath(path))
    return (await this.git(args)).stdout
  }

  /** Read a file at a commit, byte-exact: text when valid UTF-8, otherwise base64. */
  async show(commit: unknown, path: unknown): Promise<ShowResult> {
    const sha = await this.resolveCommit(commit, 'commit')
    const file = checkRepoPath(path)
    const { stdout } = await runGitBytes(['cat-file', 'blob', `${sha}:${file}`], {
      cwd: this.config.mirrorDir,
      config: this.proxyArgs,
      allowFile: this.allowFile,
    })
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout)
      return { encoding: 'utf8', text, bytes: stdout.length }
    } catch {
      return { encoding: 'base64', text: stdout.toString('base64'), bytes: stdout.length }
    }
  }
}

/** Where the runtime gets its configuration; resolved on demand so service order does not matter. */
export type RepoConfigSource = () => { config: RepoConfig } | { error: string }

/** Dependencies of {@link RepoRuntime}. */
export interface RepoRuntimeDeps {
  readonly state: GuardState
  readonly resolve: RepoConfigSource
  readonly allowFile?: boolean
  /** Replaceable in tests. */
  readonly probe?: (config: RepoConfig, options: { allowFile?: boolean }) => Promise<PushProbe>
  /** Runs the integrity checks after a sync; throws when they fail. */
  readonly afterSync?: (agent: unknown) => Promise<void>
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/**
 * The mirror, its checks, and their pause bookkeeping. Provided to the other
 * Global plugins as the `lgRepo` service.
 */
export class RepoRuntime {
  private mirrorInstance: RepoMirror | undefined
  private last: PushProbe | undefined
  private startPromise: Promise<void> | undefined

  constructor(private readonly deps: RepoRuntimeDeps) {}

  /** Settles when the startup setup and probe finished, successfully or not. */
  get ready(): Promise<void> {
    return this.startPromise ?? Promise.resolve()
  }

  /** Begin the startup mirror setup and push probe (idempotent). */
  start(): Promise<void> {
    this.startPromise ??= this.recheck({ pushProbe: true }).then(
      () => undefined,
      () => undefined,
    )
    return this.startPromise
  }

  private config(): RepoConfig | string {
    const resolved = this.deps.resolve()
    if ('error' in resolved) {
      this.deps.state.setComponent('repo', { invalid: resolved.error })
      return resolved.error
    }
    if (this.mirrorInstance?.config.remote !== resolved.config.remote || this.mirrorInstance.config.mirrorDir !== resolved.config.mirrorDir) {
      this.mirrorInstance = new RepoMirror(resolved.config, {
        state: this.deps.state,
        ...(this.deps.allowFile === true ? { allowFile: true } : {}),
      })
      this.mirrorInstance.diagnostic = (message) => this.deps.log?.('warn', message)
    }
    this.deps.state.setComponent('repo', repoSnapshot(resolved.config))
    this.deps.state.protect(resolved.config.mirrorDir)
    return resolved.config
  }

  /** The mirror, or an error carrying why the configuration is unusable. */
  mirror(): RepoMirror {
    const config = this.config()
    if (typeof config === 'string' || this.mirrorInstance === undefined) throw new Error(`lg-repo is unavailable: ${typeof config === 'string' ? config : 'no mirror'}`)
    return this.mirrorInstance
  }

  private apply(result: ProbeResult): ProbeResult {
    if (result.pass) this.deps.state.resume(result.name)
    else this.deps.state.pause(result.name, result.detail)
    return result
  }

  /**
   * Re-run every repository check and apply the outcome to the pause state.
   * @param options - `pushProbe: false` reuses the last probe verdict.
   * @returns one result per check that could run.
   */
  async recheck(options: { pushProbe: boolean }): Promise<ProbeResult[]> {
    const config = this.config()
    if (typeof config === 'string') return [this.apply({ name: 'repo-config', pass: false, detail: config })]
    const results: ProbeResult[] = [this.apply({ name: 'repo-config', pass: true, detail: 'configuration valid' })]
    const mirror = this.mirrorInstance
    if (mirror === undefined) return results
    try {
      const violations = await mirror.ensure()
      results.push(this.apply({ name: 'mirror-init', pass: true, detail: mirror.config.mirrorDir }))
      results.push(
        violations.length === 0
          ? { name: 'mirror-config', pass: true, detail: 'only keys the plugin wrote' }
          : { name: 'mirror-config', pass: false, detail: `mirror config is not what the plugin wrote: ${violations.join(', ')}` },
      )
    } catch (error) {
      const detail = `mirror setup failed: ${error instanceof Error ? error.message : String(error)}`
      this.deps.log?.('error', `lg-repo: ${detail}`)
      results.push(this.apply({ name: 'mirror-init', pass: false, detail }))
      return results
    }
    const probe = options.pushProbe || this.last === undefined ? await this.runProbe(config) : this.last
    const branch = recordProbeOutcome(this.deps.state, probe)
    results.push({
      name: 'push-probe',
      pass: branch !== 'pause',
      detail: `${probe.verdict}${probe.verdict === 'denied' ? '' : `: ${probe.detail.slice(0, 300)}`}`,
    })
    return results
  }

  private async runProbe(config: RepoConfig): Promise<PushProbe> {
    const probe = await (this.deps.probe ?? probePushDenied)(config, this.deps.allowFile === true ? { allowFile: true } : {})
    this.last = probe
    this.deps.log?.(probe.verdict === 'writable' ? 'error' : probe.verdict === 'inconclusive' ? 'warn' : 'info', `lg-repo: push probe ${probe.verdict}`)
    return probe
  }

  /** `lg_repo_sync`: fetch, hard-reset the branch, then run the integrity checks. */
  async sync(agent?: unknown): Promise<{ head: string; remoteHead: string; equal: boolean }> {
    const result = await this.mirror().sync()
    await this.deps.afterSync?.(agent)
    return { ...result, equal: result.head === result.remoteHead }
  }
}

/** Cordis plugin name. */
export const name = 'lg-repo'

/** Services this plugin reads. */
export const inject = ['tools']

type ToolDefinition = Parameters<Context['tools']['register']>[0]

const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value })

/**
 * Compose the read-only repository tools.
 * @param ctx - plugin context.
 * @param raw - composition config.
 */
export function apply(ctx: Context, raw: RawRepoConfig): void {
  const logger = (level: 'info' | 'warn' | 'error', message: string): void => {
    const sink = ctx.logger?.('lg-repo') as unknown as Record<string, ((message: string) => void) | undefined> | undefined
    sink?.[level]?.(message)
  }
  const runtime = new RepoRuntime({
    state: lgState,
    resolve: () => {
      try {
        return { config: resolveRepoConfig({ workspace: serviceOf<string>(ctx, 'lgWorkspace'), ...raw }) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    log: logger,
    afterSync: async (agent) => {
      const integrity = serviceOf<{ run(options: { agent?: unknown; pushProbe: boolean }): Promise<{ clean: boolean; failures: string[] }> }>(ctx, 'lgIntegrity')
      if (integrity === undefined) throw new Error('lg_repo_sync: lg-integrity is not running, so the post-sync checks cannot run')
      const report = await integrity.run({ agent, pushProbe: false })
      if (!report.clean) throw new Error(`lg_repo_sync: integrity check failed after sync: ${report.failures.join('; ')}`)
    },
  })

  ctx.effect(() => {
    const release = (ctx as unknown as { provide?: (name: string, value: unknown) => () => void }).provide?.('lgRepo', runtime)
    void runtime.start()
    return () => release?.()
  })

  ctx.tools.register({
    name: 'lg_repo_sync',
    description: 'Fetch the artifact repository and hard-reset the read-only mirror to the remote branch.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { head: { type: 'string' }, remoteHead: { type: 'string' }, equal: { type: 'boolean' } }, required: ['head', 'remoteHead', 'equal'] },
      render: (_args: unknown, value: { head: string; remoteHead: string; equal: boolean }) => [
        text(`mirror ${value.head.slice(0, 12)} / remote ${value.remoteHead.slice(0, 12)} (${value.equal ? 'equal' : 'differs'})`),
      ],
    },
    async execute(_args: unknown, exec?: { agent?: unknown }) {
      return await runtime.sync(exec?.agent)
    },
  } as ToolDefinition)

  ctx.tools.register({
    name: 'lg_repo_log',
    description: 'List commits on the mirror branch, newest first.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    output: {
      schema: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      render: (_args: unknown, value: { text: string }[]) => [text(value.map((item) => item.text).join('\n') || '(empty)')],
    },
    async execute(args: { limit?: unknown }) {
      return (await runtime.mirror().log(args.limit ?? 20)).map((entry) => ({ text: `${entry.sha} ${entry.subject}` }))
    },
  } as ToolDefinition)

  ctx.tools.register({
    name: 'lg_repo_diff',
    description: 'Diff two commits on the mirror, optionally limited to one path.',
    parameters: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' }, path: { type: 'string' } },
      required: ['from', 'to'],
    },
    output: {
      schema: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      render: (_args: unknown, value: { text: string }[]) => [text(value.map((item) => item.text).join('\n') || '(no diff)')],
    },
    async execute(args: { from: unknown; to: unknown; path?: unknown }) {
      return [{ text: await runtime.mirror().diff(args.from, args.to, args.path) }]
    },
  } as ToolDefinition)

  ctx.tools.register({
    name: 'lg_repo_show',
    description: 'Read one file at one commit from the mirror, byte-exact: text when it is valid UTF-8, otherwise base64 (encoding says which).',
    parameters: {
      type: 'object',
      properties: { commit: { type: 'string' }, path: { type: 'string' } },
      required: ['commit', 'path'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, bytes: { type: 'number' }, encoding: { type: 'string', enum: ['utf8', 'base64'] } },
        required: ['text', 'bytes', 'encoding'],
      },
      render: (_args: unknown, value: { text: string; bytes: number; encoding: string }) => [
        text(value.encoding === 'base64' ? `[binary, ${String(value.bytes)} bytes, base64]\n${value.text}` : value.text),
      ],
    },
    async execute(args: { commit: unknown; path: unknown }) {
      return { ...(await runtime.mirror().show(args.commit, args.path)) }
    },
  } as ToolDefinition)
}

/** Exposed for the acceptance harness. */
export { RepoMirror as RepoMirrorClass }
