import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createGlobal, windowFrom } from '../src/global.js'
import { createLiaison } from '../src/local.js'
import { ScriptedModel, toolCall } from '../src/model.js'
import { startStack, commit } from './helpers.js'

const stacks = []
after(async () => Promise.all(stacks.map((s) => s.close())))

async function stack(label) {
  const s = await startStack(label)
  stacks.push(s)
  return s
}

const lastUserText = (req) => [...req.messages].reverse().find((m) => m.role === 'user').content
const firstId = (text) => text.match(/\[(\d{15}-[0-9a-f]{8})\]/)[1]
const toolResults = (req) => req.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))
const systemText = (req) => req.messages[0].content

test('global makes no model call when nothing is new', async () => {
  const s = await stack('global-idle')
  const model = new ScriptedModel([])
  const global = createGlobal({ ...s.globalConfig(), model })
  assert.deepEqual(await global.tick(), { processed: 0, actions: [] })
  assert.equal(model.requests.length, 0)
})

test('global has no shell and only sandbox-bound tools', async () => {
  const s = await stack('global-tools')
  const global = createGlobal({ ...s.globalConfig(), model: new ScriptedModel([]) })
  assert.deepEqual(global.toolNames(), [
    'read_file',
    'repo_log',
    'read_artifact',
    'send_directive',
    'send_verdict',
    'flag_human',
    'save_memory',
  ])
  assert.ok(!global.toolNames().some((n) => /shell|bash|exec|write|edit|path/.test(n)))
})

test('a full review: code state, evidence, verdict, directive, and memory', async () => {
  const s = await stack('global-loop')
  const executor = createLiaison(s.localConfig())

  // The human gives Global a brief first.
  await s.client('human').post({ kind: 'task', to: 'global', summary: 'parser must reject empty input' })

  // Executor commits, publishes, and reports with evidence.
  await commit(s.workspace, 'parser.txt', 'parse("") -> ParseError\n', 'empty input')
  await executor.handleToolCall('publish_code')
  const report = await executor.handleToolCall('report_to_global', {
    summary: 'empty input handled',
    status: 'done',
    evidence: ['README.md'],
  })
  assert.equal(report.published_branch, 'work/main')

  let batch
  let fileRead
  let artifactRead
  let logRead
  const model = new ScriptedModel([
    (req) => {
      batch = lastUserText(req)
      const id = [...batch.matchAll(/\[(\d{15}-[0-9a-f]{8})\] report/g)].map((m) => m[1]).at(-1)
      return {
        tool_calls: [
          toolCall('read_file', { ref: 'work/main', path: 'parser.txt' }),
          toolCall('repo_log', { ref: 'work/main', limit: 5 }),
          toolCall('read_artifact', { message_id: id, path: 'README.md' }),
        ],
      }
    },
    (req) => {
      const [file, log, artifact] = toolResults(req)
      fileRead = file
      logRead = log
      artifactRead = artifact
      const id = [...lastUserText(req).matchAll(/\[(\d{15}-[0-9a-f]{8})\] report/g)].map((m) => m[1]).at(-1)
      return {
        tool_calls: [
          toolCall('send_verdict', { re: id, verdict: 'accepted', summary: 'the code and evidence agree', findings: [] }),
          toolCall('send_directive', { summary: 'next: add whitespace-only input', acceptance: ['whitespace is rejected'], re: id }),
          toolCall('save_memory', { text: 'Goal: reject empty input. Done: empty input.' }),
        ],
      }
    },
    { content: 'Reviewed.' },
  ])

  const global = createGlobal({ ...s.globalConfig(), model })
  const tick = await global.tick()
  assert.equal(tick.error, undefined, tick.error)
  // Two new items in one batch: the human's brief and the executor's report.
  assert.equal(tick.processed, 2)
  assert.deepEqual(tick.actions.map((a) => [a.kind, a.to]), [['verdict', 'local'], ['directive', 'local']])

  // The brief and the code state reached Global's own context.
  assert.match(systemText(model.requests[0]), /parser must reject empty input/)
  assert.match(systemText(model.requests[0]), /work\/main/)
  // Reports are checked against the code repository, not the executor's disk.
  assert.match(batch, /commit [0-9a-f]{40}：在代码库中存在/)
  assert.match(batch, /发布到 work\/main：是/)

  assert.equal(fileRead.ok, true)
  assert.equal(fileRead.content, 'parse("") -> ParseError\n')
  assert.equal(logRead.ok, true)
  assert.ok(logRead.commits[0].includes('empty input'))
  assert.equal(artifactRead.ok, true)
  assert.equal(artifactRead.content.includes('hello'), true)

  // Local receives the verdict and the directive at its next check-in.
  const check = await executor.handleToolCall('check_messages')
  assert.deepEqual(check.items.map((m) => m.kind), ['verdict', 'directive'])
  assert.equal(check.items[0].verdict, 'accepted')

  // Global keeps its memory for the next review.
  const later = new ScriptedModel([{ content: 'noted' }])
  await executor.handleToolCall('report_to_global', { summary: 'whitespace case added' })
  await createGlobal({ ...s.globalConfig(), model: later }).tick()
  assert.match(systemText(later.requests[0]), /Goal: reject empty input/)
})

