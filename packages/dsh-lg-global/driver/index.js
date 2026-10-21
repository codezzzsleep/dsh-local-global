/**
 * Model driver for M2 session acceptance.
 *
 * Creates one real, preset-scoped Global session and hands it tasks as ordinary
 * user turns, so every tool call in the evidence is issued by the model itself
 * (QA-3/QA-4). When the tasks are done it writes the session's raw event log to
 * the path named in the scenario file.
 *
 * The scenario file ($LG_SCENARIO, JSON) carries: { cwd, tasks[], out }.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'lg-m2-driver'
export const inject = ['agents', 'agentPresets']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Read this session's event log out of the dsh session store. */
function sessionEvents(dshHome, sessionId) {
  const root = `${dshHome}/sessions`
  for (const workspace of readdirSync(root)) {
    const dir = `${root}/${workspace}/${sessionId}`
    for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
      try {
        const raw = readFileSync(`${dir}/${name}`)
        return name.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
      } catch { /* try the next name */ }
    }
  }
  throw new Error(`no event log for session ${sessionId} under ${root}`)
}
export function apply(ctx) {
  ctx.effect(() => {
    const scenarioPath = process.env.LG_SCENARIO
    if (!scenarioPath) return
    const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))
    const dshHome = process.env.DSH_HOME ?? ''

    const run = async () => {
      const sessionId = randomUUID()
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: scenario.cwd, agentPreset: 'lg-global' },
        // Without an explicit provider/model the persona's {{model}} variable has
        // no value and prompt assembly fails before the model is ever called.
        agentOptions: scenario.agentOptions ?? { provider: 'deepseek-official', model: 'deepseek-flash' },
        setup: async (agentCtx) => {
          await ctx.agentPresets.mount(agentCtx, 'lg-global')
        },
      })
      const agent = handle.agent
      try { await ctx.agentPresets.select(agent, 'lg-global') } catch { /* recorded by integrity */ }

      for (const task of scenario.tasks) {
        // Same shape lg-channel hands an agent: a frozen user message whose
        // content is text blocks. A bare {role, content: string} is spliced into
        // the inbox but never driven as a turn.
        agent.followup(Object.freeze({
          id: randomUUID(),
          role: 'user',
          content: Object.freeze([{ type: 'text', text: task }]),
          source: { kind: 'user' },
        }))
        const deadline = Date.now() + (scenario.turnTimeoutMs ?? 180000)
        await sleep(1500)
        while (agent.status === 'running' && Date.now() < deadline) await sleep(1000)
        if (agent.status === 'running') {
          console.log(`[driver] turn timed out; cancelling`)
          try { agent.cancel({ kind: 'user' }) } catch { /* ignore */ }
          await sleep(2000)
        }
      }

      await sleep(1500)
      const jsonl = sessionEvents(dshHome, sessionId)
      mkdirSync(dirname(scenario.out), { recursive: true })
      writeFileSync(scenario.out, jsonl, 'utf8')
      console.log(`[driver] wrote ${scenario.out} (${jsonl.length} bytes) for session ${sessionId}`)
      setTimeout(() => process.exit(0), 200)
    }

    run().catch((error) => {
      console.log(`[driver] failed: ${error && error.message}`)
      setTimeout(() => process.exit(1), 200)
    })
    return () => {}
  })
}
