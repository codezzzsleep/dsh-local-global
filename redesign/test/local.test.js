import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createLiaison, LOCAL_TOOLS } from '../src/local.js'
import { CommClient } from '../src/comm-client.js'
import { startStack, commit } from './helpers.js'

const run = promisify(execFile)
const stacks = []
after(async () => Promise.all(stacks.map((s) => s.close())))

async function stack(label) {
  const s = await startStack(label)
  stacks.push(s)
  return s
}

test('the executor exposes exactly four liaison tools', () => {
  assert.deepEqual(
    LOCAL_TOOLS.map((t) => t.function.name),
    ['publish_code', 'report_to_global', 'ask_global', 'check_messages'],
  )
})

test('publish refuses a dirty worktree, then pushes the committed HEAD', async () => {
  const s = await stack('local-publish')
  const liaison = createLiaison(s.localConfig())
  await writeFile(join(s.workspace, 'dirty.txt'), 'not committed\n')

  const refused = await liaison.handleToolCall('publish_code')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /uncommitted/)

  await run('git', ['-C', s.workspace, 'add', '.'])
  await run('git', ['-C', s.workspace, '-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-qm', 'add dirty'])
  const published = await liaison.handleToolCall('publish_code')
  assert.equal(published.ok, true, published.error)
  assert.equal(published.branch, 'work/main')

  const { stdout } = await run('git', ['-C', s.workspace, 'rev-parse', 'HEAD'])
  const { stdout: remote } = await run('git', ['ls-remote', s.repoUrl, 'refs/heads/work/main'], {
    env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${s.tokens.human}` },
  })
  assert.match(remote, new RegExp(stdout.trim()))
})

test('a report carries the commit, says whether it was published, and uploads evidence', async () => {
  const s = await stack('local-report')
  const liaison = createLiaison(s.localConfig())
  await mkdir(join(s.workspace, 'logs'), { recursive: true })
  await writeFile(join(s.workspace, 'logs', 'test.txt'), '12 passed\n')
  const sha = await commit(s.workspace, 'feature.txt', 'feature\n', 'feature')
  await liaison.handleToolCall('publish_code')

  const result = await liaison.handleToolCall('report_to_global', {
    summary: 'feature done',
    status: 'done',
    evidence: ['logs/test.txt'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.delivered, true)
  assert.equal(result.commit, sha)
  assert.equal(result.published_branch, 'work/main')

  const { messages } = await s.client('global').inbox()
  const report = messages.find((m) => m.summary === 'feature done')
  assert.equal(report.commit, sha)
  assert.equal(report.published_branch, 'work/main')
  const bytes = await s.client('global').artifact(report.id, 'logs/test.txt')
  assert.equal(bytes.toString('utf8'), '12 passed\n')
})

test('a commit that was never published is reported as unpublished', async () => {
  const s = await stack('local-unpublished')
  const liaison = createLiaison(s.localConfig())
  await commit(s.workspace, 'local-only.txt', 'x\n', 'local only')
  const result = await liaison.handleToolCall('report_to_global', { summary: 'local only work' })
  assert.equal(result.published_branch, null)
})

test('evidence outside the workspace is refused and nothing is sent', async () => {
  const s = await stack('local-evidence')
  const liaison = createLiaison(s.localConfig())
  const result = await liaison.handleToolCall('report_to_global', {
    summary: 'tries to leak a file',
    evidence: ['../../../etc/hosts'],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /report not sent/)
  const { messages } = await s.client('global').inbox()
  assert.equal(messages.length, 0)
})

test('the executor keeps working when the communication sandbox is down, and delivers later', async () => {
  const s = await stack('local-offline')
  const dead = new CommClient({ url: 'http://127.0.0.1:1', token: s.tokens.local, timeoutMs: 2000 })
  const offline = createLiaison({ ...s.localConfig(), comm: dead })

  const queued = await offline.handleToolCall('report_to_global', { summary: 'worked while offline' })
  assert.equal(queued.ok, true)
  assert.equal(queued.delivered, false)
  assert.equal(queued.queued, true)

  // Same state directory, sandbox reachable again.
  const online = createLiaison(s.localConfig())
  const flushed = await online.flush()
  assert.equal(flushed.delivered.length, 1)
  const { messages } = await s.client('global').inbox()
  assert.equal(messages[0].summary, 'worked while offline')
})

test('directives are fetched once, without blocking, and framed as advice', async () => {
  const s = await stack('local-check')
  const liaison = createLiaison(s.localConfig())
  const empty = await liaison.handleToolCall('check_messages')
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.items, [])

  const report = await liaison.handleToolCall('report_to_global', { summary: 'r' })
  await s.client('global').post({
    kind: 'directive',
    to: 'local',
    summary: 'add the negative case',
    re: report.id,
    acceptance: ['bad input is rejected'],
  })
  const first = await liaison.handleToolCall('check_messages')
  assert.equal(first.items.length, 1)
  assert.match(first.text, /add the negative case/)
  assert.match(first.text, /acceptance: bad input is rejected/)
  assert.match(first.text, /They are advice/)

  const second = await liaison.handleToolCall('check_messages')
  assert.deepEqual(second.items, [])
})

test('an unreachable sandbox does not make check_messages hang or throw', async () => {
  const s = await stack('local-check-down')
  const liaison = createLiaison({
    ...s.localConfig(),
    comm: new CommClient({ url: 'http://127.0.0.1:1', token: s.tokens.local, timeoutMs: 2000 }),
  })
  const result = await liaison.handleToolCall('check_messages')
  assert.equal(result.ok, false)
  assert.match(result.error, /unreachable/)
})

test('bad arguments and unknown tools come back as errors', async () => {
  const s = await stack('local-args')
  const liaison = createLiaison(s.localConfig())
  assert.deepEqual(await liaison.handleToolCall('shell', {}), { ok: false, error: 'unknown tool: shell' })
  const bad = await liaison.handleToolCall('report_to_global', { summary: 'x', status: 'nonsense' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /status must be one of/)
})

test('the liaison refuses to publish to a branch outside work/', async () => {
  const s = await stack('local-branch')
  assert.throws(() => createLiaison({ ...s.localConfig(), code: { url: s.repoUrl, token: s.tokens.local, branch: 'main' } }), /work\/\*/)
})

