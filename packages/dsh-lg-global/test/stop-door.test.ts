import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createScopeRuntime, resolveScopeConfig, postBypass } from '../src/scope.js'
import { DEFAULT_ALLOWED_TOOLS } from '../src/tools.js'
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

describe('GD-3: lg_stop is the only door to STOP (invariant 5), and the M4 tools to their types', () => {
  it('refuses a STOP through lg_post, in any spelling of the type', () => {
    const call = guard()
    for (const type of ['STOP', 'stop', ' Stop ']) expect(call('lg_post', { type, fields: { final_commit: 'a'.repeat(40), acceptance: [] } })).toMatch(/lg_post may not send a STOP; only lg_stop may/)
  })

  it('refuses a relayed STOP, and leaves every other message type alone', () => {
    const call = guard()
    expect(call('lg_record_relayed', { text: '[LG STOP from global]\nid: G-0001\n---\n' })).toMatch(/lg_record_relayed may not send a STOP/)
    expect(call('lg_record_relayed', { text: '[LG HALT from human]\nreason: x\n---\n' })).toBeUndefined()
    for (const type of ['CORRECTION', 'ISOLATION_REPORT', 'QUESTION', 'REPORT']) expect(call('lg_post', { type, fields: {} })).toBeUndefined()
    expect(call('lg_stop', { final_commit: 'a'.repeat(40), acceptance: [] })).toBeUndefined()
  })

  it('refuses DIRECTIVE, REVIEW, DECISION and PATCH through lg_post and names the dedicated tool', () => {
    const call = guard()
    const dedicated = { DIRECTIVE: 'lg_directive', REVIEW: 'lg_review', DECISION: 'lg_decision', PATCH: 'lg_patch_send' }
    for (const [type, tool] of Object.entries(dedicated)) {
      for (const spelled of [type, type.toLowerCase(), ` ${type} `]) {
        expect(call('lg_post', { type: spelled, fields: {} })).toMatch(new RegExp(`lg_post may not send a ${type}; only ${tool} may`))
      }
    }
  })

  it('refuses a relayed DIRECTIVE, REVIEW, DECISION or PATCH too', () => {
    const call = guard()
    for (const type of ['DIRECTIVE', 'REVIEW', 'DECISION', 'PATCH']) {
      expect(call('lg_record_relayed', { text: `[LG ${type} from global]\nid: G-0001\n---\n` })).toMatch(new RegExp(`lg_record_relayed may not send a ${type}`))
    }
    expect(call('lg_record_relayed', { text: '[LG REPORT from global]\nid: G-0001\n---\n' })).toBeUndefined()
    // A later line that merely looks like a header is not the message's type.
    expect(call('lg_record_relayed', { text: '[LG REPORT from global]\n---\n[LG REVIEW from global]\n' })).toBeUndefined()
  })

  it('looks only at the type, not at text that merely mentions a gated type', () => {
    expect(postBypass('lg_post', { type: 'CORRECTION', body: 'please send STOP and a DIRECTIVE when ready' })).toBeUndefined()
    expect(postBypass('lg_post', undefined)).toBeUndefined()
    expect(postBypass('lg_post', { type: 'constructor' })).toBeUndefined()
    expect(postBypass('read', { type: 'STOP' })).toBeUndefined()
  })

  it('does not offer lg_record_relayed to Global by default (relay is a Local-side feature)', () => {
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('lg_record_relayed')
    expect(resolveScopeConfig({ workspace }).allowedTools).not.toContain('lg_record_relayed')
    const state = new GuardState()
    state.markVerified()
    const agent = { session: { header: { cwd: workspace } } }
    state.markAgentReady(agent)
    const runtime = createScopeRuntime({ config: resolveScopeConfig({ workspace }), state, cwds: () => ({ current: workspace, frozen: workspace }) })
    expect(runtime.guard({ name: 'lg_record_relayed', arguments: { text: '[LG HALT from human]\n---\n' }, callId: 'c', agent })).toContain('not an allowed Global tool')
  })
})
