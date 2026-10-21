/**
 * `lg-evidence` — export the raw event log of a real session.
 *
 * Session-acceptance evidence must be the original events, not a summary: the
 * reviewer has to see the model-issued `tool/call` and the `tool/result` that
 * came back (SPEC "测试与证据要求", QA-4). dsh keeps every session as a
 * `session.v4.jsonl[.zstd]` file under `$DSH_HOME/sessions/<workspace>/<id>/`;
 * this tool decompresses that file byte for byte and writes it out unchanged.
 *
 * The Global session may only write inside `writeRoots`, so `out` is normally a
 * path under `drafts/`; Local copies the artifact into `evidence/` afterwards.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { isInside, sessionCwd } from './scope.js'
import { zstdDecompressSync } from 'node:zlib'

import type { Context } from '@deepseek-ai/cordis'

export const name = 'lg-evidence'
export const inject = ['tools']

/** One decompressed session file, ready to be written out. */
interface SessionArtifact {
  readonly sessionId: string
  readonly source: string
  readonly jsonl: string
}

/** Where dsh keeps session event logs. */
function sessionsRoot(): string {
  const home = process.env['DSH_HOME']
  return join(home === undefined || home.length === 0 ? join(homedir(), '.dsh') : home, 'sessions')
}

/** Read the session id dsh recorded for this agent. */
function sessionId(agent: unknown): string | undefined {
  const session = (agent as { session?: Record<string, unknown> } | undefined)?.session
  if (session === undefined) return undefined
  const header = session['header'] as Record<string, unknown> | undefined
  for (const candidate of [header?.['id'], session['id'], header?.['sessionId']]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Find and decompress one session's event log.
 *
 * The workspace slug in the path is derived from the working directory, and
 * guessing it would be brittle, so this walks the two levels under the sessions
 * root looking for a directory named after the session.
 * @param root - `$DSH_HOME/sessions`.
 * @param id - session identity.
 * @returns the artifact, or an explanatory error.
 */
async function readSessionArtifact(root: string, id: string): Promise<SessionArtifact | string> {
  let workspaces: string[]
  try {
    workspaces = await readdir(root)
  } catch {
    return `lg_evidence_session: no session store at ${root}`
  }
  for (const workspace of workspaces) {
    const candidate = join(root, workspace, id)
    try {
      const info = await stat(candidate)
      if (!info.isDirectory()) continue
    } catch {
      continue
    }
    for (const filename of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']) {
      const source = join(candidate, filename)
      try {
        const raw = await readFile(source)
        const jsonl = filename.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
        return { sessionId: id, source, jsonl }
      } catch {
        continue
      }
    }
  }
  return `lg_evidence_session: no event log for session ${id} under ${root}`
}

export function apply(ctx: Context): void {
  ctx.tools.register({
    name: 'lg_evidence_session',
    description:
      'Export the raw event log of this session as JSONL: every tool call the model issued and every result, byte for byte. Use it for session-acceptance evidence (QA-4).',
    parameters: {
      type: 'object',
      properties: {
        out: { type: 'string', description: 'File to write the events to, e.g. drafts/evidence/session.jsonl' },
        session: { type: 'string', description: 'Session id; defaults to the calling session' },
      },
      required: ['out'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          session: { type: 'string' },
          source: { type: 'string' },
          bytes: { type: 'number' },
          events: { type: 'number' },
          sha256: { type: 'string' },
        },
        required: ['file', 'session', 'source', 'bytes', 'events', 'sha256'],
      },
      render: (_args: unknown, value: unknown) => {
        const result = value as { events?: unknown; bytes?: unknown; sha256?: unknown; file?: unknown }
        return [
          {
            type: 'text' as const,
            text: `exported ${String(result.events)} events (${String(result.bytes)} bytes, sha256 ${String(result.sha256).slice(0, 12)}…) to ${String(result.file)}`,
          },
        ]
      },
    },
    async execute(args: unknown, exec: { agent?: unknown }) {
      const input = args as { out?: unknown; session?: unknown }
      if (typeof input.out !== 'string' || input.out.length === 0) {
        throw new TypeError('lg_evidence_session: "out" is required')
      }
      const id = typeof input.session === 'string' && input.session.length > 0 ? input.session : sessionId(exec.agent)
      if (id === undefined) throw new Error('lg_evidence_session: cannot determine the calling session id')

      const artifact = await readSessionArtifact(sessionsRoot(), id)
      if (typeof artifact === 'string') throw new Error(artifact)

      // A relative `out` belongs to the session, not to wherever dsh was
      // launched from: resolving against process.cwd() wrote outside the
      // workspace and the guard then refused to read it back.
      const cwd = sessionCwd(exec.agent)
      if (cwd === undefined) throw new Error('lg_evidence_session: cannot determine the session working directory')
      const file = isAbsolute(input.out) ? input.out : resolvePath(cwd, input.out)
      if (!isInside(cwd, file)) {
        throw new Error(`lg_evidence_session: refusing to write outside the session directory: ${file}`)
      }
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, artifact.jsonl, 'utf8')

      const bytes = Buffer.byteLength(artifact.jsonl, 'utf8')
      const sha256 = createHash('sha256').update(artifact.jsonl, 'utf8').digest('hex')
      const events = artifact.jsonl.split('\n').filter((line) => line.trim().length > 0).length
      return { file, session: artifact.sessionId, source: artifact.source, bytes, events, sha256 }
    },
  })
}
