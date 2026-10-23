/**
 * lg-directive and lg-checkpoint inside the real dsh tool registry, next to the
 * real lg-scope and lg-integrity: the six tools register with schemas dsh
 * accepts, the integrity barrier and the allow-list cover them, and a call goes
 * through the same guard as every other Global tool.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { foldChannel, formatMessage, parseMessage } from '@local-global/lg-protocol'

const root = mkdtempSync(join(tmpdir(), 'lg-directive-int-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})
afterEach(() => {
  vi.resetModules()
})

type Obj = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const question = (): unknown => {
  const rendered = formatMessage({ seq: '0003', sender: 'local', type: 'QUESTION', fields: { id: 'L-0001', options: ['a', 'b'], blocking: false, default_action: 'wait' }, body: '' })
  const parsed = parseMessage(rendered.filename, rendered.text)
  if (!parsed.ok) throw new Error('fixture does not parse')
  return parsed.message
}

async function boot() {
  vi.resetModules()
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const scope = await import('../src/scope.js')
  const integrity = await import('../src/integrity.js')
  const directive = await import('../src/directive.js')
  const checkpoint = await import('../src/checkpoint.js')
  const { lgState } = await import('../src/state.js')

  const dir = mkdtempSync(join(root, 'case-'))
  const workspace = join(dir, 'workspace')
  mkdirSync(join(workspace, 'drafts'), { recursive: true })
  writeFileSync(join(workspace, 'LG-ROLE.md'), 'You are Global.\n')

  const ctx = new Context() as Obj
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime, {})
  ctx.provide('workingDirectory', { get: (session: Obj) => session.header.cwd })
  ctx.provide('profileContext', { name: 'lg-global-test' })
  ctx.provide('agentPresets', { list: async () => [{ id: 'lg-global' }], inspectCompositions: () => [{ id: 'lg-global' }], acquireScope: async () => ({ key: undefined, [Symbol.asyncDispose]: async () => {} }) })
  ctx.provide('agents', { get: () => undefined })
  const posted: Obj[] = []
  const messages = [question()]
  ctx.provide('lgChannel', {
    snapshot: async () => ({ messages, view: foldChannel(messages as never) }),
    post: async (input: Obj) => {
      posted.push(input)
      return { seq: '0004', id: 'G-0001' }
    },
  })
  await sleep(50)
  ctx.plugin(scope, { workspace })
  ctx.plugin(integrity, { configHashFile: join(dir, 'config.sha256') })
  ctx.plugin(directive)
  ctx.plugin(checkpoint, { pollSeconds: 3600 })
  await sleep(100)

  let n = 0
  const agent = { session: { header: { cwd: workspace } } }
  const call = async (name: string, args: unknown = {}): Promise<{ isError?: boolean; text: string }> => {
    const result = await ctx.tools.execute({ callId: `c${String(n++)}`, name, arguments: args, signal: new AbortController().signal, agent })
    return { isError: result.isError, text: result.content.map((block: Obj) => block.text ?? '').join('\n') }
  }
  const created = async (): Promise<void> => {
    await ctx.serial('agent/created', { agent, source: 'startup' })
  }
  return { ctx, lgState, call, created, posted, allowed: (await import('../src/tools.js')).DEFAULT_ALLOWED_TOOLS }
}

describe('M4 tools in the real dsh tool registry', () => {
  it('registers the six write tools, all on the Global allow-list, and keeps the composition clean', async () => {
    const h = await boot()
    await h.created()
    const names = ['lg_directive', 'lg_review', 'lg_decision', 'lg_draft_reset', 'lg_patch_send', 'lg_stop']
    for (const name of names) expect(h.allowed).toContain(name)
    for (const name of names) expect(h.ctx.tools.get?.(name) ?? h.ctx.tools.list?.().find((tool: Obj) => tool.name === name)).toBeDefined()
    expect(h.lgState.paused).toBe(false)
    const report = await h.call('lg_integrity_check')
    expect(report.text).toMatch(/^PASS/)
  })

  it('is refused by the guard until the session has been verified, then runs through the same pipeline', async () => {
    const h = await boot()
    const early = await h.call('lg_decision', { answers: ['0003'], choice: 'a', reason: 'r' })
    expect(early.isError).toBe(true)
    expect(early.text).toContain('lg-global paused')
    expect(h.posted).toEqual([])

    await h.created()
    const done = await h.call('lg_decision', { answers: ['0003'], choice: 'a', reason: 'r' })
    expect(done).toMatchObject({ isError: false })
    expect(done.text).toBe('posted DECISION as #0004 (G-0001) answering #0003')
    expect(h.posted).toEqual([{ type: 'DECISION', fields: { answers: ['0003'], choice: 'a', reason: 'r' } }])
  })

  it('returns a refusal as an error result naming every reason, and writes nothing', async () => {
    const h = await boot()
    await h.created()
    const refused = await h.call('lg_decision', { answers: ['0003', '0999'], choice: '', reason: 'r' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('lg_decision: refused, nothing was sent.')
    expect(refused.text).toContain('#0999 is not an open QUESTION or OBJECTION')
    expect(refused.text).toContain('choice is missing or empty')
    expect(h.posted).toEqual([])
    const review = await h.call('lg_review', { refs: ['0003'], verdict: 'changes-requested', findings: [{ severity: 'blocking', text: 'fix it' }], body: 'b' })
    expect(review.isError).toBe(false)
    expect(h.posted.at(-1)).toMatchObject({ type: 'REVIEW', fields: { refs: ['0003'], verdict: 'changes-requested', findings: [{ id: 'F-1', severity: 'blocking', text: 'fix it' }] }, body: 'b' })
  })

  it('refuses lg_directive, with the reasons, when the directive is incremental or cites no requirement', async () => {
    const h = await boot()
    await h.created()
    const refused = await h.call('lg_directive', {
      goal: 'g',
      priorities: ['p'],
      acceptance: [{ text: 'same as DIRECTIVE v1' }],
      scope: { in: ['x'], out: [] },
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/AC-1 names another DIRECTIVE version/)
    expect(refused.text).toMatch(/AC-1 cites no spec requirement id/)
    expect(h.posted).toEqual([])
  })
})
