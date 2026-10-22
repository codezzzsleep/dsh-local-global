/**
 * Local side: a liaison for a normal executor agent.
 *
 * The executor keeps its full context and tools. This module adds four tools
 * and nothing that makes the executor wait:
 *   publish_code     push a committed HEAD to the code sandbox (work/* only)
 *   report_to_global send a report with evidence (queued if the sandbox is down)
 *   ask_global       send a question
 *   check_messages   fetch new advice without blocking
 *
 * Nothing here reads Global's state, and Global cannot read this workspace:
 * it only sees what this module publishes to the two sandboxes.
 */
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readEvidence } from './artifacts.js'
import { CommError } from './comm-client.js'
import { formatForLocal } from './format.js'
import { git } from './git.js'
import { readJson, writeJsonAtomic } from './fsutil.js'
import { newId } from './ids.js'
import { STATUSES, validateMessage, WORK_BRANCH_RE } from './protocol.js'

/** Tool schemas in OpenAI function-calling format. */
export const LOCAL_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'publish_code',
      description:
        'Push your committed HEAD to the shared code repository, so the reviewer can read exactly this state. ' +
        'Commit your changes first; the worktree must be clean.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'report_to_global',
      description:
        'Tell the reviewer what you did. Attach evidence files from the workspace (logs, test output). ' +
        'Do not wait for a reply; keep working.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One or two sentences.' },
          body: { type: 'string', description: 'Optional detail in Markdown.' },
          status: { type: 'string', enum: [...STATUSES], description: 'progress, done, blocked, or objection.' },
          re: { type: 'string', description: 'Id of a message you are answering, if any.' },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'Workspace-relative paths of evidence files.',
          },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_global',
      description: 'Ask the reviewer a question. Keep working on whatever does not depend on the answer.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' }, body: { type: 'string' }, re: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_messages',
      description: 'Fetch new messages from the reviewer or the human. Returns at once, possibly with nothing.',
      parameters: { type: 'object', properties: {} },
    },
  },
])

/** Only the fields a model may set. Anything else in its arguments is dropped. */
function pick(args) {
  return { summary: args.summary, body: args.body, status: args.status, re: args.re, evidence: args.evidence }
}

/**
 * @param {{
 *   workspace: string,
 *   comm: import('./comm-client.js').CommClient,
 *   code: { url: string, token: string, branch: string },
 *   stateDir: string,
 * }} config
 */
