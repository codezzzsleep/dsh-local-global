import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'lg-m2-acceptance'
export const inject = ['tools', 'agents', 'agentPresets']

const OUT = process.env.LG_M2_ACCEPT_OUT ?? '/tmp/m2/acceptance.json'
const WORKSPACE = process.env.LG_M2_WORKSPACE ?? '/var/lib/deepseek-harness/.dsh-global-m2/workspace'
const OUTSIDE_DIR = process.env.LG_M2_OUTSIDE ?? '/var/lib/deepseek-harness/.dsh-global-m2/outside'
const LOCAL_DIR = process.env.LG_M2_LOCAL_DIR ?? '/var/lib/deepseek-harness/GlobalAndLocalAgent'

const results = []

function record(id, kind, expectation, outcome) {
  results.push({ id, kind, expectation, ...outcome })
  console.log(`[acceptance] ${id} ${kind} -> ${outcome.isError ? 'error' : 'ok'}: ${outcome.detail.slice(0, 160)}`)
}

function summarize(result) {
  const text = Array.isArray(result?.content)
    ? result.content.map((block) => (block && block.text) || '').join('\n')
    : ''
  return {
    isError: result?.isError === true,
    detail: (result?.error?.message ?? text ?? JSON.stringify(result)).slice(0, 2000),
  }
}

