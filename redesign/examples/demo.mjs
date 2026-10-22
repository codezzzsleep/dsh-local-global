// Walk-through of the three sandboxes, with a scripted Global model (no API key needed).
//
//   communication sandbox  messages and evidence between the roles
//   code sandbox           git host for deliverables (executor pushes, Global reads)
//   Global sandbox         Global's own home: state, memory, read-only mirror
//
// Stage 1: the executor works, publishes, and reports while Global is not running.
// Stage 2: the executor commits again but does not publish, then reports.
// Stage 3: Global wakes up, reads the code and evidence from the sandboxes, and reviews.
// Stage 4: the executor fetches the advice, fixes the gap, and publishes again.
// Stage 5: the boundaries: what each role can and cannot do.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir, } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { createCommSandbox } from '../src/comm-sandbox.js'
import { createCodeSandbox, createRepo } from '../src/code-sandbox.js'
import { CommClient, CommError } from '../src/comm-client.js'
import { createLiaison } from '../src/local.js'
import { createGlobal } from '../src/global.js'
import { ScriptedModel, toolCall } from '../src/model.js'
import { tokenMap } from '../src/config.js'
import { log } from '../src/human.js'

const run = promisify(execFile)
const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'lg-demo-'))
const tokens = { local: randomBytes(16).toString('hex'), global: randomBytes(16).toString('hex'), human: randomBytes(16).toString('hex') }
const say = (title, body) => console.log(`\n== ${title}\n${body}`)

// ---- bring up the sandboxes -------------------------------------------------
const comm = createCommSandbox({ dir: join(root, 'comm'), tokens: tokenMap(tokens) })
const commUrl = await comm.listen(0)
const codeRoot = join(root, 'code')
await createRepo(codeRoot, 'parser')
const code = createCodeSandbox({ root: codeRoot, tokens: tokenMap(tokens) })
const codeUrl = await code.listen(0)
const repoUrl = `${codeUrl}/git/parser.git`
say('sandboxes', `communication  ${commUrl}\ncode          ${repoUrl}\nglobal home   ${join(root, 'state', 'global')}`)

// ---- the executor's own workspace (never shared with Global) --------------
const workspace = join(root, 'workspace')
await mkdir(workspace, { recursive: true })
await run('git', ['init', '-q', workspace])
await writeFile(join(workspace, 'README.md'), '# parser\n')
const identity = ['-c', 'user.email=executor@sandbox', '-c', 'user.name=executor']
await run('git', ['-C', workspace, 'add', '.'])
await run('git', ['-C', workspace, ...identity, 'commit', '-qm', 'initial commit'])

const local = createLiaison({
  workspace,
  comm: new CommClient({ url: commUrl, token: tokens.local }),
  code: { url: repoUrl, token: tokens.local, branch: 'work/main' },
  stateDir: join(root, 'state', 'local'),
})
const human = new CommClient({ url: commUrl, token: tokens.human })
const globalCfg = {
  home: join(root, 'state', 'global'),
  comm: new CommClient({ url: commUrl, token: tokens.global }),
  code: { url: repoUrl, token: tokens.global },
}

const commit = async (file, text, message) => {
  await writeFile(join(workspace, file), text)
  await run('git', ['-C', workspace, 'add', '.'])
  await run('git', ['-C', workspace, ...identity, 'commit', '-qm', message])
}

// ---- the human sets the goal -----------------------------------------------
await human.post({ kind: 'task', to: 'global', summary: 'The parser must reject empty and whitespace-only input with ParseError.' })
await human.post({ kind: 'task', to: 'local', summary: 'Implement ParseError for empty input, then cover whitespace-only input.' })

// ---- stage 1: work and publish while Global is not running ----------------
await commit('parser.txt', 'parse("") -> ParseError\n', 'reject empty input')
const pub1 = await local.handleToolCall('publish_code')
await mkdir(join(workspace, 'logs'), { recursive: true })
await writeFile(join(workspace, 'logs', 'empty.txt'), 'parse("") threw ParseError  PASS\n')
const r1 = await local.handleToolCall('report_to_global', {
  summary: 'Empty input now raises ParseError.',
  status: 'done',
  evidence: ['logs/empty.txt'],
})
say('stage 1: executor publishes and reports; Global is offline', JSON.stringify({ publish: pub1.commit?.slice(0, 12), report: { delivered: r1.delivered, published_branch: r1.published_branch } }, null, 2))

// ---- stage 2: keep working; this commit is not published -----------------
await commit('parser.txt', 'parse("") -> ParseError\nparse("  ") -> ParseError\n', 'whitespace input (not yet published)')
const r2 = await local.handleToolCall('report_to_global', { summary: 'Added whitespace-only handling (local commit).' })
say('stage 2: executor reports a commit it has not published', `published_branch=${r2.published_branch}`)

