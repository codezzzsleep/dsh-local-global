import { describe, expect, it } from 'vitest'

import { apply, claimsCompletion, collectFacts, gateMessage, gateReasons, type GateFacts } from '../src/report-gate.js'
import { agentIn, fakeCtx, git, repo, tmp } from './fake-ctx.js'

type Message = { seq: string; sender: string; type: string; fields: Record<string, unknown> }
const message = (seq: string, sender: string, type: string, fields: Record<string, unknown> = {}): Message => ({ seq, sender, type, fields })

const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  head: 'abc',
  reportedCommits: ['abc'],
  directiveVersion: 5,
  reportedDirectiveVersions: [5],
  unresolvedBlocking: 0,
  ...over,
})

describe('RG-1 condition 4: a blocking finding matters when the turn claims completion', () => {
  it('stays quiet for a status update, speaks for a completion claim, and for an unknown one', () => {
    expect(gateReasons(facts({ unresolvedBlocking: 1, claimsCompletion: false }))).toEqual([])
    expect(gateReasons(facts({ unresolvedBlocking: 1, claimsCompletion: true }))[0]).toContain('1 blocking finding(s) unresolved while the turn claims completion')
    expect(gateReasons(facts({ unresolvedBlocking: 1 }))).toHaveLength(1)
  })

  it.each([
    ['All done, the tests pass.', true],
    ['The fix is complete and pushed.', true],
    ['已完成，全部通过。', true],
    ['Still working on it, not done yet.', false],
    ["I haven't finished the migration; continuing.", false],
    ['还没完成，继续处理。', false],
    ['尚未修复，下一步看日志。', false],
    ['Reading the failing test now.', false],
    ['', false],
    [undefined, true],
  ])('claimsCompletion(%j) is %s', (text, expected) => {
    expect(claimsCompletion(text)).toBe(expected)
  })
})

describe('AG-1 / RG-1: spent approvals and unreadable HEAD are reasons', () => {
  it('asks for consumed_approvals, naming the DECISIONs', () => {
    const reasons = gateReasons(facts({ unreportedApprovals: ['0042', '0044'] }))
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain("consumed_approvals: 0042, 0044")
  })

  it('does not call an unreadable HEAD “reported”', () => {
    const reasons = gateReasons(facts({ head: '', headError: 'not a repository', reportedCommits: [] }))
    expect(reasons).toEqual([expect.stringContaining('HEAD cannot be read (not a repository)')])
    expect(gateMessage(reasons, true)).toContain('最后一次提醒')
  })
})

describe('collectFacts', () => {
  const channel = (messages: Message[]) => ({ all: async () => messages })

  it('folds reports, directive versions, blocking findings and consumed approvals', async () => {
    const result = await collectFacts(
      channel([
        message('0003', 'global', 'DIRECTIVE', { version: 4 }),
        message('0004', 'global', 'DIRECTIVE', { version: 5 }),
        message('0005', 'local', 'REPORT', { commit: 'aaa', directive_version: 4, consumed_approvals: ['0010'] }),
        message('0006', 'local', 'REPORT', { commit: 'bbb', directive_version: 5 }),
        message('0007', 'global', 'REVIEW', { findings: [{ id: 'F-1', severity: 'blocking', text: 'x' }, { id: 'F-2', severity: 'minor', text: 'y' }] }),
        message('0008', 'local', 'REPORT', { commit: 'ccc', directive_version: 5, resolves: ['0007/F-1'] }),
        message('0009', 'global', 'REVIEW', { findings: [{ id: 'F-1', severity: 'blocking', text: 'again' }] }),
      ]),
      'ccc',
      { consumed: ['0010', '0011'], claimsCompletion: true },
    )
    expect(result).toMatchObject({
      head: 'ccc',
      reportedCommits: ['aaa', 'bbb', 'ccc'],
      directiveVersion: 5,
      reportedDirectiveVersions: [4, 5, 5],
      unresolvedBlocking: 1,
      claimsCompletion: true,
      unreportedApprovals: ['0011'],
    })
  })

  it('treats no consumed approvals and no messages as nothing owed', async () => {
    expect(await collectFacts(channel([]), 'h')).toMatchObject({ unresolvedBlocking: 0, unreportedApprovals: [], reportedCommits: [] })
  })
})

