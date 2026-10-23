/**
 * `lg-integrity` — Global's self-check.
 *
 * Every failure pauses the whole Global side through {@link lgState}; the guard
 * in lg-scope then denies every tool except `lg_integrity_check`. Throwing here
 * would only keep this plugin from loading — dsh logs a warning and serves the
 * Web UI anyway — so startup failures pause instead of throwing.
 *
 * One serialized run executes every check (SPEC "lg-integrity"): at startup,
 * before each session's first tool call (the serial `agent/created` listener is
 * awaited by dsh, and the guard refuses a session whose run has not completed),
 * after every `lg_repo_sync`, and on every `lg_integrity_check`.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentations only: ctx.tools, agent/* events, and ctx.agentPresets.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { checkFetchTarget, checkPath, isInside, sessionCwds, type ScopeConfig, type SessionCwds } from './scope.js'
import { GuardState, lgState, type ProbeResult } from './state.js'
import { CANARY_TOOL, DEFAULT_ALLOWED_TOOLS, serviceOf } from './tools.js'

export { DEFAULT_ALLOWED_TOOLS }
export type { ProbeResult }

/** Fully resolved integrity configuration. */
export interface IntegrityConfig {
  /** Preset id the registry must contain and nothing else. */
  readonly expectedPreset: string
  /** Profile names must start with this prefix. */
  readonly profilePrefix: string
  /** Exact tool names a Global session may see. */
  readonly allowedTools: readonly string[]
  /** Session working directory must be inside this workspace. */
  readonly workspace: string
  /** What the self-test tries to read; defaults to the workspace's parent. */
  readonly localWorkdir?: string
  /** Where the effective-configuration hash is recorded. */
  readonly configHashFile: string
  /** The `web_fetch` provider the web service must be pinned to. */
  readonly fetchProvider: string
}

/** Raw plugin config. */
export interface RawIntegrityConfig {
  readonly expectedPreset?: unknown
  readonly profilePrefix?: unknown
  readonly allowedTools?: unknown
  readonly workspace?: unknown
  readonly localWorkdir?: unknown
  readonly configHashFile?: unknown
  readonly fetchProvider?: unknown
}