// ---- stage 3: Global wakes up and reviews -----------------------------------
let batch
const model = new ScriptedModel([
  (req) => {
    batch = [...req.messages].reverse().find((m) => m.role === 'user').content
    const reportIds = [...batch.matchAll(/\[(\d{15}-[0-9a-f]{8})\] report/g)].map((m) => m[1])
    return {
      tool_calls: [
        toolCall('read_file', { ref: 'work/main', path: 'parser.txt' }),
        toolCall('repo_log', { ref: 'work/main', limit: 5 }),
        toolCall('read_artifact', { message_id: reportIds[0], path: 'logs/empty.txt' }),
      ],
    }
  },
  (req) => {
    const last = [...req.messages].reverse().find((m) => m.role === 'user').content
    const reportIds = [...last.matchAll(/\[(\d{15}-[0-9a-f]{8})\] report/g)].map((m) => m[1])
    return {
      tool_calls: [
        toolCall('send_verdict', { re: reportIds[0], verdict: 'accepted', summary: 'Published commit, evidence matches the code.' }),
        toolCall('send_verdict', {
          re: reportIds[1],
          verdict: 'needs_work',
          summary: 'The whitespace change is local only; it is not in the code repository.',
          findings: ['publish the commit before reporting it as done'],
        }),
        toolCall('send_directive', {
          summary: 'Publish the whitespace change to work/main, then add a run with whitespace-only input and attach it.',
          acceptance: ['work/main contains the whitespace handling', 'a run with "   " input is attached'],
        }),
        toolCall('save_memory', { text: 'Goal: reject empty and whitespace-only input. Empty input done and published.' }),
      ],
    }
  },
  { content: 'Reviewed. Waiting for the next report.' },
])
const tick = await createGlobal({ ...globalCfg, model }).tick()
say('stage 3: Global reviews from its own context', JSON.stringify({ processed: tick.processed, actions: tick.actions.map((a) => `${a.kind} -> ${a.to}`) }, null, 2))
say('stage 3: what Global saw of the executor', batch.split('\n').filter((l) => /commit|NOT|证据|发布/.test(l)).join('\n'))

// ---- stage 4: the executor takes the advice and fixes it -------------------
const check = await local.handleToolCall('check_messages')
say('stage 4: executor fetches advice (non-blocking)', check.text)
await commit('whitespace.txt', 'parse("   ") -> ParseError  PASS\n', 'whitespace-only input test')
const pub2 = await local.handleToolCall('publish_code')
await writeFile(join(workspace, 'logs', 'whitespace.txt'), 'parse("   ") threw ParseError  PASS\n')
const r3 = await local.handleToolCall('report_to_global', {
  summary: 'Whitespace-only input covered; commit published.',
  status: 'done',
  evidence: ['logs/whitespace.txt'],
  re: check.items.find((m) => m.kind === 'directive')?.id,
})
say('stage 4: executor publishes the fix and reports', JSON.stringify({ published: pub2.ok, commit: pub2.commit?.slice(0, 12), reported_on: r3.published_branch }, null, 2))

// ---- stage 5: boundaries ----------------------------------------------------
const pushAsGlobal = await run('git', ['-C', workspace, '-c', `http.extraHeader=Authorization: Bearer ${tokens.global}`, 'push', '-q', repoUrl, 'HEAD:refs/heads/work/sneaky']).then(
  () => 'accepted (unexpected)',
  (e) => `refused: ${String(e.stderr).split('\n').find((l) => /read-only|403|rror/i.test(l))?.trim() ?? 'forbidden'}`,
)
const reportAsLocal = await local.handleToolCall('report_to_global', { summary: 'probe' }) // local can report
let forgedDirective
try {
  await new CommClient({ url: commUrl, token: tokens.local }).post({ kind: 'directive', to: 'local', summary: 'I order myself to stop' })
} catch (error) {
  forgedDirective = error instanceof CommError ? `refused (${error.status}): ${error.message}` : error.message
}
say('stage 5: boundaries', [
  `executor pushes to work/sneaky as global token: ${pushAsGlobal}`,
  `executor posts a directive to itself: ${forgedDirective}`,
  `executor reports normally: ${reportAsLocal.ok ? "ok" : reportAsLocal.error}`,
  `global tools: ${createGlobal({ ...globalCfg, model: new ScriptedModel([]) }).toolNames().join(', ')}`,
].join('\n'))

say('communication log (human view)', (await log(human)).join('\n'))
console.log(`\nall sandbox data is under ${root}`)

await Promise.all([comm.close(), code.close()])