export function createLiaison({ workspace, comm, code, stateDir }) {
  if (!WORK_BRANCH_RE.test(code.branch)) throw new Error(`branch must be a work/* branch: ${code.branch}`)

  const stateFile = join(stateDir, 'local-state.json')
  const publishedFile = join(stateDir, 'published.json')
  const outboxDir = join(stateDir, 'outbox')

  async function headCommit() {
    try {
      return (await git(['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim()
    } catch {
      return null
    }
  }

  async function isDirty() {
    return (await git(['status', '--porcelain'], { cwd: workspace })).stdout.trim() !== ''
  }

  async function publishCode() {
    try {
      if (await isDirty()) return { ok: false, error: 'the worktree has uncommitted changes; commit them before publishing' }
      const commit = await headCommit()
      if (!commit) return { ok: false, error: 'there is no commit to publish yet' }
      await git(['push', '--porcelain', code.url, `HEAD:refs/heads/${code.branch}`], {
        cwd: workspace,
        token: code.token,
      })
      await writeJsonAtomic(publishedFile, { branch: code.branch, commit })
      return { ok: true, branch: code.branch, commit }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }

  /** Send one queued message. Rejections from the sandbox are permanent and drop the entry. */
  async function deliver(clientId) {
    const file = join(outboxDir, `${clientId}.json`)
    const entry = await readJson(file, null)
    if (!entry) throw new Error(`queued message ${clientId} is missing`)
    const files = entry.files.map((f) => ({ path: f.path, data: Buffer.from(f.data, 'base64') }))
    const result = await comm.post(entry.message, files)
    await rm(file, { force: true })
    return result.id
  }

  /** Try every queued message in order. Stops at the first transient failure. */
  async function flush() {
    const result = { delivered: [], rejected: [], pending: [] }
    let names = []
    try {
      names = (await readdir(outboxDir)).filter((n) => n.endsWith('.json')).sort()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    for (let i = 0; i < names.length; i++) {
      const clientId = names[i].slice(0, -'.json'.length)
      try {
        await deliver(clientId)
        result.delivered.push(clientId)
      } catch (error) {
        if (error instanceof CommError && error.status >= 400 && error.status < 500 && error.status !== 401) {
          await rm(join(outboxDir, names[i]), { force: true })
          result.rejected.push({ id: clientId, error: error.message })
          continue
        }
        result.pending.push(...names.slice(i).map((n) => ({ id: n.slice(0, -'.json'.length), error: error.message })))
        break
      }
    }
    return result
  }

  async function report(input) {
    await flush().catch(() => {})

    let files
    try {
      files = await readEvidence({ workspace, paths: input.evidence ?? [] })
    } catch (error) {
      return { ok: false, error: `report not sent: ${error.message}` }
    }

    const clientId = newId()
    const commit = await headCommit()
    const dirty = await isDirty().catch(() => undefined)
    const published = await readJson(publishedFile, null)
    const publishedBranch = published && commit && published.commit === commit ? published.branch : undefined

    const message = JSON.parse(
      JSON.stringify({
        kind: input.kind,
        to: 'global',
        summary: input.summary,
        body: input.body,
        status: input.status,
        re: input.re,
        commit: commit ?? undefined,
        published_branch: publishedBranch,
        dirty,
        client_id: clientId,
      }),
    )
    try {
      validateMessage({ ...message, from: 'local', artifacts: [] })
    } catch (error) {
      return { ok: false, error: `report not sent: ${error.message}` }
    }

    await mkdir(outboxDir, { recursive: true })
    await writeJsonAtomic(join(outboxDir, `${clientId}.json`), {
      message,
      files: files.map((f) => ({ path: f.path, data: f.data.toString('base64') })),
    })

    try {
      const id = await deliver(clientId)
      return { ok: true, id, delivered: true, commit: commit ?? null, published_branch: publishedBranch ?? null }
    } catch (error) {
      return {
        ok: true,
        id: clientId,
        delivered: false,
        queued: true,
        reason: error.message,
        note: 'Saved locally; it will reach the reviewer when the communication sandbox is reachable. Keep working.',
      }
    }
  }

  async function checkMessages() {
    const flushed = await flush().catch((error) => ({ pending: [{ error: error.message }] }))
    let inbox
    try {
      inbox = await comm.inbox()
    } catch (error) {
      return { ok: false, error: `communication sandbox unreachable: ${error.message}`, items: [], text: '' }
    }
    const state = await readJson(stateFile, { seen: [] })
    const seen = new Set(state.seen)
    const fresh = inbox.messages.filter((m) => !seen.has(m.id))
    if (fresh.length > 0) {
      state.seen = [...seen, ...fresh.map((m) => m.id)]
      await writeJsonAtomic(stateFile, state)
    }
    return {
      ok: true,
      items: fresh,
      text: formatForLocal(fresh),
      outbox_pending: flushed.pending.length,
    }
  }

  /** Dispatch a tool call. Always resolves to a plain object, never throws. */
  async function handleToolCall(name, args = {}) {
    try {
      switch (name) {
        case 'publish_code':
          return await publishCode()
        case 'report_to_global':
          return await report({ ...pick(args), kind: 'report' })
        case 'ask_global':
          return await report({ ...pick(args), kind: 'question' })
        case 'check_messages':
          return await checkMessages()
        default:
          return { ok: false, error: `unknown tool: ${name}` }
      }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }

  return {
    publishCode,
    report,
    checkMessages,
    flush,
    handleToolCall,
    toolDefinitions: () => LOCAL_TOOLS,
  }
}
