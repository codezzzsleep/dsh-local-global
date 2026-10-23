import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Rig, VALID } from './helpers.js'

vi.setConfig({ testTimeout: 60_000 })

const rig = new Rig()
beforeEach(async () => {
  await rig.open()
})
afterEach(async () => {
  await rig.close()
})

describe('HALT cannot be bypassed', () => {
  it('halts on a HALT whose fields are invalid, and labels the problem', async () => {
    const local = await rig.side('local')
    const agent = await rig.bound(local)
    await rig.write('human', 'HALT', '[LG HALT from human]\nwhy: no reason field\n---\n')
    await local.poll()

    expect(local.halted).toBe(true)
    expect(agent.calls[0]?.kind).toBe('cancel')
    expect(agent.texts).toHaveLength(1)
    expect(agent.texts[0]).toContain('HALT')
    expect(agent.texts[0]).toContain('reason')
    expect(agent.texts[0]).not.toContain('INVALID')
  })

  it('halts on a HALT that does not even parse', async () => {
    const local = await rig.side('local')
    const agent = await rig.bound(local)
    await rig.write('human', 'HALT', '[LG HALT from human]\nreason: [unclosed\n---\n')
    await local.poll()
    expect(local.halted).toBe(true)
    expect(agent.calls.some((call) => call.kind === 'cancel')).toBe(true)

    const second = await rig.side('global')
    const gagent = await rig.bound(second, 's2')
    await rig.write('human', 'HALT', '\u0001\u0002 not a header at all')
    await second.poll()
    expect(second.halted).toBe(true)
    expect(gagent.calls.some((call) => call.kind === 'cancel')).toBe(true)
  })

  it('ignores a supersedes from another sender', async () => {
    const local = await rig.side('local')
    const agent = await rig.bound(local)
    await rig.put('human', 'HALT', VALID.HALT({ id: 'H-0001' }))
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0001', supersedes: ['H-0001'] }))
    await local.poll()

    expect(local.halted).toBe(true)
    expect(agent.texts.join('\n')).not.toContain('SUPERSEDED')
    expect(agent.texts.join('\n')).toContain('#0001 HALT')
  })

  it('ignores a supersedes from the human too', async () => {
    const local = await rig.side('local')
    const agent = await rig.bound(local)
    await rig.put('human', 'HALT', VALID.HALT({ id: 'H-0001' }))
    await rig.put('human', 'HALT', VALID.HALT({ id: 'H-0002', supersedes: ['H-0001'] }))
    await local.poll()
    expect(local.halted).toBe(true)
    expect(agent.texts.join('\n')).not.toContain('SUPERSEDED')
  })

  it('acts on the HALT before delivering anything queued around it', async () => {
    const local = await rig.side('local')
    const agent = await rig.bound(local)
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0001' }))
    await rig.put('human', 'HALT', VALID.HALT({ id: 'H-0001' }))
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0002' }))
    await local.poll()

    expect(local.halted).toBe(true)
    expect(agent.calls.map((call) => call.kind)).toEqual(['cancel', 'followup'])
    expect(agent.texts).toHaveLength(1)
    expect(agent.texts[0]).toContain('HALT')
    expect(local.cursor).toBe('0002')

    // Halted for good: nothing more is delivered, even after more arrives.
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0003' }))
    await local.poll()
    expect(agent.texts).toHaveLength(1)
  })

  it('stays halted across a restart and authorises nothing', async () => {
    const local = await rig.side('local', { name: 'again' })
    await rig.bound(local)
    await rig.put('global', 'DECISION', VALID.DECISION({ answers: ['0001'], approve_action: 'force-push:abc123def456', id: 'G-0001' }))
    await local.poll()
    expect(local.approvals()).toHaveLength(1)
    await rig.put('human', 'HALT', VALID.HALT())
    await local.poll()
    expect(local.halted).toBe(true)
    expect(local.approvals()).toEqual([])

    const restarted = await rig.side('local', { name: 'again' })
    expect(restarted.halted).toBe(true)
  })

  it('does not halt on a HALT that predates the first bind: history never enters the session', async () => {
    await rig.put('human', 'HALT', VALID.HALT())
    const local = await rig.side('local')
    await local.bind('s1')
    await local.poll()
    // The old HALT is history; the first bind starts after it.
    expect(local.halted).toBe(false)
  })
})