export function apply(ctx) {
  mkdirSync('/tmp/m2', { recursive: true })

  ctx.effect(() => {
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500))

      // Fixtures outside and inside the workspace.
      mkdirSync(OUTSIDE_DIR, { recursive: true })
      writeFileSync(join(OUTSIDE_DIR, 'secret.txt'), 'outside secret\n')
      mkdirSync(join(WORKSPACE, 'drafts'), { recursive: true })
      writeFileSync(join(WORKSPACE, 'drafts', 'note.txt'), 'inside note\n')
      const escapeLink = join(WORKSPACE, 'escape-link')
      const insideLink = join(WORKSPACE, 'inside-link')
      for (const link of [escapeLink, insideLink]) {
        if (existsSync(link)) rmSync(link, { force: true, recursive: false })
      }
      symlinkSync(OUTSIDE_DIR, escapeLink)
      symlinkSync(join(WORKSPACE, 'drafts'), insideLink)

      results.push({ id: 'info-presets', kind: 'info', expectation: 'preset roster', isError: false, detail: JSON.stringify(await ctx.agentPresets.list()) })

      const handle = await ctx.agents.create({
        sessionId: randomUUID(),
        meta: { cwd: WORKSPACE, agentPreset: 'lg-global' },
        agentOptions: { provider: 'deepseek-account', model: 'deepseek-flash' },
        setup: async (agentCtx) => {
          try {
            const bound = await ctx.agentPresets.mount(agentCtx, 'lg-global')
            console.log(`[acceptance] mounted preset ${JSON.stringify(bound && bound.id)}`)
          } catch (error) {
            console.log(`[acceptance] mount failed: ${error && error.message}`)
          }
        },
      })
      const agent = handle.agent
      try {
        const bound = await ctx.agentPresets.select(agent, 'lg-global')
        console.log(`[acceptance] preset bound: ${bound}`)
      } catch (error) {
        console.log(`[acceptance] preset select failed: ${error && error.message}`)
      }

      // Preset tools live in the agent's scope, so dispatch through the scoped
      // registry rather than the process-wide one.
      // Preset rows live in an isolated group; ordinary agent.ctx lookups resolve
      // to the host realm, so the scoped runtime must be read through serviceFor.
      const tools = ctx.agentPresets.serviceFor(agent, 'tools') ?? (agent.ctx && agent.ctx.tools) ?? ctx.tools
      const viaService = ctx.agentPresets.serviceFor(agent, 'tools')
      const visible = viaService && viaService.schemas ? viaService.schemas().map((schema) => schema.name) : []
      const viaHost = ctx.tools.schemas ? ctx.tools.schemas().map((schema) => schema.name) : []
      results.push({ id: 'info-tools-host', kind: 'info', expectation: 'host realm tools', isError: false, detail: JSON.stringify(viaHost) })
      try {
        const lease = await ctx.agentPresets.acquireScope('lg-global')
        const scopedNames = ctx.tools.schemas(lease.key).map((schema) => schema.name)
        results.push({ id: 'info-tools-scope', kind: 'info', expectation: 'preset scope tools', isError: false, detail: JSON.stringify(scopedNames) })
        try { lease.dispose && lease.dispose() } catch {}
      } catch (error) {
        results.push({ id: 'info-tools-scope', kind: 'info', expectation: 'preset scope tools', isError: true, detail: String(error && error.message) })
      }
      results.push({ id: 'info-tools', kind: 'info', expectation: 'tools visible to the session', isError: false, detail: JSON.stringify(visible) })

      const call = async (toolName, args) => {
        try {
          const result = await tools.execute({
            callId: randomUUID(),
            name: toolName,
            arguments: args,
            agent,
            signal: new AbortController().signal,
          })
          return summarize(result)
        } catch (error) {
          return { isError: true, detail: String(error && error.message ? error.message : error) }
        }
      }

      // --- path scope ---------------------------------------------------
      record('N1', 'negative', 'read the Local working directory must be denied', await call('read', { file_path: join(LOCAL_DIR, '调研-全局与局部Agent框架.md') }))
      record('P1', 'positive', 'read a file inside the workspace must succeed', await call('read', { file_path: join(WORKSPACE, 'LG-ROLE.md') }))
      record('N2', 'negative', 'a ../ escape must be denied', await call('read', { file_path: join(WORKSPACE, '..', 'outside', 'secret.txt') }))
      record('P2', 'positive', 'a relative path inside the workspace must succeed', await call('read', { file_path: 'drafts/note.txt' }))
      record('N3', 'negative', 'a symlink escaping the workspace must be denied', await call('read', { file_path: join(escapeLink, 'secret.txt') }))
      record('P3', 'positive', 'a symlink inside the workspace must succeed', await call('read', { file_path: join(insideLink, 'note.txt') }))

      // --- network scope ------------------------------------------------
      record('N4', 'negative', 'web_fetch to 127.0.0.1 must be denied', await call('web_fetch', { url: 'http://127.0.0.1:8080/' }))
      record('N5', 'negative', 'web_fetch to a LAN address must be denied', await call('web_fetch', { url: 'http://192.168.1.10/' }))
      record('N6', 'negative', 'web_fetch with file:// must be denied', await call('web_fetch', { url: 'file:///etc/passwd' }))
      record('N7', 'negative', 'web_fetch to a host outside the allowlist must be denied', await call('web_fetch', { url: 'https://example.com/' }))
      record('P4', 'positive', 'web_fetch to an allowlisted host must succeed', await call('web_fetch', { url: 'https://api.github.com/rate_limit' }))

      // --- tool whitelist ----------------------------------------------
      record('P5', 'positive', 'integrity check on the composed session must pass', await call('lg_integrity_check', {}))
      const extra = ctx.tools.register({
        name: 'probe_extra_tool',
        description: 'Acceptance probe: a tool outside the whitelist.',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute() {
          return 'extra'
        },
      })
      const probeAgent = await ctx.agents.create({
        sessionId: randomUUID(),
        meta: { cwd: WORKSPACE, agentPreset: 'lg-global' },
        agentOptions: { provider: 'deepseek-account', model: 'deepseek-flash' },
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
      record('N8', 'negative', 'a tool outside the whitelist must fail the integrity check', await call('lg_integrity_check', {}))
      extra()
      await probeAgent.dispose()

      // --- repository ---------------------------------------------------
      record('P6', 'positive', 'lg_repo_sync must match remote HEAD', await call('lg_repo_sync', {}))
      record('P7', 'positive', 'lg_repo_log must list commits', await call('lg_repo_log', { limit: 3 }))
      const log = await call('lg_repo_log', { limit: 2 })
      record('P8', 'positive', 'lg_repo_show must read a file byte-exact', await call('lg_repo_show', { commit: 'HEAD', path: 'README.md' }))
      record('P9', 'positive', 'lg_repo_diff must produce a diff', await call('lg_repo_diff', { from: 'HEAD~1', to: 'HEAD' }))
      record('info-log', 'info', 'commit list', { isError: log.isError, detail: log.detail.slice(0, 400) })

      writeFileSync(OUT, JSON.stringify({ workspace: WORKSPACE, results }, null, 2))
      console.log('acceptance written')
      await handle.dispose()
      setTimeout(() => process.exit(0), 500)
    })().catch((error) => {
      writeFileSync(OUT, JSON.stringify({ fatal: String(error && error.stack ? error.stack : error), results }, null, 2))
      console.log(`acceptance failed: ${error}`)
      setTimeout(() => process.exit(1), 500)
    })
    return () => {}
  })
}
