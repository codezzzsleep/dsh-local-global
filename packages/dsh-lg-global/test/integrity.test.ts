import { describe, expect, it } from 'vitest'


describe('pause lifecycle (PS-2)', () => {
  it('a clean check lifts the startup pause', async () => {
    const { GuardState } = await import('../src/state.js')
    const { checkTools } = await import('../src/integrity.js')
    const state = new GuardState()
    // Starts paused for `not-verified`, exactly as a booting profile does.
    expect(state.paused).toBe(true)
    const probe = checkTools(['read', 'glob'], ['read', 'glob'])
    expect(probe.pass).toBe(true)
    // Applying a passing probe must resume its own code, and the clean run as a
    // whole must clear `not-verified` — otherwise the pause never ends.
    state.resume(probe.name)
    state.markVerified()
    expect(state.paused).toBe(false)
  })

  it('a failing check keeps the pause and names the rule', async () => {
    const { GuardState } = await import('../src/state.js')
    const { checkTools } = await import('../src/integrity.js')
    const state = new GuardState()
    const probe = checkTools(['read', 'bash'], ['read'])
    expect(probe.pass).toBe(false)
    state.pause(probe.name, probe.detail)
    state.markVerified()
    expect(state.paused).toBe(true)
    expect(state.denial()).toContain('not allowed: bash')
  })
})

describe('checkFetchProvider fails closed when web tools are composed', () => {
  const ctxWith = (web: unknown) => ({ get: (name: string) => (name === 'web' ? web : undefined) })

  it('refuses a missing web service or an unreadable pin', async () => {
    const { checkFetchProvider } = await import('../src/integrity.js')
    expect(checkFetchProvider(ctxWith(undefined), 'http')).toMatchObject({ pass: false, detail: expect.stringContaining('no web service') })
    expect(checkFetchProvider(ctxWith({}), 'http', true)).toMatchObject({ pass: false, detail: expect.stringContaining('does not expose') })
    expect(checkFetchProvider(ctxWith({ config: {} }), 'http', true).pass).toBe(false)
  })

  it('stays quiet only when no web tool is composed, and still checks a readable pin', async () => {
    const { checkFetchProvider } = await import('../src/integrity.js')
    expect(checkFetchProvider(ctxWith(undefined), 'http', false).pass).toBe(true)
    expect(checkFetchProvider(ctxWith({}), 'http', false).pass).toBe(true)
    const web = (pin: string) => ({ config: { fetchProvider: { get: () => pin } } })
    expect(checkFetchProvider(ctxWith(web('http')), 'http', true).pass).toBe(true)
    expect(checkFetchProvider(ctxWith(web('other')), 'http', false).pass).toBe(false)
  })
})
