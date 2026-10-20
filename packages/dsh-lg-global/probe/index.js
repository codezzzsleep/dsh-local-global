import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const name = 'lg-m2-probe'
export const inject = ['tools', 'agentPresets']

const OUT = process.env.LG_M2_PROBE_OUT ?? '/tmp/m2/probe.json'
const results = {}

function record(key, value) {
  results[key] = value
}

function safe(fn, fallback = null) {
  try {
    return fn()
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) }
  }
}

async function safeAsync(fn) {
  try {
    return await fn()
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) }
  }
}

function describe(value) {
  if (value === undefined) return { kind: 'undefined' }
  if (value === null) return { kind: 'null' }
  if (Array.isArray(value)) return { kind: 'array', length: value.length }
  if (typeof value === 'object') return { kind: 'object', keys: Object.keys(value) }
  return { kind: typeof value, value }
}

export function apply(ctx) {
  mkdirSync('/tmp/m2', { recursive: true })

  // 1. agent-preset-registry surface
  record('presetRegistry', {
    service: describe(ctx.agentPresets),
    methods: safe(() => {
      const names = new Set()
      let proto = Object.getPrototypeOf(ctx.agentPresets)
      while (proto && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) names.add(key)
        proto = Object.getPrototypeOf(proto)
      }
      return [...names].filter((n) => !n.startsWith('#') && n !== 'constructor').sort()
    }),
    defaultId: safe(() => ctx.agentPresets.defaultId),
    config: safe(() => ({ default: ctx.agentPresets.config?.default, selectedDefault: ctx.agentPresets.config?.selectedDefault })),
  })

  // 2. tools.guard + 3. tools/pre-execute ordered behaviour
  const events = []
  ctx.on('tools/pre-execute', async (exec, next) => {
    events.push(`pre-execute:${exec.name}`)
    return await next()
  })
  ctx.tools.guard((exec) => {
    events.push(`guard:${exec.name}`)
    return exec.name === 'probe_deny' ? 'probe guard denies this tool' : undefined
  })

  const okTool = {
    name: 'probe_ok',
    description: 'Probe tool that always succeeds.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      events.push('execute:probe_ok')
      return 'ok'
    },
  }
  const denyTool = {
    name: 'probe_deny',
    description: 'Probe tool the guard refuses.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      events.push('execute:probe_deny')
      return 'should not run'
    },
  }
  ctx.tools.register(okTool)
  ctx.tools.register(denyTool)

  ctx.effect(() => {
    void (async () => {
      await new Promise((r) => setTimeout(r, 2500))
      record('presetRoster', await safeAsync(async () => await ctx.agentPresets.roster?.()))
      record('presetList', await safeAsync(async () => {
        const list = await ctx.agentPresets.list?.()
        return Array.isArray(list) ? list.map((p) => ({ id: p.id, isDefault: p.isDefault, broken: p.broken ?? null })) : list
      }))
      record('presetInspect', safe(() => ctx.agentPresets.inspectCompositions?.(ctx)))

      const signal = new AbortController().signal
      record('toolOk', await safeAsync(async () => await ctx.tools.execute({ callId: randomUUID(), name: 'probe_ok', arguments: {}, signal })))
      record('toolDenied', await safeAsync(async () => await ctx.tools.execute({ callId: randomUUID(), name: 'probe_deny', arguments: {}, signal })))
      record('ordering', events.slice())

      // 4. agent-instructions: does the row accept LG-ROLE.md as a candidate?
      record('instructionRow', safe(() => {
        const rows = ctx.get?.('loader')?.root?.entries ?? null
        return rows === null ? 'loader not reachable' : describe(rows)
      }))

      writeFileSync(OUT, JSON.stringify(results, null, 2))
      console.log(`probe wrote ${OUT}`)
      setTimeout(() => process.exit(0), 300)
    })()
    return () => {}
  })
}
