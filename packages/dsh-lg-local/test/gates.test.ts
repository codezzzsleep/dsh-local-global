import { describe, expect, it } from 'vitest'

import { resolveActionGateConfig, gateReason, matchRule, type KnownApproval } from '../src/action-gate.js'
import { protectReason, resolveProtectConfig } from '../src/protect.js'
import { gateMessage, gateReasons, type GateFacts } from '../src/report-gate.js'
import { actionFingerprint } from '@local-global/lg-protocol'

describe('PT-1: protected paths', () => {
  const config = resolveProtectConfig({ protectedPaths: ['/srv/global-home', '/srv/repo-sandbox'] })
  const cwd = '/srv/local-project'

  it('refuses a filesystem tool that points into a protected area', () => {
    expect(protectReason(config, 'read', { file_path: '/srv/global-home/workspace/LG-ROLE.md' }, cwd)).toContain('protected path')
    expect(protectReason(config, 'edit', { file_path: '/srv/repo-sandbox/store/x' }, cwd)).toContain('protected path')
    expect(protectReason(config, 'glob', { path: '/srv/global-home' }, cwd)).toContain('protected path')
    // Relative paths are resolved the way the tool resolves them.
    expect(protectReason(config, 'read', { file_path: 'global-home/secret.txt' }, '/srv')).toContain('protected path')
  })

  it('refuses bash text that names a protected area', () => {
    expect(protectReason(config, 'bash', { command: 'ls /srv/global-home' }, cwd)).toContain('protected path')
    expect(protectReason(config, 'bash', { command: 'cat /srv/repo-sandbox/store/db' }, cwd)).toContain('protected path')
  })

  it('lets ordinary project work through', () => {
    expect(protectReason(config, 'read', { file_path: 'packages/lg-protocol/src/fold.ts' }, cwd)).toBeUndefined()
    expect(protectReason(config, 'edit', { file_path: '/srv/local-project/src/a.ts' }, cwd)).toBeUndefined()
    expect(protectReason(config, 'bash', { command: 'pnpm -r test' }, cwd)).toBeUndefined()
    expect(protectReason(config, 'bash', { command: 'git status' }, cwd)).toBeUndefined()
  })
})

describe('AG-1 / AG-2: C-class actions need one unused approval', () => {
  const config = resolveActionGateConfig({})
  const forcePush = { command: 'git push --force origin main' }

  it('recognises the default rules', () => {
    expect(matchRule(config, 'bash', forcePush)?.rule.id).toBe('force-push')
    expect(matchRule(config, 'bash', { command: 'rm -rf build' })?.rule.id).toBe('rm-rf')
    expect(matchRule(config, 'bash', { command: 'pnpm publish' })?.rule.id).toBe('publish')
    expect(matchRule(config, 'bash', { command: 'git commit --amend' })?.rule.id).toBe('commit-amend')
    expect(matchRule(config, 'bash', { command: 'pnpm -r test' })).toBeUndefined()
  })

  it('denies a matching command and names its fingerprint', () => {
    const reason = gateReason(config, 'bash', forcePush, [], () => undefined)
    expect(reason).toContain('force-push')
    expect(reason).toContain(actionFingerprint('force-push', forcePush.command))
    expect(reason).toContain('QUESTION')
  })

  it('executes once when an unused approval matches, spending it', () => {
    const fingerprint = actionFingerprint('force-push', forcePush.command)
    const approvals: KnownApproval[] = [{ decision: '0042', fingerprint }]
    const spent: string[] = []
    expect(gateReason(config, 'bash', forcePush, approvals, (decision) => spent.push(decision))).toBeUndefined()
    expect(spent).toEqual(['0042'])
  })

  it('does not transfer an approval to another action', () => {
    // Consumption itself (second use denied, restart) is exercised through the
    // plugin in action-gate.test.ts; passing `[]` here proved nothing about it.
    const other = actionFingerprint('rm-rf', forcePush.command)
    expect(gateReason(config, 'bash', forcePush, [{ decision: '0042', fingerprint: other }], () => undefined)).toContain('force-push')
  })

  it('takes approvals as an argument — the guard does no I/O (AG-2)', () => {
    // The signature is the proof: judging is pure, the table is passed in.
    expect(gateReason.length).toBe(5)
  })
})

describe('RG-1: a turn may not end while something is unreported', () => {
  const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
    head: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    reportedCommits: ['aaaa1111bbbb2222cccc3333dddd4444eeee5555'],
    directiveVersion: 5,
    reportedDirectiveVersions: [5],
    unresolvedBlocking: 0,
    ...over,
  })

  it('stays quiet when everything is reported', () => {
    expect(gateReasons(facts())).toEqual([])
  })

  it('asks for a REPORT when HEAD is unreported', () => {
    const reasons = gateReasons(facts({ reportedCommits: [] }))
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('is in no REPORT')
    expect(gateMessage(reasons)).toContain('lg-report-gate')
    expect(gateMessage(reasons)).toContain('先发一条 REPORT')
  })

  it('asks when the newest DIRECTIVE version is unconfirmed', () => {
    expect(gateReasons(facts({ directiveVersion: 6 }))[0]).toContain('DIRECTIVE v6 is not confirmed')
  })

  it('asks when evidence has no manifest, and when blocking findings are open', () => {
    expect(gateReasons(facts(), ['M3/orphan'])[0]).toContain('evidence without a manifest: M3/orphan')
    expect(gateReasons(facts({ unresolvedBlocking: 2 }))[0]).toContain('2 blocking finding(s)')
  })
})