describe('lg-report-gate wiring', () => {
  interface Steer {
    id: string
    content: { text: string }[]
  }
  /** A gate on a real repo, a fake channel, and an agent that records its steers. */
  function world(messages: Message[] = [], services: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
    const dir = repo()
    const steers: Steer[] = []
    const agent = { ...agentIn(dir), steer: (steer: Steer) => steers.push(steer) }
    const fake = fakeCtx({ lgChannel: { all: async () => messages }, ...services })
    apply(fake.ctx, config)
    const stop = (turn = 1) => fake.emit('agent/turn-stopping', { agent, turn })
    const reportHead = (): void => {
      messages.push(message(String(messages.length + 1).padStart(4, '0'), 'local', 'REPORT', { commit: git(dir, 'rev-parse', 'HEAD').trim(), directive_version: 1 }))
    }
    return { dir, steers, agent, fake, stop, messages, reportHead }
  }

  it('steers when HEAD is unreported and goes quiet once it is reported', async () => {
    const w = world()
    await w.stop()
    expect(w.steers).toHaveLength(1)
    expect(w.steers[0]?.content[0]?.text).toContain('is in no REPORT')
    w.reportHead()
    await w.stop(2)
    expect(w.steers).toHaveLength(1)
  })

  it('fails closed when HEAD cannot be read', async () => {
    const w = world()
    const outside = tmp('nogit')
    w.agent.session.header.cwd = outside
    await w.stop()
    expect(w.steers).toHaveLength(1)
    expect(w.steers[0]?.content[0]?.text).toContain('HEAD cannot be read')
  })

  it('fails closed when the channel cannot be read', async () => {
    const dir = repo()
    const steers: Steer[] = []
    const fake = fakeCtx({
      lgChannel: {
        all: async () => {
          throw new Error('fetch failed')
        },
      },
    })
    apply(fake.ctx)
    await fake.emit('agent/turn-stopping', { agent: { ...agentIn(dir), steer: (s: Steer) => steers.push(s) }, turn: 1 })
    expect(steers[0]?.content[0]?.text).toContain('fetch failed')
  })

  it('cannot steer forever: after the limit it logs what is still open and lets the turn end', async () => {
    const w = world([], {}, { maxSteersPerTurn: 2 })
    await w.stop()
    await w.stop()
    await w.stop()
    await w.stop()
    expect(w.steers).toHaveLength(2)
    expect(w.steers[0]?.content[0]?.text).not.toContain('最后一次提醒')
    expect(w.steers[1]?.content[0]?.text).toContain('最后一次提醒')
    expect(w.fake.logs.filter((line) => line.includes('ending turn 1 with 1 open item'))).toHaveLength(2)
    // A new turn gets its own reminders.
    await w.stop(2)
    expect(w.steers).toHaveLength(3)
  })

  it('is inactive, and says so once, without lg-channel', async () => {
    const dir = repo()
    const fake = fakeCtx()
    apply(fake.ctx)
    const steers: unknown[] = []
    const agent = { ...agentIn(dir), steer: (s: unknown) => steers.push(s) }
    await fake.emit('agent/turn-stopping', { agent, turn: 1 })
    await fake.emit('agent/turn-stopping', { agent, turn: 2 })
    expect(steers).toEqual([])
    expect(fake.logs.filter((line) => line.includes('lg-channel is not composed'))).toHaveLength(1)
  })

  it('asks for REPORT when a spent approval is not listed in any REPORT', async () => {
    const consumed = [{ decision: '0042', fingerprint: 'force-push:x', consumedAt: 'now' }]
    const w = world([], { lgActionGate: { consumed: () => consumed } })
    w.reportHead()
    await w.stop()
    expect(w.steers[0]?.content[0]?.text).toContain("consumed_approvals: 0042")
    w.messages.push(message('0009', 'local', 'REPORT', { commit: git(w.dir, 'rev-parse', 'HEAD').trim(), directive_version: 1, consumed_approvals: ['0042'] }))
    await w.stop(2)
    expect(w.steers).toHaveLength(1)
  })

  it('only counts evidence written since the previous turn ended', async () => {
    const asked: number[] = []
    const w = world([], { lgEvidence: { missingManifests: (since?: number) => { asked.push(since ?? -1); return [] } } })
    w.reportHead()
    const started = Date.now()
    await w.stop(1)
    await w.stop(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await w.stop(2)
    expect(asked[0]).toBeLessThanOrEqual(started)
    expect(asked[1]).toBe(asked[0])
    expect(asked[2]).toBeGreaterThan(asked[0] ?? 0)
  })

  it('reports an orphan from the evidence plugin only while it is this turn’s', async () => {
    const w = world([], { lgEvidence: { missingManifests: (since?: number) => (since === undefined ? ['T/old'] : []) } })
    w.reportHead()
    await w.stop()
    expect(w.steers).toEqual([])
  })

  it('judges blocking findings by what the last assistant message said', async () => {
    const messages = [message('0003', 'global', 'REVIEW', { findings: [{ id: 'F-1', severity: 'blocking', text: 'x' }] })]
    const w = world(messages)
    w.reportHead()
    const say = async (text: string): Promise<void> => {
      await w.fake.emit('agent/assistant-stream', { agent: w.agent, frame: { type: 'start' } })
      await w.fake.emit('agent/assistant-stream', { agent: w.agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text } } })
      await w.fake.emit('agent/assistant-stream', { agent: w.agent, frame: { type: 'end', outcome: { kind: 'committed' } } })
    }
    await say('Still working on it, not done yet.')
    await w.stop(1)
    expect(w.steers).toEqual([])
    await say('All done!')
    await w.stop(2)
    expect(w.steers).toHaveLength(1)
    expect(w.steers[0]?.content[0]?.text).toContain('blocking finding(s) unresolved while the turn claims completion')
  })
})