function defaultHashFile(): string {
  const home = process.env['DSH_HOME']
  return join(home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh'), 'lg', 'global-config.sha256')
}

/**
 * Validate raw config and fill defaults.
 * @param raw - composition config.
 * @returns the resolved configuration.
 * @throws TypeError when the workspace is missing.
 */
export function resolveIntegrityConfig(raw: RawIntegrityConfig): IntegrityConfig {
  if (typeof raw.workspace !== 'string' || raw.workspace.length === 0) {
    throw new TypeError('lg-integrity: "workspace" is required')
  }
  const allowedTools =
    Array.isArray(raw.allowedTools) && raw.allowedTools.length > 0 ? raw.allowedTools.map((value) => String(value)) : [...DEFAULT_ALLOWED_TOOLS]
  if (!allowedTools.includes('lg_integrity_check')) allowedTools.push('lg_integrity_check')
  const localWorkdir = typeof raw.localWorkdir === 'string' && raw.localWorkdir.length > 0 ? resolvePath(raw.localWorkdir) : undefined
  return {
    expectedPreset: raw.expectedPreset === undefined ? 'lg-global' : String(raw.expectedPreset),
    profilePrefix: raw.profilePrefix === undefined ? 'lg-global' : String(raw.profilePrefix),
    workspace: String(raw.workspace),
    allowedTools,
    ...(localWorkdir === undefined ? {} : { localWorkdir }),
    configHashFile: typeof raw.configHashFile === 'string' && raw.configHashFile.length > 0 ? resolvePath(raw.configHashFile) : defaultHashFile(),
    fetchProvider: raw.fetchProvider === undefined ? 'http' : String(raw.fetchProvider),
  }
}

/**
 * Assert the registry holds exactly the expected preset and nothing else.
 *
 * `defaultId` alone is not enough: the UI can call the remote `select` before a
 * session's first turn, and `selectedDefault` is UI-written too.
 * @param presets - every declared preset, including broken ones.
 * @param expected - the only id allowed.
 * @returns one probe result.
 */
export function checkRegistry(presets: readonly { id: string; broken?: string }[], expected: string): ProbeResult {
  const ids = presets.map((preset) => preset.id)
  const broken = presets.filter((preset) => preset.broken !== undefined)
  if (ids.length !== 1 || ids[0] !== expected) {
    return { name: 'preset-registry', pass: false, detail: `registry must hold only ${expected}, got: ${ids.join(', ') || '(none)'}` }
  }
  if (broken.length > 0) {
    return { name: 'preset-registry', pass: false, detail: `broken presets: ${broken.map((p) => `${p.id}: ${String(p.broken)}`).join('; ')}` }
  }
  return { name: 'preset-registry', pass: true, detail: `${expected} only` }
}

/**
 * Check a session's working directory against the workspace.
 * @param cwd - session working directory.
 * @param workspace - the Global workspace.
 * @returns one probe result.
 */
export function checkCwd(cwd: string | undefined, workspace: string): ProbeResult {
  if (cwd === undefined) return { name: 'session-cwd', pass: false, detail: 'session working directory is unknown' }
  const inside = isInside(workspace, cwd)
  return {
    name: 'session-cwd',
    pass: inside,
    detail: `${cwd} ${inside ? 'is inside' : 'is outside'} ${workspace}`,
  }
}

/**
 * Check both working directories of a session: the one dsh tools resolve
 * against now and the one the session was created with.
 * @param cwds - the session's working directories.
 * @param workspace - the Global workspace.
 * @returns one probe result.
 */
export function checkSessionCwds(cwds: SessionCwds, workspace: string): ProbeResult {
  const parts = [checkCwd(cwds.current, workspace), ...(cwds.frozen === undefined || cwds.frozen === cwds.current ? [] : [checkCwd(cwds.frozen, workspace)])]
  const failed = parts.filter((part) => !part.pass)
  return { name: 'session-cwd', pass: failed.length === 0, detail: (failed.length === 0 ? parts : failed).map((part) => part.detail).join('; ') }
}

/**
 * Compare a session's visible tools with the whitelist: exact names only, so a
 * Local-only `lg_*` tool is as much a violation as a shell.
 * @param visible - tool names the session can call.
 * @param allowed - whitelist.
 * @returns one probe result.
 */
export function checkTools(visible: readonly string[], allowed: readonly string[]): ProbeResult {
  const extra = visible.filter((toolName) => !allowed.includes(toolName))
  return {
    name: 'tool-whitelist',
    pass: extra.length === 0,
    detail: extra.length === 0 ? `${String(visible.length)} tools, all allowed` : `not allowed: ${extra.join(', ')}`,
  }
}

/** JSON with sorted keys, so equal configurations always hash alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** SHA-256 of the canonical form of the effective (secret-free) configuration. */
export function configHash(effective: unknown): string {
  return createHash('sha256').update(canonicalJson(effective)).digest('hex')
}

/**
 * Compare the effective configuration hash with the recorded one (spec item 5).
 *
 * The first run has nothing to compare with and records its own hash (reported
 * as a warning by the caller). After that a change pauses until a Human, who
 * alone can write the file, records the new hash.
 * @param file - where the hash is recorded.
 * @param hash - the hash of the configuration in effect now.
 * @returns the probe result and whether a first baseline was just recorded.
 */
export async function checkConfigHash(file: string, hash: string): Promise<ProbeResult & { recorded: boolean }> {
  let recorded: string | undefined
  try {
    recorded = (await readFile(file, 'utf8')).trim()
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      return { name: 'config-hash', pass: false, recorded: false, detail: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  if (recorded === undefined) {
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${hash}\n`, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      return { name: 'config-hash', pass: false, recorded: false, detail: `cannot record the baseline in ${file}: ${error instanceof Error ? error.message : String(error)}` }
    }
    return { name: 'config-hash', pass: true, recorded: true, detail: `no baseline existed; recorded ${hash.slice(0, 12)}` }
  }
  if (recorded === hash) return { name: 'config-hash', pass: true, recorded: false, detail: `matches the recorded ${hash.slice(0, 12)}` }
  return {
    name: 'config-hash',
    pass: false,
    recorded: false,
    detail: `effective configuration changed: recorded ${recorded.slice(0, 12)}, now ${hash}; after review a Human writes the new hash into ${file}`,
  }
}

/**
 * Check the role file lg-scope protects: it must exist, be non-empty, and be
 * the file lg-role reads (when lg-role has mounted and reported its path).
 * @param scope - the effective scope configuration.
 * @param reported - the path lg-role reads, once it has mounted.
 * @returns one probe result.
 */
export function checkRoleFile(scope: Pick<ScopeConfig, 'roleFile'> | undefined, reported: string | undefined): ProbeResult {
  if (scope === undefined) return { name: 'role-file', pass: false, detail: 'lg-scope has no valid configuration, so the role file is unknown' }
  if (reported !== undefined && resolvePath(reported) !== scope.roleFile) {
    return { name: 'role-file', pass: false, detail: `lg-role reads ${reported} but lg-scope protects ${scope.roleFile}` }
  }
  try {
    const text = readFileSync(scope.roleFile, 'utf8')
    if (text.trim().length === 0) return { name: 'role-file', pass: false, detail: `${scope.roleFile} is empty` }
    return { name: 'role-file', pass: true, detail: `${scope.roleFile} (${String(text.length)} bytes)` }
  } catch (error) {
    return { name: 'role-file', pass: false, detail: `cannot read ${scope.roleFile}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Minimal shape of the tool registry result the self-test inspects. */
interface ToolOutcome {
  readonly isError?: boolean
  readonly error?: { readonly message?: string }
}

/**
 * Self-test (spec item 7): judge "read localWorkdir" and "fetch
 * http://127.0.0.1/" by lg-scope's own rules — both must be refused — and prove
 * the guard is registered by sending a canary call through the real tool
 * pipeline.
 * @param ctx - plugin context.
 * @param scope - the effective scope configuration.
 * @param config - integrity configuration.
 * @returns one probe result.
 */
export async function selfTest(ctx: Context, scope: ScopeConfig | undefined, config: IntegrityConfig): Promise<ProbeResult> {
  const name = 'scope-selftest'
  if (scope === undefined) return { name, pass: false, detail: 'lg-scope has no valid configuration' }
  const local = config.localWorkdir ?? dirname(scope.workspace)
  if (checkPath(scope, 'read', local, scope.workspace) === undefined) return { name, pass: false, detail: `lg-scope's rules would allow reading ${local}` }
  if ((await checkFetchTarget(scope, 'http://127.0.0.1/')) === undefined) return { name, pass: false, detail: "lg-scope's rules would allow fetching http://127.0.0.1/" }
  const mine = [...config.allowedTools].sort().join(',')
  if ([...scope.allowedTools].sort().join(',') !== mine) return { name, pass: false, detail: 'lg-scope and lg-integrity disagree about the allowed tools' }
  const tools = ctx.tools as unknown as { execute?: (input: { callId: string; name: string; arguments: unknown; signal: AbortSignal }) => Promise<ToolOutcome> }
  if (tools.execute === undefined) return { name, pass: false, detail: 'the tool registry cannot execute a canary call' }
  try {
    const outcome = await tools.execute({ callId: 'lg-selftest-canary', name: CANARY_TOOL, arguments: {}, signal: AbortSignal.timeout(10_000) })
    if (outcome.isError === true && (outcome.error?.message ?? '').startsWith('lg-scope: canary call refused')) {
      return { name, pass: true, detail: 'read of the local directory and fetch of 127.0.0.1 refused; guard refused a canary call' }
    }
    return { name, pass: false, detail: `the scope guard did not refuse a canary call: ${outcome.error?.message ?? 'executed'}` }
  } catch (error) {
    return { name, pass: false, detail: `canary call failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * `web_fetch` must run through the provider that pins DNS and blocks
 * cross-origin redirects, so the web service has to be pinned to it (the
 * default selection depends on which providers happen to be registered).
 * @param ctx - plugin context.
 * @param expected - the provider id to pin to.
 * @param composesWeb - whether the preset exposes web tools; when it does, a missing service or pin fails closed.
 * @returns one probe result.
 */
export function checkFetchProvider(ctx: unknown, expected: string, composesWeb = true): ProbeResult {
  const name = 'web-fetch-provider'
  const web = serviceOf<{ config?: { fetchProvider?: { get?: () => string | undefined } }; fetchProviderEnv?: string }>(ctx, 'web')
  if (web === undefined) {
    return composesWeb
      ? { name, pass: false, detail: 'the preset composes web tools but no web service is available to read the web_fetch provider pin' }
      : { name, pass: true, detail: 'no web service is composed; web_fetch is unavailable' }
  }
  // dsh-web `lib/index.js:115`: the selected id is `config.fetchProvider.get() ?? $DSH_WEB_FETCH_PROVIDER`.
  const read = web.config?.fetchProvider?.get
  if (typeof read !== 'function') {
    return composesWeb
      ? { name, pass: false, detail: 'the preset composes web tools but the web service does not expose its fetchProvider pin' }
      : { name, pass: true, detail: 'the web service does not expose its provider pin; web tools are not composed' }
  }
  let configured: string | undefined
  try {
    configured = read.call(web.config?.fetchProvider)
  } catch {
    configured = undefined
  }
  configured ??= web.fetchProviderEnv ?? process.env['DSH_WEB_FETCH_PROVIDER']
  return configured === expected
    ? { name, pass: true, detail: `web_fetch is pinned to ${expected}` }
    : { name, pass: false, detail: `web fetchProvider must be pinned to ${expected}, got ${configured ?? '(unset)'}` }
}

/**
 * Compare the channel archive with this side's saved copies (SPEC "lg-integrity"
 * item 6, CH-12, IN-3).
 *
 * Read through the `lgChannel` service rather than importing the channel
 * package, so the two bundles stay independent. When no channel is composed the
 * check cannot run: that is reported as a warning, not a pause, because a
 * Global profile without a channel has nothing to compare.
 * @param ctx - plugin context.
 * @param state - the shared guard state.
 * @returns one probe result.
 */
async function checkSentCopies(ctx: Context, state: GuardState): Promise<ProbeResult> {
  const channel = serviceOf<{ verifySentCopies?: () => Promise<{ filename: string; reason: string }[]> }>(ctx, 'lgChannel')
  if (channel?.verifySentCopies === undefined) {
    state.warn('sent-copies', 'lg-channel is not composed in this profile; CH-12 comparison did not run')
    return { name: 'sent-copies', pass: true, detail: 'not applicable: no channel composed' }
  }
  try {
    const mismatches = await channel.verifySentCopies()
    if (mismatches.length === 0) {
      state.clearWarning('sent-copies')
      return { name: 'sent-copies', pass: true, detail: 'archive matches every saved copy' }
    }
    return {
      name: 'sent-copies',
      pass: false,
      detail: mismatches.map((entry) => `${entry.filename}: ${entry.reason}`).join('; '),
    }
  } catch (error) {
    return { name: 'sent-copies', pass: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Send the startup check result as an ISOLATION_REPORT (IN-2).
 *
 * Uses the `lgChannel` service so the two bundles stay independent. When no
 * channel is composed the report has nowhere to go; that is logged, not fatal.
 * @param ctx - plugin context.
 * @param probes - the checks that just ran.
 */
async function reportStartupIsolation(ctx: Context, probes: readonly ProbeResult[]): Promise<void> {
  const channel = serviceOf<{ reportIsolation?: (probes: readonly unknown[], body?: string) => Promise<unknown> }>(ctx, 'lgChannel')
  if (channel?.reportIsolation === undefined) return
  try {
    const posted = await channel.reportIsolation(
      probes.map((entry) => ({ name: entry.name, expected: 'pass', actual: entry.detail, pass: entry.pass })),
      `启动自检：${String(probes.filter((entry) => entry.pass).length)}/${String(probes.length)} 项通过。`,
    )
    ctx.logger?.('lg-integrity')?.info?.(`lg-integrity: startup ISOLATION_REPORT ${posted === undefined ? 'skipped' : 'sent'}`)
  } catch (error) {
    ctx.logger?.('lg-integrity')?.warn?.(`lg-integrity: startup ISOLATION_REPORT failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function profileName(ctx: Context): string | undefined {
  const service = serviceOf<{ name?: string }>(ctx, 'profileContext')
  return typeof service?.name === 'string' ? service.name : undefined
}

/** Cordis plugin name. */
export const name = 'lg-integrity'

/** Services this plugin reads. */
export const inject = ['tools', 'agentPresets']

/** What one run found. */
export interface IntegrityReport {
  /** Every check, including the ones remembered from earlier runs. */
  readonly probes: ProbeResult[]
  /** All checks pass. */
  readonly clean: boolean
  /** `name: detail` for each failing check. */
  readonly failures: string[]
}

/** Options for one run. */
export interface RunOptions {
  /** The session being checked: its working directories are probed, and it is marked ready when the run is clean. */
  readonly agent?: unknown
  /** Re-run the push probe against the remote (otherwise the last verdict is reused). */
  readonly pushProbe?: boolean
}

type RepoService = { ready: Promise<void>; recheck(options: { pushProbe: boolean }): Promise<ProbeResult[]> }

/** The serialized runner behind startup, session creation, sync, and `lg_integrity_check`. */
export class IntegrityRuntime {
  private readonly results = new Map<string, ProbeResult>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly raw: RawIntegrityConfig,
    private readonly state: GuardState = lgState,
  ) {}

  private remember(result: ProbeResult): void {
    this.results.set(result.name, result)
    if (result.pass) {
      this.state.resume(result.name)
      return
    }
    this.state.pause(result.name, result.detail)
    this.ctx.logger?.('lg-integrity')?.error?.(`lg-integrity: ${result.name} failed — ${result.detail}`)
  }

  private resolveConfig(): { config: IntegrityConfig } | { error: string } {
    try {
      return { config: resolveIntegrityConfig({ workspace: serviceOf<string>(this.ctx, 'lgWorkspace'), ...this.raw }) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Run every check once, serialized with every other run.
   * @param options - the session to check and whether to re-probe the remote.
   * @returns the full report; failures have already paused Global.
   */
  run(options: RunOptions = {}): Promise<IntegrityReport> {
    const next = this.queue.then(
      () => this.runOnce(options),
      () => this.runOnce(options),
    )
    this.queue = next.catch(() => undefined)
    return next
  }

  private async runOnce(options: RunOptions): Promise<IntegrityReport> {
    try {
      await this.checkAll(options)
    } catch (error) {
      this.remember({ name: 'integrity-error', pass: false, detail: error instanceof Error ? error.message : String(error) })
    }
    const probes = [...this.results.values()]
    const failures = probes.filter((entry) => !entry.pass).map((entry) => `${entry.name}: ${entry.detail}`)
    const clean = probes.length > 0 && failures.length === 0
    if (clean) {
      this.state.resume('integrity-error')
      // A clean run is exactly what lifts `not-verified`.
      this.state.markVerified()
      if (options.agent !== undefined) this.state.markAgentReady(options.agent)
    }
    return { probes, clean, failures }
  }

  private async checkAll(options: RunOptions): Promise<void> {
    const ctx = this.ctx
    const resolved = this.resolveConfig()
    if ('error' in resolved) {
      this.remember({ name: 'integrity-config', pass: false, detail: resolved.error })
      return
    }
    const { config } = resolved
    this.remember({ name: 'integrity-config', pass: true, detail: 'configuration valid' })
    this.state.setComponent('integrity', {
      expectedPreset: config.expectedPreset,
      profilePrefix: config.profilePrefix,
      allowedTools: [...config.allowedTools].sort(),
      workspace: config.workspace,
      localWorkdir: config.localWorkdir ?? null,
      fetchProvider: config.fetchProvider,
    })

    const profile = profileName(ctx)
    this.remember({ name: 'profile-name', pass: profile !== undefined && profile.startsWith(config.profilePrefix), detail: profile ?? 'profileContext unavailable' })

    try {
      const presets = await ctx.agentPresets.list()
      this.remember(checkRegistry(presets, config.expectedPreset))
      const compositions = ctx.agentPresets.inspectCompositions()
      const matching = compositions.filter((entry) => (entry as { id?: string }).id === config.expectedPreset)
      this.remember({
        name: 'preset-composition',
        pass: matching.length > 0,
        detail: `${String(compositions.length)} activated, ${String(matching.length)} named ${config.expectedPreset}`,
      })
    } catch (error) {
      this.remember({ name: 'preset-registry', pass: false, detail: error instanceof Error ? error.message : String(error) })
    }

    // Unknown until the preset scope is read: assume web tools are composed.
    let composesWeb = true
    // The preset scope, not the process-level registry: that is what a session sees.
    try {
      const lease = await ctx.agentPresets.acquireScope(config.expectedPreset)
      try {
        const schemas = ctx.tools.schemas(lease.key as never)
        const visible = schemas.map((schema) => schema.name)
        composesWeb = visible.some((toolName) => toolName.startsWith('web_'))
        this.remember(checkTools(visible, config.allowedTools))
      } finally {
        await (lease as unknown as { [Symbol.asyncDispose]?: () => Promise<void> })[Symbol.asyncDispose]?.()
      }
    } catch (error) {
      this.remember({ name: 'tool-whitelist', pass: false, detail: error instanceof Error ? error.message : String(error) })
    }

    if (options.agent !== undefined) this.remember(checkSessionCwds(sessionCwds(ctx, options.agent), config.workspace))

    const scope = this.state.component<ScopeConfig>('scope')
    const reported = this.state.component<{ roleFile?: string }>('role')?.roleFile
    this.remember(checkRoleFile(scope, reported))

    const repo = serviceOf<RepoService>(ctx, 'lgRepo')
    if (repo === undefined) {
      this.state.warn('lg-repo', 'lg-repo is not composed in this profile; repository checks did not run')
    } else {
      this.state.clearWarning('lg-repo')
      await repo.ready
      for (const result of await repo.recheck({ pushProbe: options.pushProbe === true })) this.remember(result)
    }

    const hashed = configHash(Object.fromEntries(['scope', 'repo', 'integrity'].map((key) => [key, this.state.component(key) ?? null])))
    const recorded = await checkConfigHash(config.configHashFile, hashed)
    if (recorded.recorded) this.state.warn('config-hash', recorded.detail)
    else if (recorded.pass) this.state.clearWarning('config-hash')
    this.remember({ name: recorded.name, pass: recorded.pass, detail: recorded.detail })

    this.remember(await checkSentCopies(ctx, this.state))
    this.remember(await selfTest(ctx, scope, config))
    this.remember(checkFetchProvider(ctx, config.fetchProvider, composesWeb))
  }

  /** Startup run: the registry publishes asynchronously, so the caller delays it. */
  async startup(): Promise<void> {
    const report = await this.run({})
    await reportStartupIsolation(this.ctx, report.probes)
  }

  /** The agent/created barrier: dsh awaits this before releasing the session's first turn. */
  async onAgentCreated(agent: unknown): Promise<void> {
    await this.run({ agent })
  }
}

/**
 * Compose the integrity checks.
 * @param ctx - plugin context.
 * @param raw - composition config.
 */
export function apply(ctx: Context, raw: RawIntegrityConfig): void {
  const runtime = new IntegrityRuntime(ctx, raw)

  ctx.effect(() => {
    const release = (ctx as unknown as { provide?: (name: string, value: unknown) => () => void }).provide?.('lgIntegrity', runtime)
    // The preset registry publishes its definitions asynchronously; checking in
    // the same tick would see an empty registry and pause for no reason.
    const timer = setTimeout(() => {
      void runtime.startup()
    }, 2000)
    return () => {
      clearTimeout(timer)
      release?.()
    }
  })

  ctx.on('agent/created', async (payload: { agent?: unknown }) => {
    await runtime.onAgentCreated(payload.agent)
    return undefined
  })

  ctx.tools.register({
    name: 'lg_integrity_check',
    description: 'Re-run every integrity check and report whether Global is paused.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          paused: { type: 'boolean' },
          pass: { type: 'boolean' },
          reasons: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, detail: { type: 'string' } },
              required: ['name', 'detail'],
            },
          },
          warnings: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, detail: { type: 'string' } },
              required: ['name', 'detail'],
            },
          },
          probes: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } },
              required: ['name', 'pass', 'detail'],
            },
          },
        },
        required: ['paused', 'pass', 'reasons', 'warnings', 'probes'],
      },
      render: (
        _args: unknown,
        value: { paused: boolean; pass: boolean; reasons: { name: string; detail: string }[]; warnings: { name: string; detail: string }[]; probes: ProbeResult[] },
      ) => [
        {
          type: 'text' as const,
          text: [
            value.paused ? `PAUSED${value.reasons.length > 0 ? `: ${value.reasons.map((r) => r.name).join(', ')}` : ''}` : value.pass ? 'PASS' : 'FAIL',
            ...value.probes.map((p) => `${p.pass ? 'ok' : 'FAIL'} ${p.name}: ${p.detail}`),
            ...value.warnings.map((w) => `warn ${w.name}: ${w.detail}`),
          ].join('\n'),
        },
      ],
    },
    async execute(_args: unknown, exec?: { agent?: unknown }) {
      const report = await runtime.run({ agent: exec?.agent, pushProbe: true })
      const warnings = lgState.listWarnings().map((warning) => ({ name: warning.code, detail: warning.detail }))
      const reasons = lgState.list().map((reason) => ({ name: reason.code, detail: reason.detail }))
      return { paused: lgState.paused, pass: report.clean, reasons, warnings, probes: report.probes }
    },
  } as unknown as Parameters<Context['tools']['register']>[0])
}
