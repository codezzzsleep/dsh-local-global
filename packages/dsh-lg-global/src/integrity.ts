/**
 * `lg-integrity` — Global's self-check.
 *
 * Every failure pauses the whole Global side through {@link lgState}; the guard
 * in lg-scope then denies every tool except `lg_integrity_check`. Throwing here
 * would only keep this plugin from loading — dsh logs a warning and serves the
 * Web UI anyway — so startup failures pause instead of throwing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentations only: ctx.tools, agent/* events, and ctx.agentPresets.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { isInside, sessionCwd } from './scope.js'
import { lgState } from './state.js'

/** Fully resolved integrity configuration. */
export interface IntegrityConfig {
  /** Preset id the registry must contain and nothing else. */
  readonly expectedPreset: string
  /** Profile names must start with this prefix. */
  readonly profilePrefix: string
  /** Tool names a Global session may see. */
  readonly allowedTools: readonly string[]
  /** Session working directory must equal this workspace. */
  readonly workspace: string
}

/** Raw plugin config. */
export interface RawIntegrityConfig {
  readonly expectedPreset?: unknown
  readonly profilePrefix?: unknown
  readonly allowedTools?: unknown
  readonly workspace?: unknown
}

/**
 * Default tool whitelist: the filesystem and web tools a Global session may
 * hold, plus every tool this project provides (SPEC "Global 沙箱": the session
 * whitelist is those nine names "以及本项目提供的 lg_* 工具"). The `lg_` prefix
 * rule is applied in {@link checkTools}, so a new project tool does not have to
 * be listed here to be legal.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  'read',
  'read_image',
  'write',
  'edit',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'working_directory',
  'lg_repo_sync',
  'lg_repo_log',
  'lg_repo_diff',
  'lg_repo_show',
  'lg_integrity_check',
] as const

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
  return {
    expectedPreset: raw.expectedPreset === undefined ? 'lg-global' : String(raw.expectedPreset),
    profilePrefix: raw.profilePrefix === undefined ? 'lg-global' : String(raw.profilePrefix),
    workspace: String(raw.workspace),
    allowedTools:
      Array.isArray(raw.allowedTools) && raw.allowedTools.length > 0
        ? raw.allowedTools.map((value) => String(value))
        : [...DEFAULT_ALLOWED_TOOLS],
  }
}

/** One probe outcome. */
export interface ProbeResult {
  readonly name: string
  readonly pass: boolean
  readonly detail: string
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
 * Compare a session's visible tools with the whitelist.
 * @param visible - tool names the session can call.
 * @param allowed - whitelist.
 * @returns one probe result.
 */
export function checkTools(visible: readonly string[], allowed: readonly string[]): ProbeResult {
  // SPEC "Global 沙箱" allows the listed nine names plus any `lg_` tool this
  // project ships; anything else visible in the preset scope is a violation.
  const extra = visible.filter((toolName) => !allowed.includes(toolName) && !toolName.startsWith('lg_'))
  return {
    name: 'tool-whitelist',
    pass: extra.length === 0,
    detail: extra.length === 0 ? `${String(visible.length)} tools, all allowed` : `not allowed: ${extra.join(', ')}`,
  }
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
 * @returns one probe result.
 */
async function checkSentCopies(ctx: Context): Promise<ProbeResult> {
  const channel = (ctx as unknown as { get?: (name: string) => unknown }).get?.('lgChannel') as
    | { verifySentCopies?: () => Promise<{ filename: string; reason: string }[]> }
    | undefined
  if (channel?.verifySentCopies === undefined) {
    lgState.warn('sent-copies', 'lg-channel is not composed in this profile; CH-12 comparison did not run')
    lgState.resume('sent-copies')
    return { name: 'sent-copies', pass: true, detail: 'not applicable: no channel composed' }
  }
  try {
    const mismatches = await channel.verifySentCopies()
    if (mismatches.length === 0) {
      lgState.resume('sent-copies')
      lgState.clearWarning('sent-copies')
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
 * Re-check that the role file lg-role resolved is readable.
 *
 * SPEC "lg-role" pauses when the file cannot be read, and RL-2 wants that pause
 * visible. Re-checking it here keeps the pause honest in both directions: a file
 * that appears later lifts it, a file that disappears after mount raises it.
 * @param ctx - plugin context.
 * @returns one probe result.
 */
function checkRoleFile(ctx: Context): ProbeResult {
  // lg-role cannot publish a service (it lives inside the preset, and preset
  // services must use isolate realms), so the path is derived the same way
  // lg-role derives it: the role file name under the workspace.
  const provided = (ctx as unknown as { get?: (name: string) => unknown }).get?.('lgRoleFile')
  const file = typeof provided === 'string' && provided.length > 0 ? provided : join(roleWorkspace(ctx) ?? '', 'LG-ROLE.md')
  try {
    const text = readFileSync(file, 'utf8')
    if (text.trim().length === 0) return { name: 'role-file', pass: false, detail: `${file} is empty` }
    return { name: 'role-file', pass: true, detail: `${file} (${String(text.length)} bytes)` }
  } catch (error) {
    return { name: 'role-file', pass: false, detail: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` }
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
  const channel = (ctx as unknown as { get?: (name: string) => unknown }).get?.('lgChannel') as
    | { reportIsolation?: (probes: readonly unknown[], body?: string) => Promise<unknown> }
    | undefined
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

/** The workspace lg-scope published, when it is available. */
function roleWorkspace(ctx: Context): string | undefined {
  const workspace = (ctx as unknown as { get?: (name: string) => unknown }).get?.('lgWorkspace')
  return typeof workspace === 'string' && workspace.length > 0 ? workspace : undefined
}

function profileName(ctx: Context): string | undefined {
  try {
    const service = ctx.get?.('profileContext') as { name?: string } | undefined
    return typeof service?.name === 'string' ? service.name : undefined
  } catch {
    return undefined
  }
}

/** Cordis plugin name. */
export const name = 'lg-integrity'

/** Services this plugin reads. */
export const inject = ['tools', 'agentPresets']

/**
 * Compose the integrity checks.
 * @param ctx - plugin context.
 * @param raw - composition config.
 */
export function apply(ctx: Context, raw: RawIntegrityConfig): void {
  const config = resolveIntegrityConfig(raw)
  const results = new Map<string, ProbeResult>()

  const remember = (result: ProbeResult): void => {
    results.set(result.name, result)
    if (result.pass) {
      lgState.resume(result.name)
      return
    }
    lgState.pause(result.name, result.detail)
    ctx.logger?.('lg-integrity')?.error?.(`lg-integrity: ${result.name} failed — ${result.detail}`)
  }

  const checkRegistryAndComposition = async (): Promise<void> => {
    const profile = profileName(ctx)
    remember({ name: 'profile-name', pass: profile !== undefined && profile.startsWith(config.profilePrefix), detail: profile ?? 'profileContext unavailable' })
    try {
      const presets = await ctx.agentPresets.list()
      remember(checkRegistry(presets, config.expectedPreset))
      const compositions = ctx.agentPresets.inspectCompositions()
      const matching = compositions.filter((entry) => (entry as { id?: string }).id === config.expectedPreset)
      remember({
        name: 'preset-composition',
        pass: matching.length > 0,
        detail: `${String(compositions.length)} activated, ${String(matching.length)} named ${config.expectedPreset}`,
      })
    } catch (error) {
      remember({ name: 'preset-registry', pass: false, detail: error instanceof Error ? error.message : String(error) })
    }
    remember(await checkSentCopies(ctx))
    remember(checkRoleFile(ctx))
  }

  const checkAgent = (agent: unknown): void => {
    remember(checkCwd(sessionCwd(agent), config.workspace))
    void (async () => {
      try {
        const lease = await ctx.agentPresets.acquireScope(config.expectedPreset)
        try {
          const schemas = ctx.tools.schemas(lease.key as never)
          remember(checkTools(schemas.map((schema) => schema.name), config.allowedTools))
        } finally {
          await (lease as unknown as { [Symbol.asyncDispose]?: () => Promise<void> })[Symbol.asyncDispose]?.()
        }
      } catch (error) {
        remember({ name: 'tool-whitelist', pass: false, detail: error instanceof Error ? error.message : String(error) })
      }
    })()
  }

  ctx.effect(() => {
    // The preset registry publishes its definitions asynchronously; checking in
    // the same tick would see an empty registry and pause for no reason.
    const timer = setTimeout(() => {
      void checkRegistryAndComposition().then(async () => {
        const probes = [...results.values()]
        // A clean run is exactly what lifts `not-verified`; testing `paused`
        // here made the un-pause unreachable (the pause could only end after it
        // had already ended).
        if (probes.length > 0 && probes.every((entry) => entry.pass)) lgState.markVerified()
        // SPEC "lg-integrity": send the startup result as an ISOLATION_REPORT
        // through the channel's own interface, not through the model (IN-2).
        await reportStartupIsolation(ctx, probes)
      })
    }, 2000)
    return () => clearTimeout(timer)
  })

  ctx.on('agent/created', (payload: { agent?: unknown }) => {
    checkAgent(payload.agent)
    return undefined
  })

  ctx.tools.register({
    name: 'lg_integrity_check',
    description: 'Report the integrity probes and whether Global is paused.',
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
    async execute() {
      await checkRegistryAndComposition()
      const probes = [...results.values()]
      const clean = probes.length > 0 && probes.every((entry) => entry.pass)
      if (clean) lgState.markVerified()
      const warnings = lgState.listWarnings().map((warning) => ({ name: warning.code, detail: warning.detail }))
      const reasons = lgState.list().map((reason) => ({ name: reason.code, detail: reason.detail }))
      return { paused: lgState.paused, pass: clean, reasons, warnings, probes }
    },
  } as unknown as Parameters<Context['tools']['register']>[0])
}
