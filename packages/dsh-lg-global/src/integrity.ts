/**
 * `lg-integrity` — Global's self-check.
 *
 * The preset alone cannot guarantee isolation: a user patch layer sits above
 * the bundle and can point the default preset back at `standard`. This plugin
 * asserts the *effective* composition and refuses to work when it is wrong.
 */
import type { Context } from '@deepseek-ai/cordis'
// Module augmentations only: ctx.tools, agent/* events, and ctx.agentPresets.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** Fully resolved integrity configuration. */
export interface IntegrityConfig {
  /** Preset id the session must resolve to. */
  readonly expectedPreset: string
  /** Profile names must start with this prefix; otherwise lg-global is misplaced. */
  readonly profilePrefix: string
  /** Tool names a Global session may see. */
  readonly allowedTools: readonly string[]
}

/** Raw plugin config. */
export interface RawIntegrityConfig {
  readonly expectedPreset?: unknown
  readonly profilePrefix?: unknown
  readonly allowedTools?: unknown
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
 */
export function resolveIntegrityConfig(raw: RawIntegrityConfig): IntegrityConfig {
  return {
    expectedPreset: raw.expectedPreset === undefined ? 'lg-global' : String(raw.expectedPreset),
    profilePrefix: raw.profilePrefix === undefined ? 'lg-global' : String(raw.profilePrefix),
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
 * Check that the effective preset is the expected one.
 *
 * Reads `defaultId` on purpose: `selectedDefault` is a user-level override that
 * wins over the deployment `default`, so comparing the config field alone would
 * miss the bypass.
 * @param registry - the live preset registry.
 * @param expected - preset id the session must resolve to.
 * @returns one probe result.
 */
export function checkPreset(registry: { defaultId: string; list?: () => Promise<{ id: string; broken?: string }[]> }, expected: string): ProbeResult {
  const actual = registry.defaultId
  return {
    name: 'preset-default',
    pass: actual === expected,
    detail: `defaultId=${actual} expected=${expected}`,
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

  const profile = profileName(ctx)
  if (profile !== undefined && !profile.startsWith(config.profilePrefix)) {
    throw new Error(
      `lg-integrity: this profile is named "${profile}", but lg-global may only run in a profile starting with "${config.profilePrefix}"`,
    )
  }

  const preset = checkPreset(ctx.agentPresets as unknown as { defaultId: string }, config.expectedPreset)
  if (!preset.pass) {
    throw new Error(`lg-integrity: refusing to work — ${preset.detail}`)
  }

  const results: ProbeResult[] = [preset]
  if (profile === undefined) {
    results.push({ name: 'profile-name', pass: false, detail: 'profileContext service unavailable; cannot prove the profile name' })
  } else {
    results.push({ name: 'profile-name', pass: true, detail: profile })
  }

  const remember = (result: ProbeResult): void => {
    const index = results.findIndex((entry) => entry.name === result.name)
    if (index === -1) results.push(result)
    else results[index] = result
    if (!result.pass) ctx.logger?.('lg-integrity')?.error?.(`lg-integrity: ${result.name} failed — ${result.detail}`)
  }

  ctx.on('agent/created', (payload: { agent?: { ctx?: unknown } }) => {
    try {
      const agentCtx = payload.agent?.ctx
      const schemas = agentCtx === undefined ? [] : ctx.tools.schemas(agentCtx as never)
      remember(checkTools(schemas.map((schema) => schema.name), config.allowedTools))
    } catch (error) {
      remember({ name: 'tool-whitelist', pass: false, detail: error instanceof Error ? error.message : String(error) })
    }
    return undefined
  })

  ctx.tools.register({
    name: 'lg_integrity_check',
    description: 'Report the integrity probes: preset default, profile name, and per-session tool whitelist.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          pass: { type: 'boolean' },
          probes: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } }, required: ['name', 'pass', 'detail'] } },
        },
        required: ['pass', 'probes'],
      },
      render: (_args: unknown, value: { pass: boolean; probes: ProbeResult[] }) => [
        { type: 'text' as const, text: `${value.pass ? 'PASS' : 'FAIL'}\n${value.probes.map((p) => `${p.pass ? 'ok' : 'FAIL'} ${p.name}: ${p.detail}`).join('\n')}` },
      ],
    },
    async execute() {
      return { pass: results.every((entry) => entry.pass), probes: results }
    },
  } as unknown as Parameters<Context['tools']['register']>[0])
}