describe('supersedes only works within one sender (PR-6, CH-10)', () => {
  it('delivers a message superseded by the same sender as SUPERSEDED, naming the replacement', async () => {
    const local = await rig.side('local')
    const agent = await rig.bound(local)
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0001' }))
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0002', supersedes: ['G-0001'] }))
    await local.poll()
    expect(agent.texts[0]).toContain('[LG #0001 CLAIM SUPERSEDED by G-0002]')
    expect(agent.texts[0]).toContain('不要执行')
    expect(agent.texts[1]).toBe(`[LG #0002 CLAIM from global id=G-0002]\n${agent.texts[1]?.split('\n').slice(1).join('\n')}`)
  })

  it('does not treat a message as superseded because another sender says so', async () => {
    const local = await rig.side('local')
    const agent = await rig.bound(local)
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0001' }))
    await rig.put('local', 'CLAIM', VALID.CLAIM({ id: 'L-0001', implementer: 'local', supersedes: ['G-0001'] }))
    await local.poll()
    expect(agent.texts).toHaveLength(1)
    expect(agent.texts[0]).toMatch(/^\[LG #0001 CLAIM from global id=G-0001\]/u)
    expect(agent.texts[0]).not.toContain('SUPERSEDED')
  })

  it('labels an ignored supersedes on the message that carried it', async () => {
    const global = await rig.side('global')
    const agent = await rig.bound(global)
    await rig.put('local', 'CLAIM', VALID.CLAIM({ id: 'L-0001', implementer: 'local', supersedes: ['G-0099'] }))
    await global.poll()
    expect(agent.texts).toHaveLength(1)
    expect(agent.texts[0]).toContain('[LG NOTE #0001] supersedes G-0099 ignored')
    expect(agent.texts[0]).toContain('[LG #0001 CLAIM from local id=L-0001]')
  })
})

describe('state is built only from valid messages (REVIEW #5)', () => {
  it('grants approvals only for valid, unsuperseded DECISIONs from global', async () => {
    const local = await rig.side('local')
    await rig.put('local', 'QUESTION', VALID.QUESTION())
    // From the wrong sender: parses, validates nowhere.
    await rig.put('local', 'DECISION', VALID.DECISION({ approve_action: 'rule:111111111111' }))
    // Right sender, required fields missing.
    await rig.write('global', 'DECISION', "[LG DECISION from global]\napprove_action: 'rule:222222222222'\n---\n")
    // Valid.
    await rig.put('global', 'DECISION', VALID.DECISION({ approve_action: 'rule:333333333333', id: 'G-0001' }))
    // Valid but retracted by its sender.
    await rig.put('global', 'DECISION', VALID.DECISION({ approve_action: 'rule:444444444444', id: 'G-0002' }))
    await rig.put('global', 'DECISION', VALID.DECISION({ id: 'G-0003', supersedes: ['G-0002'], choice: 'B' }))
    await local.poll()

    expect(local.approvals().map((approval) => approval.fingerprint)).toEqual(['rule:333333333333'])
  })

  it('does not list a superseded QUESTION as open, in the tool, the status and the fold', async () => {
    const local = await rig.side('local')
    await rig.put('local', 'CLAIM', VALID.CLAIM({ implementer: 'local' }))
    await rig.put('local', 'CLAIM', VALID.CLAIM({ implementer: 'local' }))
    await rig.put('local', 'QUESTION', VALID.QUESTION({ id: 'L-0001' }))
    await rig.put('local', 'QUESTION', VALID.QUESTION({ id: 'L-0002', supersedes: ['L-0001'], options: ['B'] }))
    await local.repo.fetch()
    expect((await local.openQuestions()).map((message) => message.seq)).toEqual(['0004'])
    expect((await local.openItems()).map((item) => item.ref)).toEqual(['0004'])
    expect(await local.statusText()).toContain('open questions: 0004')
  })

  it('treats an invalid sender at 0001–0002 on a fresh channel as invalid, and lets it grant nothing', async () => {
    const local = await rig.side('local')
    const agent = await rig.bound(local)
    await rig.put('local', 'DECISION', VALID.DECISION({ approve_action: 'rule:555555555555' }))
    await rig.put('local', 'DIRECTIVE' as never, { version: 1 })
    await local.poll()
    // Both are written by local, and local may write neither: INVALID, never delivered as themselves.
    expect(agent.texts).toHaveLength(0)
    expect(local.approvals()).toEqual([])
  })

  it('shows unresolved findings and pending checkpoints in the status and in lg_open_questions', async () => {
    const local = await rig.side('local')
    await rig.put('local', 'CLAIM', VALID.CLAIM({ implementer: 'local' }))
    await rig.put('local', 'CLAIM', VALID.CLAIM({ implementer: 'local' }))
    await rig.put('global', 'REVIEW', VALID.REVIEW({ refs: ['0001'], findings: [
      { id: 'F-1', severity: 'blocking', text: 'must fix' },
      { id: 'F-2', severity: 'minor', text: 'nit' },
    ] }))
    await rig.put('local', 'REPORT', VALID.REPORT({ refs: ['0003'], checkpoint: true, id: 'L-0001' }))

    await local.repo.fetch()
    const status = await local.statusText()
    expect(status).toContain('unresolved findings: 0003/F-1 (blocking), 0003/F-2 (minor)')
    expect(status).toContain('pending checkpoints: 0004')

    const items = await local.openItems()
    expect(items.map((item) => `${item.kind}:${item.ref}`)).toEqual(['finding:0003/F-1', 'checkpoint:0004'])
  })
})

describe('delivery never loses a message (CH-6)', () => {
  it('keeps the cursor and the id in front of a message whose delivery threw, and retries it', async () => {
    const local = await rig.side('local', { name: 'loc' })
    const agent = await rig.bound(local)
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0001' }))

    agent.failure = new Error('agent is gone')
    await expect(local.poll()).rejects.toThrow('agent is gone')
    expect(local.cursor).toBe('0000')
    const saved = JSON.parse(await readFile(join(rig.workspace, 'loc-state', await readdirSlug(rig.workspace, 'loc-state')), 'utf8')) as { deliveredIds: string[]; cursor: string }
    expect(saved.deliveredIds).toEqual([])
    expect(saved.cursor).toBe('0000')

    agent.failure = undefined
    await local.poll()
    expect(agent.texts).toHaveLength(1)
    expect(local.cursor).toBe('0001')
    // And it is not delivered a second time.
    await local.poll()
    expect(agent.texts).toHaveLength(1)
  })

  it('stops at the failing message instead of skipping over it', async () => {
    const local = await rig.side('local')
    const agent = await rig.bound(local)
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0001' }))
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0002' }))
    await local.poll()
    expect(local.cursor).toBe('0002')
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0003' }))
    await rig.put('global', 'CLAIM', VALID.CLAIM({ id: 'G-0004' }))
    agent.failure = new Error('boom')
    await expect(local.poll()).rejects.toThrow('boom')
    expect(local.cursor).toBe('0002')
    agent.failure = undefined
    await local.poll()
    expect(agent.texts.map((text) => /id=(G-\d+)/u.exec(text)?.[1])).toEqual(['G-0001', 'G-0002', 'G-0003', 'G-0004'])
  })

  it('never delivers its own messages, nor what it archived by relay', async () => {
    const local = await rig.side('local')
    const agent = await rig.bound(local)
    await local.post({ type: 'CLAIM', fields: VALID.CLAIM({ implementer: 'local' }) })
    await local.recordRelayed(`[LG CLAIM from global]\nid: G-0001\nscope: [x]\nimplementer: global\n---\n`)
    await local.poll()
    expect(agent.texts).toEqual([])
    expect(local.cursor).toBe('0002')
  })
})

describe('Global opens a turn only for wake-class messages (CH-4)', () => {
  it('injects an INVALID notice instead of following up', async () => {
    const global = await rig.side('global')
    const agent = await rig.bound(global)
    await rig.write('local', 'REPORT', '[LG REPORT from local]\ncheckpoint: true\n---\n')
    await global.poll()
    expect(agent.calls.map((call) => call.kind)).toEqual(['inject'])
    expect(agent.texts[0]).toMatch(/^\[LG INVALID #0001\]/u)
  })

  it('still wakes on a valid OBJECTION and injects a plain progress REPORT', async () => {
    const global = await rig.side('global')
    const agent = await rig.bound(global)
    await rig.put('local', 'REPORT', VALID.REPORT({ id: 'L-0001' }))
    await rig.put('local', 'OBJECTION', { target: '0001', evidence: ['x'], id: 'L-0002' })
    await global.poll()
    expect(agent.calls.map((call) => call.kind)).toEqual(['inject', 'followup'])
  })

  it('opens no turn for an INVALID notice on the Local side either way it is steered', async () => {
    const local = await rig.side('local')
    const agent = await rig.bound(local)
    await rig.write('global', 'REVIEW', '[LG REVIEW from global]\nverdict: accepted\n---\n')
    await local.poll()
    expect(agent.calls.map((call) => call.kind)).toEqual(['followup'])
    expect(agent.texts[0]).toMatch(/^\[LG INVALID #0001\]/u)
  })
})

async function readdirSlug(workspace: string, dir: string): Promise<string> {
  const { readdir } = await import('node:fs/promises')
  const name = (await readdir(join(workspace, dir))).find((entry) => entry.endsWith('.json'))
  if (name === undefined) throw new Error('no state file')
  return name
}
