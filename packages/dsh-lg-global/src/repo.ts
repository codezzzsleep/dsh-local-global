/**
 * `lg-repo` — the only way a Global session reads the artifact repository.
 *
 * The mirror is bare and read-only by construction: no tool pushes, the origin
 * push URL is neutralized, and a startup probe proves the credentials cannot
 * write. Reads use plumbing only, so a checkout never exists to be tampered
 * with beyond the refs a resync rewrites.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { GuardState, lgState } from './state.js'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` and the tools/* events live in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

/** Fully resolved repository configuration. */
export interface RepoConfig {
  /** Real remote URL (what the push probe must talk to). */
  readonly remote: string
  readonly branch: string
  /** Bare mirror directory. */
  readonly mirrorDir: string
  /** Optional HTTP proxy for every git call, passed as `-c http.proxy=`. */
  readonly httpProxy?: string
}

/** Raw plugin config. */
export interface RawRepoConfig {
  readonly remote?: unknown
  readonly branch?: unknown
  readonly mirrorDir?: unknown
  readonly workspace?: unknown
  readonly httpProxy?: unknown
}

/** One git invocation result. */
export interface GitResult {
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run git with a fixed argv (never a shell).
 * @param args - argv after `git`.
 * @param options - working directory, stdin, extra environment.
 * @returns stdout and stderr as written.
 * @throws Error carrying git's stderr when the command fails.
 */
export async function runGit(
  args: readonly string[],
  options: {
    cwd?: string
    input?: string
    env?: Readonly<Record<string, string>>
    timeoutMs?: number
    /** Extra `-c key=value` pairs, appended after the fixed ones. */
    config?: readonly string[]
  } = {},
): Promise<GitResult> {
  return await new Promise<GitResult>((resolve, reject) => {
    // A curated environment: inheriting process.env would hand Global the same
    // SSH keys, ssh-agent, and credential helper that Local pushes with.
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      LANG: process.env['LANG'] ?? 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_SSH_COMMAND: '/bin/false',
      // No HOME: git would otherwise read $HOME/.netrc credentials that
      // bypass credential.helper entirely.
      HOME: '/nonexistent-lg-home',
      XDG_CONFIG_HOME: '/nonexistent-lg-home',
      ...options.env,
    }
    const configArgs = (options.config ?? []).flatMap((pair) => ['-c', pair])
    const child = spawn('git', ['-c', 'protocol.file.allow=always', '-c', 'credential.helper=', ...configArgs, ...args], {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdin.on('error', () => {})
    // A hanging remote must not hang the profile: every git call is bounded.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`git ${args.join(' ')} timed out after ${String(options.timeoutMs ?? 60000)}ms`))
    }, options.timeoutMs ?? 60000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`git ${args.join(' ')} failed (exit ${String(code)}): ${(stderr || stdout).trim()}`))
    })
    child.stdin.end(options.input ?? '')
  })
}

/**
 * Validate raw config and fill defaults.
 * @param raw - composition config.
 * @returns the resolved configuration.
 * @throws TypeError when the remote is missing.
 */
export function resolveRepoConfig(raw: RawRepoConfig): RepoConfig {
  if (typeof raw.remote !== 'string' || raw.remote.trim().length === 0) {
    throw new TypeError('lg-repo: "remote" is required (git URL of the artifact repository)')
  }
  const branch = raw.branch === undefined ? 'main' : String(raw.branch)
  const base = typeof raw.workspace === 'string' ? resolvePath(raw.workspace) : process.cwd()
  const mirrorDir = raw.mirrorDir === undefined ? join(base, 'repo.git') : resolvePath(String(raw.mirrorDir))
  if (!isAbsolute(mirrorDir)) throw new TypeError('lg-repo: "mirrorDir" must be absolute')
  if (raw.remote.startsWith('ssh://') || (raw.remote.includes('@') && raw.remote.includes(':'))) {
    throw new TypeError('lg-repo: SSH remotes are refused — Global must use an anonymous read-only URL')
  }
  if (!raw.remote.startsWith('https://')) {
    throw new TypeError('lg-repo: M2 implements and accepts https remotes only; file:// hosting is still undecided')
  }
  let httpProxy: string | undefined
  if (raw.httpProxy !== undefined) {
    if (typeof raw.httpProxy !== 'string' || !/^https?:\/\//.test(raw.httpProxy)) {
      throw new TypeError('lg-repo: "httpProxy" must be an http(s) URL, e.g. http://127.0.0.1:7890')
    }
    httpProxy = raw.httpProxy
  }
  return { remote: raw.remote, branch, mirrorDir, ...(httpProxy === undefined ? {} : { httpProxy }) }
}

