/**
 * `lg-integrity` — Global's self-check.
 *
 * Every failure pauses the whole Global side through {@link lgState}; the guard
 * in lg-scope then denies every tool except `lg_integrity_check`. Throwing here
 * would only keep this plugin from loading — dsh logs a warning and serves the
 * Web UI anyway — so startup failures pause instead of throwing.
 */
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

/** Default tool whitelist (docs/implementation.md, lg-integrity step 1). */
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
  const extra = visible.filter((toolName) => !allowed.includes(toolName))
  return {
    name: 'tool-whitelist',
    pass: extra.length === 0,
    detail: extra.length === 0 ? `${String(visible.length)} tools, all allowed` : `not allowed: ${extra.join(', ')}`,
  }
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
      void checkRegistryAndComposition().then(() => {
        const probes = [...results.values()]
        if (probes.length > 0 && probes.every((entry) => entry.pass) && !lgState.paused) lgState.markVerified()
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
          probes: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } },
              required: ['name', 'pass', 'detail'],
            },
          },
        },
        required: ['paused', 'pass', 'probes'],
      },
      render: (_args: unknown, value: { paused: boolean; pass: boolean; probes: ProbeResult[] }) => [
        {
          type: 'text' as const,
          text: `${value.paused ? 'PAUSED' : value.pass ? 'PASS' : 'FAIL'}\n${value.probes.map((p) => `${p.pass ? 'ok' : 'FAIL'} ${p.name}: ${p.detail}`).join('\n')}`,
        },
      ],
    },
    async execute() {
      await checkRegistryAndComposition()
      const probes = [...results.values()]
      const clean = probes.length > 0 && probes.every((entry) => entry.pass) && !lgState.paused
      if (clean) lgState.markVerified()
      return { paused: lgState.paused, pass: clean, probes }
    },
  } as unknown as Parameters<Context['tools']['register']>[0])
}
