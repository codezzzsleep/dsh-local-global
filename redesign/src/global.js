/**
 * Global side: an independent reviewer that runs inside its own sandbox.
 *
 * Its context is assembled from four separate sources, none of which is the
 * executor's conversation:
 *   1. its own role prompt and memory notes,
 *   2. the briefs the human has given it,
 *   3. the state of the code repository (read-only mirror, via git),
 *   4. its own history of ticks.
 *
 * Its tools only reach the communication sandbox (messages and evidence), the
 * code sandbox mirror (git objects), and its own state. No tool takes an
 * absolute path, and the process is given no workspace path or executor token.
 */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { safeRelative, sha256 } from './artifacts.js'
import { git, gitOk } from './git.js'
import { exists, readJson, writeJsonAtomic } from './fsutil.js'
import { COMMIT_RE, VERDICTS, WORK_BRANCH_RE } from './protocol.js'

const READ_LIMIT = 20_000
const BODY_IN_PROMPT = 4_000
const MEMORY_LIMIT = 8_000
const BRIEF_LIMIT = 20
const DECLARED_LIMIT = 200
const REF_RE = /^[A-Za-z0-9._/-]{1,100}$/

export const GLOBAL_SYSTEM_PROMPT = `你是 Global：一个远程的审阅者，像项目负责人一样工作。你没有执行者的上下文，你只知道下面这些：你自己的记忆、人交给你的任务、交付代码库的当前状态，以及执行者发来的消息和证据。

工作方式：
- 执行者的汇报是声明，不是事实。结论要靠证据：用 read_file 读代码库里的文件，用 read_artifact 读汇报附带的证据。
- 报告里的 commit 要在代码库里核对。标为 NOT PRESENT 或 "published on ...: NO" 的，不能当作已交付。
- 你的意见是建议。需要纠偏时用 send_directive 写清目标和验收标准；不要替执行者动手，也不要要求它停下。
- 对汇报给出结论用 send_verdict：accepted（证据充分）、needs_work（有具体问题，列在 findings 里）、unverified（证据不够，说明缺什么）。
- 只有确实需要人决定时才用 flag_human：范围或优先级冲突、有风险的操作、证据不一致或被篡改、连续失败。日常进展不要升级给人。
- 每一批新消息都要有回应，或者明确说明不需要回应。
- 你没有 shell，也看不到执行者的工作区，也拿不到它的凭据。
- 用 save_memory 记住跨轮次有用的项目状态（目标、已定的决定、未决的问题）。`

const SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取交付代码库中某个分支或 commit 下的文件。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '分支名（如 work/main）或完整 40 位 commit sha' },
          path: { type: 'string', description: '仓库内的相对路径' },
        },
        required: ['ref', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_log',
      description: '查看交付代码库某个分支或 commit 的最近提交。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          limit: { type: 'integer', description: '1 到 50，默认 10' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_artifact',
      description: '读取某条消息附带的证据文件。只能读取该消息声明过的路径，并校验哈希。',
      parameters: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['message_id', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_directive',
      description: '给执行者发送指令。写清目标；需要时列出验收标准。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          body: { type: 'string' },
          re: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_verdict',
      description: '对某条汇报给出结论。',
      parameters: {
        type: 'object',
        properties: {
          re: { type: 'string', description: '被评判的消息 id' },
          verdict: { type: 'string', enum: [...VERDICTS] },
          summary: { type: 'string' },
          findings: { type: 'array', items: { type: 'string' } },
          body: { type: 'string' },
        },
        required: ['re', 'verdict', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'flag_human',
      description: '把需要人决定的事升级给人。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' }, body: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: '替换你的记忆笔记。',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
]

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text
}

/** The last `limit` messages, starting at a user turn so tool results keep their calls. */
export function windowFrom(history, limit) {
  let start = Math.max(0, history.length - limit)
  while (start < history.length && history[start].role !== 'user') start++
  return history.slice(start)
}

/** A ref the mirror understands: a full commit, or a branch under refs/remotes/code. */
function refspec(ref) {
  if (typeof ref !== 'string' || ref === '') throw new Error('ref is required')
  if (COMMIT_RE.test(ref)) return ref
  if (!REF_RE.test(ref) || ref.includes('..') || ref.startsWith('-') || ref.endsWith('/')) {
    throw new Error(`invalid ref: ${ref}`)
  }
  return `refs/remotes/code/${ref}`
}

/**
 * @param {{
 *   home: string,
 *   comm: import('./comm-client.js').CommClient,
 *   code: { url: string, token: string },
 *   model: { chat(req: object): Promise<object> },
 *   maxSteps?: number,
 *   historyLimit?: number,
 * }} config
 */
export function createGlobal({ home, comm, code, model, maxSteps = 8, historyLimit = 60 }) {
  const stateFile = join(home, 'state.json')
  const mirror = join(home, 'mirror.git')

  async function loadState() {
    const saved = await readJson(stateFile, {})
    return {
      seen: saved.seen ?? [],
      brief: saved.brief ?? [],
      memory: saved.memory ?? '',
      history: saved.history ?? [],
      declared: saved.declared ?? {},
    }
  }

  const saveState = (state) => writeJsonAtomic(stateFile, state)

  /** Fetch the code repository into the read-only mirror. */
  async function syncMirror() {
    await mkdir(home, { recursive: true })
    if (!(await exists(join(mirror, 'HEAD')))) await git(['init', '--bare', '-q', mirror])
    await git(['fetch', '--prune', '--quiet', code.url, '+refs/heads/*:refs/remotes/code/*'], {
      cwd: mirror,
      token: code.token,
    })
  }

  const commitPresent = (sha) => gitOk(['cat-file', '-e', `${sha}^{commit}`], { cwd: mirror })
  const commitOnBranch = (sha, branch) =>
    gitOk(['merge-base', '--is-ancestor', sha, `refs/remotes/code/${branch}`], { cwd: mirror })

  async function projectSnapshot(synced) {
    if (!synced) return '（代码库无法同步，代码状态未知）'
    const { stdout } = await git(
      ['for-each-ref', '--format=%(refname:short) %(objectname:short) %(subject)', 'refs/remotes/code'],
      { cwd: mirror },
    ).catch(() => ({ stdout: '' }))
    return stdout.trim() || '（代码库还没有任何分支）'
  }

  async function systemPrompt(state, synced) {
    const brief = state.brief.length
      ? state.brief.map((b) => `- [${b.id}] ${b.summary}${b.body ? `\n  ${truncate(b.body, 800)}` : ''}`).join('\n')
      : '（暂无）'
    return [
      GLOBAL_SYSTEM_PROMPT,
      `## 你的记忆笔记\n${state.memory || '（空）'}`,
      `## 人交给你的任务与备注\n${brief}`,
      `## 交付代码库的当前状态\n${await projectSnapshot(synced)}`,
    ].join('\n\n')
  }

  /** The text Global reads for a batch of new messages. */
  async function renderBatch(items, synced, syncError) {
    const parts = [`${items.length} 条新消息：`]
    if (!synced) parts.push(`（代码库同步失败：${syncError}）`)
    parts.push('')
    for (const m of items) {
      const head = [`[${m.id}] ${m.kind} from ${m.from}`]
      if (m.re) head.push(`re ${m.re}`)
      if (m.status) head.push(`status ${m.status}`)
      parts.push(head.join(' · '))
      parts.push(`summary: ${m.summary}`)
      if (m.body) parts.push(truncate(m.body, BODY_IN_PROMPT))

      if (m.commit && COMMIT_RE.test(m.commit)) {
        let presence = '无法核对（代码库未同步）'
        if (synced) presence = (await commitPresent(m.commit)) ? '在代码库中存在' : 'NOT PRESENT：代码库中没有这个 commit'
        let published = '（未发布到代码库）'
        if (m.published_branch && WORK_BRANCH_RE.test(m.published_branch)) {
          const ok = synced && (await commitOnBranch(m.commit, m.published_branch))
          published = `（发布到 ${m.published_branch}：${synced ? (ok ? '是' : 'NO，不在该分支上') : '未知'}）`
        }
        parts.push(`commit ${m.commit}：${presence} ${published}`)
      }
      if (m.dirty) parts.push('注意：执行者汇报时工作区有未提交的改动。')
      for (const a of m.artifacts ?? []) {
        parts.push(`  证据 ${a.path}（${a.bytes} 字节，sha256 ${a.sha256.slice(0, 12)}…）— 用 read_artifact 读取`)
      }
      parts.push('')
    }
    return parts.join('\n')
  }

  async function readArtifact(args, state) {
    const id = String(args.message_id ?? '')
    const declared = state.declared[id]
    if (!declared) return { ok: false, error: '这条消息没有已记录的证据' }
    const rel = safeRelative(String(args.path ?? ''))
    const entry = declared.find((a) => a.path === rel)
    if (!entry) return { ok: false, error: '该消息没有声明这个路径' }

    let data
    try {
      data = await comm.artifact(id, rel)
    } catch (error) {
      return { ok: false, error: `无法获取证据：${error.message}` }
    }
    if (sha256(data) !== entry.sha256) {
      return { ok: false, error: '证据校验失败：内容与发布时记录的哈希不符，不要依赖它' }
    }
    const text = data.toString('utf8')
    return { ok: true, path: rel, bytes: data.length, truncated: text.length > READ_LIMIT, content: text.slice(0, READ_LIMIT) }
  }

  async function readFile(args) {
    const spec = refspec(String(args.ref ?? ''))
    const rel = safeRelative(String(args.path ?? ''))
    const { stdout } = await git(['show', `${spec}:${rel}`], { cwd: mirror })
    return {
      ok: true,
      ref: args.ref,
      path: rel,
      truncated: stdout.length > READ_LIMIT,
      content: stdout.slice(0, READ_LIMIT),
    }
  }

  async function repoLog(args) {
    const spec = refspec(String(args.ref ?? ''))
    const limit = Math.min(50, Math.max(1, Number.parseInt(args.limit ?? 10, 10) || 10))
    const { stdout } = await git(['log', '-n', String(limit), '--format=%h%x09%an%x09%s', spec], { cwd: mirror })
    return { ok: true, ref: args.ref, commits: stdout.trim().split('\n').filter(Boolean) }
  }

  /**
   * Send a message to the communication sandbox. The client_id is derived from
   * the batch and the action's position, so a retried tick reuses the same
   * message instead of duplicating it.
   */
  async function send(ctx, fields) {
    const clientId = `${ctx.batchKey}:${ctx.actions.length}`
    const result = await comm.post({ ...fields, client_id: clientId })
    const duplicate = Boolean(result.duplicate)
    ctx.actions.push({ kind: fields.kind, to: fields.to, id: result.id, duplicate })
    return { ok: true, id: result.id, duplicate }
  }

  async function execute(call, ctx) {
    const fail = (error) => JSON.stringify({ ok: false, error })
    let args
    try {
      args = JSON.parse(call?.function?.arguments || '{}')
    } catch {
      return fail('arguments are not valid JSON')
    }
    if (typeof args !== 'object' || args === null) return fail('arguments must be an object')

    try {
      switch (call.function.name) {
        case 'read_file':
          return JSON.stringify(await readFile(args))
        case 'repo_log':
          return JSON.stringify(await repoLog(args))
        case 'read_artifact':
          return JSON.stringify(await readArtifact(args, ctx.state))
        case 'send_directive':
          return JSON.stringify(
            await send(ctx, { kind: 'directive', to: 'local', summary: args.summary, body: args.body, re: args.re, acceptance: args.acceptance }),
          )
        case 'send_verdict':
          return JSON.stringify(
            await send(ctx, {
              kind: 'verdict',
              to: 'local',
              re: args.re,
              verdict: args.verdict,
              summary: args.summary,
              body: args.body,
              findings: args.findings,
            }),
          )
        case 'flag_human':
          return JSON.stringify(await send(ctx, { kind: 'flag', to: 'human', summary: args.summary, body: args.body }))
        case 'save_memory':
          ctx.state.memory = String(args.text ?? '').slice(0, MEMORY_LIMIT)
          return JSON.stringify({ ok: true, saved_chars: ctx.state.memory.length })
        default:
          return fail(`unknown tool: ${call.function.name}`)
      }
    } catch (error) {
      return fail(error.message)
    }
  }

  /** Returns true if the step limit was reached before the model stopped calling tools. */
  async function runModel(ctx) {
    for (let step = 0; step < maxSteps; step++) {
      const reply = await model.chat({
        messages: [
          { role: 'system', content: await systemPrompt(ctx.state, ctx.synced) },
          ...windowFrom(ctx.state.history, historyLimit),
        ],
        tools: SCHEMAS,
      })
      const assistant = { role: 'assistant', content: reply.content ?? '' }
      if (reply.tool_calls?.length) assistant.tool_calls = reply.tool_calls
      ctx.state.history.push(assistant)

      if (!reply.tool_calls?.length) return false
      for (const call of reply.tool_calls) {
        const output = await execute(call, ctx)
        ctx.state.history.push({ role: 'tool', tool_call_id: call.id, content: output })
      }
    }
    return true
  }

  /**
   * Process everything new for Global. With nothing new it makes no model call.
   * If the model fails, the state is restored and the batch is retried later.
   */
  async function tick() {
    const state = await loadState()
    let inbox
    try {
      inbox = await comm.inbox()
    } catch (error) {
      return { processed: 0, actions: [], error: `communication sandbox unreachable: ${error.message}` }
    }
    const seen = new Set(state.seen)
    const fresh = inbox.messages.filter((m) => !seen.has(m.id))
    if (fresh.length === 0) return { processed: 0, actions: [] }

    let synced = true
    let syncError
    try {
      await syncMirror()
    } catch (error) {
      synced = false
      syncError = error.message
    }

    const before = structuredClone(state)
    for (const m of fresh) {
      if (m.from === 'human' && (m.kind === 'task' || m.kind === 'note')) {
        state.brief.push({ id: m.id, summary: m.summary, body: m.body })
      }
      if (m.artifacts?.length) state.declared[m.id] = m.artifacts
    }
    state.brief = state.brief.slice(-BRIEF_LIMIT)
    const declaredKeys = Object.keys(state.declared)
    for (const key of declaredKeys.slice(0, Math.max(0, declaredKeys.length - DECLARED_LIMIT))) delete state.declared[key]

    const batchKey = createHash('sha256').update(fresh.map((m) => m.id).join(',')).digest('hex').slice(0, 16)
    state.history.push({ role: 'user', content: await renderBatch(fresh, synced, syncError) })

    const ctx = { state, actions: [], batchKey, synced }
    let stepLimitReached = false
    try {
      stepLimitReached = await runModel(ctx)
    } catch (error) {
      await saveState(before)
      return { processed: 0, actions: ctx.actions, error: error.message }
    }

    state.seen = [...seen, ...fresh.map((m) => m.id)]
    await saveState(state)
    return { processed: fresh.length, actions: ctx.actions, stepLimitReached, synced }
  }

  return {
    tick,
    loadState,
    toolNames: () => SCHEMAS.map((s) => s.function.name),
  }
}
