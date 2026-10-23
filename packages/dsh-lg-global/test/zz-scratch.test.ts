import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

describe('scratch', () => {
  it('loads', async () => {
    const ctx = new Context()
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime, {})
    const scope = await import('../src/scope.js')
    const { lgState } = await import('../src/state.js')
    ctx.provide('workingDirectory', { get: () => '/tmp' })
    ctx.plugin(scope, { workspace: '/tmp/xx' })
    await new Promise((r) => setTimeout(r, 300))
    console.log('wd', (ctx as any).get('workingDirectory'), 'lgWorkspace', (ctx as any).get('lgWorkspace'))
    const r = await ctx.tools.execute({ callId: 'c', name: 'bash', arguments: {}, signal: new AbortController().signal } as any)
    console.log(JSON.stringify(r).slice(0, 300), lgState.paused)
    expect(true).toBe(true)
  })
})
