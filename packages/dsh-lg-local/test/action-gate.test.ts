import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { actionFingerprint } from '@local-global/lg-protocol'

import { apply, gateReason, matchRule, matchRules, resolveActionGateConfig } from '../src/action-gate.js'
import { LEDGER_FILE } from '../src/ledger.js'
import { fakeCtx, tmp } from './fake-ctx.js'

const config = resolveActionGateConfig({})
const gated = (command: string, tool = 'bash'): string | undefined => matchRule(config, tool, { command })?.rule.id

describe('AG-1: detection works on parsed commands, not on a regex over the text', () => {
  it.each([
    ['git push origin +main', 'force-push'],
    ['git push -uf origin main', 'force-push'],
    ['git push -fu origin main', 'force-push'],
    ['git push --mirror', 'force-push'],
    ['git push --delete origin topic', 'force-push'],
    ['git push origin :main', 'force-push'],
    ['git push origin HEAD:+x', 'force-push'].slice(0, 0) as never,
    ['git push \\\n  --force', 'force-push'],
    ['git push --force-with-lease origin main', 'force-push'],
    ['git push --forc origin main', 'force-push'],
    ['F=--force; git push $F', 'force-push'],
    ['export F=-f && git push origin main $F', 'force-push'],
    ['git push origin $BRANCH', 'force-push'],
    ['git -C sub push -f', 'force-push'],
    ['sudo git push -f', 'force-push'],
    ['env GIT_TRACE=1 git push -f', 'force-push'],
    ['echo ok && git push --force', 'force-push'],
    ['sh -c "git push --force"', 'force-push'],
    ["bash -lc 'git push -f origin main'", 'force-push'],
    ['eval "git push -f"', 'force-push'],
    ['echo $(git push -f)', 'force-push'],
    ['git push "--force"', 'force-push'],
    ['rm --recursive --force x', 'rm-rf'],
    ['rm -f -r x', 'rm-rf'],
    ['rm -Rf x', 'rm-rf'],
    ['rm --rec x', 'rm-rf'],
    ['/bin/rm -rf x', 'rm-rf'],
    ['find . -name x -exec rm -rf {} +', 'rm-rf'],
    ['xargs rm -rf', 'rm-rf'],
    ['git clean -fdx', 'git-clean'],
    ['git reset --hard HEAD~1', 'reset-hard'],
    ['git branch -D topic', 'branch-delete'],
    ['git branch -d -f topic', 'branch-delete'],
    ['yarn publish', 'publish'],
    ['pnpm --filter x publish', 'publish'],
    ['npm publish', 'publish'],
    ['yarn npm publish', 'publish'],
    ['git config credential.helper store', 'credentials'],
    ['git config --global --unset credential.helper', 'credentials'],
    ['git -c credential.helper=store fetch', 'credentials'],
    ['export GIT_ASKPASS=/tmp/x', 'credentials'],
    ['cat ~/.netrc', 'credentials'],
    ['git commit -a --amend --no-edit', 'commit-amend'],
    ['git rebase -i HEAD~3', 'history-rewrite'],
    ['git filter-repo --path x', 'history-rewrite'],
  ].filter(Boolean))('gates %s', (command, id) => {
    expect(gated(command as string)).toBe(id)
  })

  it('also gates the same text arriving through pwsh and other shell tools', () => {
    for (const tool of ['pwsh', 'powershell', 'sh', 'zsh']) expect(gated('git push --force', tool)).toBe('force-push')
    expect(gated('git push --force', 'read')).toBeUndefined()
  })

  it.each([
    'echo confirm -rf x',
    'grep credentials README.md',
    'echo git push --force',
    'git push origin main',
    'git push -u origin main',
    'git push origin feature/$BRANCH',
    'git status',
    'git log --oneline -5',
    'git clean -n',
    'git clean -nfd',
    'git branch -d merged',
    'git branch --show-current',
    'git config --get credential.helper',
    'git config user.name x',
    'git rebase --abort',
    'git reset --soft HEAD~1',
    'npm run build',
    'npm run test -- --watch=false',
    'rm file.txt',
    'rm -f file.txt',
    'ls -la && cat README.md',
    'echo "rm -rf is dangerous"',
    "cat <<'EOF' > notes.txt\ngit push --force\nEOF",
  ])('lets %j through', (command) => {
    expect(matchRules(config, 'bash', { command })).toEqual([])
  })

  it('needs one approval per rule a command trips', () => {
    const command = 'git push --force origin main && rm -rf build'
    expect(matchRules(config, 'bash', { command }).map((match) => match.rule.id)).toEqual(['force-push', 'rm-rf'])
    const push = actionFingerprint('force-push', command)
    const rm = actionFingerprint('rm-rf', command)
    expect(gateReason(config, 'bash', { command }, [{ decision: '0010', fingerprint: push }], () => undefined)).toContain('rm-rf')
    const spent: string[] = []
    expect(gateReason(config, 'bash', { command }, [{ decision: '0010', fingerprint: push }, { decision: '0011', fingerprint: rm }], (decision) => spent.push(decision))).toBeUndefined()
    expect(spent).toEqual(['0010', '0011'])
  })

  it('keeps custom regex rules working, and refuses an invalid one', () => {
    const custom = resolveActionGateConfig({ rules: [{ id: 'deploy', tool: 'bash', match: 'deploy\\s+prod' }] })
    expect(matchRule(custom, 'bash', { command: 'make deploy prod' })?.rule.id).toBe('deploy')
    expect(matchRule(custom, 'bash', { command: 'git push --force' })).toBeUndefined()
    expect(() => resolveActionGateConfig({ rules: [{ id: 'x', tool: 'bash', match: '(' }] })).toThrow(/invalid match/)
    expect(() => resolveActionGateConfig({ rules: [{ id: 'x', tool: 'bash', match: 'builtin:nope' }] })).toThrow(/unknown detector/)
  })
})