/**
 * Apply one probe outcome to the shared state.
 *
 * The rule from SPEC "lg-repo": `writable` pauses, `denied` passes,
 * `inconclusive` is a warning that never pauses.
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
  state.resume('push-probe')
  state.warn('push-probe', `inconclusive: ${probe.detail.slice(0, 300)}`)
  return 'warn'
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

const PERMISSION_MARKERS = [
  /permission denied/i,
  /403/,
  /\bdenied\b/i,
  /read[- ]only/i,
  /not authorized/i,
  /authentication failed/i,
  /could not read (username|password)/i,
  /terminal prompts disabled/i,
]

/**
 * Prove the configured credentials cannot write to the real remote.
 *
 * The probe talks to `config.remote` directly, not to the mirror's (deliberately
 * broken) push URL: a failure caused by an invalid URL proves nothing.
 * @param config - repository configuration.
 * @param cwd - an existing repository to run git in (the mirror).
 * @returns the verdict and the original git output.
 */
export async function probePushDenied(config: RepoConfig): Promise<PushProbe> {
  const proxyArgs = proxyConfig(config)
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
    await runGit(['init', '--quiet', '--initial-branch', config.branch, scratch], { env: identity, config: proxyArgs })
    const tree = (await runGit(['mktree'], { cwd: scratch, input: '', env: identity, config: proxyArgs })).stdout.trim()
    const commit = (await runGit(['commit-tree', tree, '-m', 'probe'], { cwd: scratch, env: identity, config: proxyArgs })).stdout.trim()
    await runGit(['update-ref', `refs/heads/${config.branch}`, commit], { cwd: scratch, env: identity, config: proxyArgs })
    const result = await runGit(['push', '--dry-run', config.remote, `HEAD:refs/heads/${config.branch}`], { cwd: scratch, config: proxyArgs })
    return { verdict: 'writable', exitCode: 0, detail: `${result.stdout}${result.stderr}`.trim() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const permission = PERMISSION_MARKERS.some((marker) => marker.test(message))
    return {
      verdict: permission ? 'denied' : 'inconclusive',
      exitCode: null,
      detail: message,
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Read-only mirror over one artifact repository. */
export class RepoMirror {
  readonly config: RepoConfig

  constructor(config: RepoConfig) {
    this.config = config
    this.proxyArgs = proxyConfig(config)
  }

  /** `-c http.proxy=` pairs, captured once from the configuration. */
  private readonly proxyArgs: readonly string[]

  /** Create the bare mirror on first use and neutralize its push URL. */
  async ensure(): Promise<void> {
    await mkdir(this.config.mirrorDir, { recursive: true })
    if (!existsSync(join(this.config.mirrorDir, 'HEAD'))) {
      await runGit(['init', '--bare', '--initial-branch', this.config.branch, this.config.mirrorDir])
      await runGit(['remote', 'add', 'origin', this.config.remote], { cwd: this.config.mirrorDir, config: this.proxyArgs })
      // Defense in depth: even a code path that tried to push through origin
      // would hit an unusable URL. The probe below deliberately bypasses it.
      await runGit(['remote', 'set-url', '--push', 'origin', 'file:///dev/null'], { cwd: this.config.mirrorDir, config: this.proxyArgs })
    }
    // Keep the mirror pointed at the configured remote even if it was created
    // under an earlier configuration.
    await runGit(['remote', 'set-url', 'origin', this.config.remote], { cwd: this.config.mirrorDir, config: this.proxyArgs }).catch(() => {})
    await runGit(['remote', 'set-url', '--push', 'origin', 'file:///dev/null'], { cwd: this.config.mirrorDir, config: this.proxyArgs }).catch(() => {})
  }

  /** Fetch the remote branch and hard-reset the local ref to it. */
  async sync(): Promise<{ head: string; remoteHead: string }> {
    await this.ensure()
    await runGit(['fetch', '--prune', 'origin', `+refs/heads/*:refs/remotes/origin/*`], { cwd: this.config.mirrorDir, config: this.proxyArgs })
    const remoteHead = (await runGit(['rev-parse', `origin/${this.config.branch}`], { cwd: this.config.mirrorDir, config: this.proxyArgs })).stdout.trim()
    await runGit(['update-ref', `refs/heads/${this.config.branch}`, remoteHead], { cwd: this.config.mirrorDir, config: this.proxyArgs })
    const head = (await runGit(['rev-parse', `refs/heads/${this.config.branch}`], { cwd: this.config.mirrorDir, config: this.proxyArgs })).stdout.trim()
    return { head, remoteHead }
  }

  /** Current mirror HEAD. */
  async head(): Promise<string> {
    return (await runGit(['rev-parse', `refs/heads/${this.config.branch}`], { cwd: this.config.mirrorDir, config: this.proxyArgs })).stdout.trim()
  }

  /** List commits, newest first. */
  async log(limit = 20): Promise<{ sha: string; subject: string }[]> {
    const { stdout } = await runGit(['log', `-${String(limit)}`, '--format=%H%x00%s', `refs/heads/${this.config.branch}`], {
      cwd: this.config.mirrorDir,
    })
    return stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha = '', subject = ''] = line.split('\u0000')
        return { sha, subject }
      })
  }

  /** Diff two commits, optionally limited to a path. */
  async diff(from: string, to: string, path?: string): Promise<string> {
    const args = ['diff', from, to]
    if (path !== undefined) args.push('--', path)
    return (await runGit(args, { cwd: this.config.mirrorDir, config: this.proxyArgs })).stdout
  }

  /** Read a file at a commit, byte-exact. */
  async show(commit: string, path: string): Promise<string> {
    return (await runGit(['show', `${commit}:${path}`], { cwd: this.config.mirrorDir })).stdout
  }
}

