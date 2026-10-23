import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createScopeRuntime, resolveScopeConfig, stopBypass } from '../src/scope.js'
import { GuardState } from '../src/state.js'

const root = mkdtempSync(join(tmpdir(), 'lg-stop-door-'))
const workspace = join(root, 'workspace')
mkdirSync(join(workspace, 'drafts'), { recursive: true })
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function guard() {
  const state = new GuardState()
  state.markVerified()
  const agent = { session: { header: { cwd: workspace } } }
  state.markAgentReady(agent)
  const runtime = createScopeRuntime({ config: resolveScopeConfig({ workspace, allowedTools: ['lg_post', 'lg_record_relayed', 'lg_stop'] }), state, cwds: () => ({ current: workspace, frozen: workspace }) })
  return (name: string, args: unknown) => runtime.guard({ name, arguments: args, callId: 'c', agent })
}

describe('GD-3: lg_stop is the only door to STOP (invariant 5)', () => {
  it('refuses a STOP through lg_post, in any spelling of the type', () => {
    const call = guard()
    for (const type of ['STOP', 'stop', ' Stop ']) expect(call('lg_post', { type, fields: { final_commit: 'a'.repeat(40), acceptance: [] } })).toMatch(/lg_post may not send a STOP; only lg_stop may/)
  })

  it('refuses a relayed STOP, and leaves every other message type alone', () => {
    const call = guard()
    expect(call('lg_record_relayed', { text: '[LG STOP from global]\nid: G-0001\n---\n' })).toMatch(/lg_record_relayed may not send a STOP/)
    expect(call('lg_record_relayed', { text: '[LG HALT from human]\nreason: x\n---\n' })).toBeUndefined()
    for (const type of ['REVIEW', 'DECISION', 'DIRECTIVE', 'CORRECTION', 'ISOLATION_REPORT']) expect(call('lg_post', { type, fields: {} })).toBeUndefined()
    expect(call('lg_stop', { final_commit: 'a'.repeat(40), acceptance: [] })).toBeUndefined()
  })

  it('looks only at the type, not at text that merely mentions STOP', () => {
    expect(stopBypass('lg_post', { type: 'REVIEW', body: 'please send STOP when ready' })).toBeUndefined()
    expect(stopBypass('lg_post', undefined)).toBeUndefined()
    expect(stopBypass('read', { type: 'STOP' })).toBeUndefined()
  })
})