test('a commit that was never pushed is flagged as not present', async () => {
  const s = await stack('global-absent')
  const executor = createLiaison(s.localConfig())
  await commit(s.workspace, 'secret.txt', 'local only\n', 'local only')
  await executor.handleToolCall('report_to_global', { summary: 'claims finished work' })

  let batch
  const model = new ScriptedModel([
    (req) => {
      batch = lastUserText(req)
      return { content: 'checking' }
    },
  ])
  await createGlobal({ ...s.globalConfig(), model }).tick()
  assert.match(batch, /NOT PRESENT/)
  assert.match(batch, /未发布到代码库/)
})

test('tampered evidence is refused when Global tries to read it', async () => {
  const s = await stack('global-tamper')
  const executor = createLiaison(s.localConfig())
  const result = await executor.handleToolCall('report_to_global', { summary: 'tests', evidence: ['README.md'] })
  await writeFile(join(s.root, 'comm', 'artifacts', result.id, 'README.md'), 'forged')

  let observed
  const model = new ScriptedModel([
    (req) => {
      const id = firstId(lastUserText(req))
      return { tool_calls: [toolCall('read_artifact', { message_id: id, path: 'README.md' })] }
    },
    (req) => {
      observed = toolResults(req)[0]
      return { tool_calls: [toolCall('flag_human', { summary: 'evidence failed verification' })] }
    },
    { content: 'escalated' },
  ])
  await createGlobal({ ...s.globalConfig(), model }).tick()
  assert.equal(observed.ok, false)
  assert.match(observed.error, /校验失败|无法获取证据/)
  const { messages } = await s.client('human').log()
  assert.equal(messages.filter((m) => m.kind === 'flag').length, 1)
})

test('global can only read declared evidence and only inside the sandbox refs', async () => {
  const s = await stack('global-paths')
  const executor = createLiaison(s.localConfig())
  const report = await executor.handleToolCall('report_to_global', { summary: 'x', evidence: ['README.md'] })
  await commit(s.workspace, 'x.txt', 'x\n', 'x')
  await executor.handleToolCall('publish_code')

  const results = []
  const model = new ScriptedModel([
    {
      tool_calls: [
        toolCall('read_artifact', { message_id: report.id, path: '../../etc/passwd' }),
        toolCall('read_artifact', { message_id: report.id, path: 'other.txt' }),
        toolCall('read_file', { ref: 'work/main', path: '../../etc/passwd' }),
        toolCall('read_file', { ref: '--upload-pack=touch /tmp/pwned', path: 'README.md' }),
        toolCall('read_file', { ref: 'work/main', path: '/etc/passwd' }),
        toolCall('repo_log', { ref: 'work/main; rm -rf /', limit: 1 }),
      ],
    },
    (req) => {
      results.push(...toolResults(req))
      return { content: 'done' }
    },
  ])
  await createGlobal({ ...s.globalConfig(), model }).tick()
  assert.equal(results.length, 6)
  assert.ok(results.every((r) => r.ok === false), JSON.stringify(results))
})

test('a model failure restores state, and the retry does not duplicate what was already sent', async () => {
  const s = await stack('global-retry')
  const executor = createLiaison(s.localConfig())
  const report = await executor.handleToolCall('report_to_global', { summary: 'please review' })

  const failing = new ScriptedModel([
    { tool_calls: [toolCall('send_verdict', { re: report.id, verdict: 'unverified', summary: 'need logs' })] },
    () => {
      throw new Error('model HTTP 503')
    },
  ])
  const first = await createGlobal({ ...s.globalConfig(), model: failing }).tick()
  assert.match(first.error, /503/)

  const working = new ScriptedModel([
    { tool_calls: [toolCall('send_verdict', { re: report.id, verdict: 'unverified', summary: 'need logs' })] },
    { content: 'done' },
  ])
  const second = await createGlobal({ ...s.globalConfig(), model: working }).tick()
  assert.equal(second.processed, 1)
  assert.equal(second.actions[0].duplicate, true)

  const { messages } = await s.client('human').log()
  assert.equal(messages.filter((m) => m.kind === 'verdict').length, 1)
})

test('windowFrom never starts a window in the middle of a tool exchange', () => {
  const history = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: '', tool_calls: [{ id: '1' }] },
    { role: 'tool', tool_call_id: '1', content: '{}' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: 'd' },
  ]
  for (let limit = 1; limit <= history.length; limit++) {
    const window = windowFrom(history, limit)
    if (window.length) assert.equal(window[0].role, 'user', `limit ${limit}`)
  }
})