/** Cordis plugin name. */
export const name = 'lg-repo'

/** Services this plugin reads. */
export const inject = ['tools']

/**
 * Compose the read-only repository tools.
 * @param ctx - plugin context.
 * @param raw - composition config.
 */
export function apply(ctx: Context, raw: RawRepoConfig): void {
  const config = resolveRepoConfig(raw)
  const mirror = new RepoMirror(config)

  type ToolDefinition = Parameters<Context['tools']['register']>[0]
  const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value })

  ctx.effect(() => {
    let disposed = false
    void (async () => {
      try {
        await mirror.ensure()
        const probe = await probePushDenied(config)
        const branch = recordProbeOutcome(lgState, probe)
        if (branch === 'pause') {
          ctx.logger?.('lg-repo')?.error?.(`lg-repo: push probe writable — Global paused: ${probe.detail.slice(0, 200)}`)
        } else if (branch === 'warn') {
          ctx.logger?.('lg-repo')?.warn?.(`lg-repo: push probe inconclusive — ${probe.detail.slice(0, 200)}`)
        }
        if (!disposed) ctx.logger?.('lg-repo')?.info?.(`lg-repo: push probe ${probe.verdict}`)
      } catch (error) {
        ctx.logger?.('lg-repo')?.warn?.(`lg-repo: mirror init failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    return () => {
      disposed = true
    }
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
    async execute() {
      const result = await mirror.sync()
      return { ...result, equal: result.head === result.remoteHead }
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
    async execute(args: { limit?: number }) {
      return (await mirror.log(args.limit ?? 20)).map((entry) => ({ text: `${entry.sha} ${entry.subject}` }))
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
    async execute(args: { from: string; to: string; path?: string }) {
      const diff = await mirror.diff(args.from, args.to, args.path)
      return [{ text: diff }]
    },
  } as ToolDefinition)

  ctx.tools.register({
    name: 'lg_repo_show',
    description: 'Read one file at one commit from the mirror, byte-exact.',
    parameters: {
      type: 'object',
      properties: { commit: { type: 'string' }, path: { type: 'string' } },
      required: ['commit', 'path'],
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, bytes: { type: 'number' } }, required: ['text', 'bytes'] },
      render: (_args: unknown, value: { text: string; bytes: number }) => [text(value.text)],
    },
    async execute(args: { commit: string; path: string }) {
      const text = await mirror.show(args.commit, args.path)
      return { text, bytes: Buffer.byteLength(text, 'utf8') }
    },
  } as ToolDefinition)
}

/** Exposed for the acceptance harness. */
export { RepoMirror as RepoMirrorClass }