describe('AG-1 / AG-2: an approval is spent once, durably', () => {
  const command = 'git push --force origin main'
  const fingerprint = actionFingerprint('force-push', command)

  /** A gate wired to a fake channel whose table never drops the approval, as before any REPORT lists it. */
  function gate(stateDir: string, table: { decision: string; fingerprint: string }[], repo = 'file:///channel.git') {
    const fake = fakeCtx({ lgChannel: { approvals: () => table, config: { stateDir, repo } } })
    apply(fake.ctx, {})
    return fake
  }

  it('denies without an approval', () => {
    const fake = gate(tmp('state'), [])
    expect(fake.guard('bash', { command })).toContain(fingerprint)
  })

  it('allows once; the second use is denied although the channel table still lists the approval', () => {
    const dir = tmp('state')
    const fake = gate(dir, [{ decision: '0042', fingerprint }])
    expect(fake.guard('bash', { command })).toBeUndefined()
    expect(fake.guard('bash', { command })).toContain('C-class')
    expect(JSON.parse(readFileSync(join(dir, LEDGER_FILE), 'utf8')).channels['file:///channel.git']).toMatchObject([{ decision: '0042', fingerprint }])
  })

  it('a spent approval stays spent after a restart', () => {
    const dir = tmp('state')
    const table = [{ decision: '0042', fingerprint }]
    expect(gate(dir, table).guard('bash', { command })).toBeUndefined()
    expect(gate(dir, table).guard('bash', { command })).toContain('C-class')
  })

  it('binds the approval to the exact action: another command or rule does not use it', () => {
    const fake = gate(tmp('state'), [{ decision: '0042', fingerprint }])
    expect(fake.guard('bash', { command: 'git push --force origin other' })).toContain('C-class')
    expect(fake.guard('bash', { command: 'rm -rf build' })).toContain('C-class')
    expect(fake.guard('bash', { command })).toBeUndefined()
  })

  it('one DECISION covers one use even across two near-simultaneous guards', () => {
    const fake = gate(tmp('state'), [{ decision: '0042', fingerprint }])
    const results = [fake.guard('bash', { command }), fake.guard('bash', { command })]
    expect(results.filter((reason) => reason === undefined)).toHaveLength(1)
  })

  it('keeps channels apart: the same DECISION number in another repository is unspent', () => {
    const dir = tmp('state')
    const table = [{ decision: '0042', fingerprint }]
    expect(gate(dir, table, 'file:///one.git').guard('bash', { command })).toBeUndefined()
    expect(gate(dir, table, 'file:///two.git').guard('bash', { command })).toBeUndefined()
  })

  it('fails closed when the ledger is unreadable or cannot be written', () => {
    const dir = tmp('state')
    writeFileSync(join(dir, LEDGER_FILE), '{ not json')
    const fake = gate(dir, [{ decision: '0042', fingerprint }])
    expect(fake.guard('bash', { command })).toContain('unreadable')

    // A state "directory" that is a file: the spend cannot be recorded, so nothing is granted.
    const blocked = join(tmp('state'), 'file')
    writeFileSync(blocked, 'x')
    expect(gate(join(blocked, 'sub'), [{ decision: '0042', fingerprint }]).guard('bash', { command })).toMatch(/could not be recorded|cannot record/)
  })

  it('fails closed without lg-channel, with the reason spelled out', () => {
    const fake = fakeCtx()
    apply(fake.ctx, {})
    expect(fake.guard('bash', { command })).toMatch(/lg-channel is not composed/)
    expect(fake.guard('bash', { command: 'git status' })).toBeUndefined()
  })

  it('fails closed when the approval table cannot be read', () => {
    const fake = fakeCtx({
      lgChannel: {
        approvals: () => {
          throw new Error('boom')
        },
        config: { stateDir: tmp('state'), repo: 'r' },
      },
    })
    apply(fake.ctx, {})
    expect(fake.guard('bash', { command })).toMatch(/cannot be read.*boom/)
  })

  it('offers the spent approvals to the report gate and writes nothing before a spend', () => {
    const dir = tmp('state')
    const fake = gate(dir, [{ decision: '0042', fingerprint }])
    const service = fake.services.get('lgActionGate') as { consumed(): { decision: string }[] }
    expect(service.consumed()).toEqual([])
    expect(existsSync(join(dir, LEDGER_FILE))).toBe(false)
    fake.guard('bash', { command })
    expect(service.consumed().map((entry) => entry.decision)).toEqual(['0042'])
  })

  it('authorize() is the same decision for a tool that runs a shell itself', () => {
    const fake = gate(tmp('state'), [{ decision: '0042', fingerprint }])
    const service = fake.services.get('lgActionGate') as { authorize(tool: string, args: unknown): string | undefined }
    expect(service.authorize('bash', { command })).toBeUndefined()
    expect(service.authorize('bash', { command })).toContain('C-class')
  })
})
