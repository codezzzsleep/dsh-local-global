/**
 * `lg-evidence` — export the raw event log of a real session.
 *
 * Session-acceptance evidence must be the original events, not a summary: the
 * reviewer has to see the model-issued `tool/call` and the `tool/result` that
 * came back (SPEC "测试与证据要求", QA-4). dsh keeps every session as a
 * `session.v4.jsonl[.zstd]` file under `$DSH_HOME/sessions/<workspace>/<id>/`;
 * this tool decompresses that file byte for byte and writes it out unchanged,
 * optionally only an event range (EV-3).
 *
 * `out` must resolve, symlinks included, to a path inside the session working
 * directory. This tool applies no per-role write roots: whether the calling
 * role may write that path is for the role's own path guard to decide.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

import { zstdDecompressSync } from 'node:zlib'

import type { Context } from '@deepseek-ai/cordis'

/**
 * Read the session working directory from an agent.
 *
 * Deliberately local to this package: the evidence plugin is shared by both
 * sides (dsh-lg-common), so it cannot import from dsh-lg-global's scope module.
 * @param agent - the calling agent, when dsh exposes one.
 * @returns the session working directory, or `undefined`.
 */
function sessionCwd(agent: unknown): string | undefined {
  const session = (agent as { session?: Record<string, unknown> } | undefined)?.session
  if (session === undefined) return undefined
  const header = session['header'] as Record<string, unknown> | undefined
  for (const candidate of [header?.['cwd'], session['cwd']]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** True when `child` is `parent` or lives under it. */
function isInside(parent: string, child: string): boolean {
  const base = parent.endsWith('/') ? parent : `${parent}/`
  return child === parent || child.startsWith(base)
}

/**
 * Resolve `target` through symlinks to the path a write would really touch.
 *
 * The deepest existing ancestor is resolved with `realpath` and the missing
 * tail is appended, so a not-yet-created file under a symlinked directory is
 * judged by where the link leads. A dangling symlink is refused outright: a
 * write would follow it to a place this check cannot see.
 * @param target - absolute path.
 * @returns the real path.
 */
async function realTarget(target: string): Promise<string> {
  const tail: string[] = []
  let probe = target
  for (;;) {
    try {
      return join(await realpath(probe), ...tail)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await lstat(probe)
      throw new Error(`lg_evidence_session: refusing a dangling symlink at ${probe}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(probe)
    if (parent === probe) return target
    tail.unshift(basename(probe))
    probe = parent
  }
}

/** A session id names a directory under the store; it must not name anything else. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

/** Why a session id is unusable as a directory name, or `undefined` when it is fine. */
export function sessionIdProblem(id: string): string | undefined {
  if (!SESSION_ID_RE.test(id) || id.includes('..')) {
    return `lg_evidence_session: "${id.slice(0, 64)}" is not a session id (letters, digits, ".", "_" and "-" only)`
  }
  return undefined
}

export const name = 'lg-evidence'
export const inject = ['tools']

/** One decompressed session file, ready to be written out. */
export interface SessionArtifact {
  readonly sessionId: string
  readonly source: string
  /** The log decoded as utf8, for reading; exports use `bytes`. */
  readonly jsonl: string
  /** The log exactly as dsh stored it, after decompression. */
  readonly bytes: Buffer
}

/** The part of a log an export covers. */
export interface EventSlice {
  /** The selected bytes, original line endings and blank lines inside the range kept. */
  readonly bytes: Buffer
  /** 1-based, inclusive position of the first and last selected event. */
  readonly from: number
  readonly to: number
  /** Events in the whole log. */
  readonly total: number
}

/**
 * Cut an event range out of a JSONL log without touching a byte.
 *
 * An event is one non-blank line, numbered from 1. With no bounds the whole
 * buffer comes back unchanged, blank lines and a missing final newline included.
 * @param log - the raw log.
 * @param from - first event, default 1.
 * @param to - last event, default the final one; clipped to the log's length.
 * @returns the slice, or an explanatory error when the range selects nothing.
 */
export function sliceEvents(log: Buffer, from?: number, to?: number): EventSlice | string {
  const spans: { start: number; end: number }[] = []
  let start = 0
  while (start < log.length) {
    const newline = log.indexOf(0x0a, start)
    const end = newline === -1 ? log.length : newline + 1
    let blank = true
    for (let index = start; index < end; index += 1) {
      const byte = log[index] as number
      if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a) {
        blank = false
        break
      }
    }
    if (!blank) spans.push({ start, end })
    start = end
  }
  const total = spans.length
  if (from === undefined && to === undefined) return { bytes: log, from: total === 0 ? 0 : 1, to: total, total }
  const first = from ?? 1
  const last = Math.min(to ?? total, total)
  if (!Number.isInteger(first) || first < 1 || (to !== undefined && (!Number.isInteger(to) || to < first))) {
    return `lg_evidence_session: the event range ${String(from ?? 1)}..${String(to ?? 'end')} is not a valid 1-based range`
  }
  if (first > total) return `lg_evidence_session: the log has ${String(total)} events; nothing from ${String(first)} onward`
  const begin = spans[first - 1] as { start: number; end: number }
  const finish = spans[last - 1] as { start: number; end: number }
  return { bytes: log.subarray(begin.start, finish.end), from: first, to: last, total }
}

/** Where dsh keeps session event logs. */
export function sessionsRoot(home = process.env['DSH_HOME']): string {
  return join(home === undefined || home.length === 0 ? join(homedir(), '.dsh') : home, 'sessions')
}

/** The store root dsh uses for this process. */
function defaultSessionsRoot(): string {
  return sessionsRoot()
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
export async function readSessionArtifact(root: string, id: string): Promise<SessionArtifact | string> {
  const unsafe = sessionIdProblem(id)
  if (unsafe !== undefined) return unsafe
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
        const bytes = filename.endsWith('.zstd') ? zstdDecompressSync(raw) : raw
        return { sessionId: id, source, jsonl: bytes.toString('utf8'), bytes }
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
        from: { type: 'number', description: 'First event to export, 1-based; defaults to the first.' },
        to: { type: 'number', description: 'Last event to export, inclusive; defaults to the last.' },
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
          from: { type: 'number' },
          to: { type: 'number' },
          total: { type: 'number' },
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
      const input = args as { out?: unknown; session?: unknown; from?: unknown; to?: unknown }
      if (typeof input.out !== 'string' || input.out.length === 0) {
        throw new TypeError('lg_evidence_session: "out" is required')
      }
      for (const [label, value] of [['from', input.from], ['to', input.to]] as const) {
        if (value !== undefined && typeof value !== 'number') throw new TypeError(`lg_evidence_session: "${label}" must be a number`)
      }
      const id = typeof input.session === 'string' && input.session.length > 0 ? input.session : sessionId(exec.agent)
      if (id === undefined) throw new Error('lg_evidence_session: cannot determine the calling session id')

      const artifact = await readSessionArtifact(defaultSessionsRoot(), id)
      if (typeof artifact === 'string') throw new Error(artifact)
      const slice = sliceEvents(artifact.bytes, input.from as number | undefined, input.to as number | undefined)
      if (typeof slice === 'string') throw new Error(slice)

      // A relative `out` belongs to the session, not to wherever dsh was
      // launched from: resolving against process.cwd() wrote outside the
      // workspace and the guard then refused to read it back.
      const cwd = sessionCwd(exec.agent)
      if (cwd === undefined) throw new Error('lg_evidence_session: cannot determine the session working directory')
      const wanted = isAbsolute(input.out) ? input.out : resolvePath(cwd, input.out)
      // Judge the real destination: a symlink inside the directory can lead out of it.
      const root = await realpath(cwd)
      const file = await realTarget(resolvePath(wanted))
      if (!isInside(root, file)) {
        throw new Error(`lg_evidence_session: refusing to write outside the session directory: ${wanted}`)
      }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, slice.bytes)

      const sha256 = createHash('sha256').update(slice.bytes).digest('hex')
      const events = sliceEvents(slice.bytes)
      return {
        file,
        session: artifact.sessionId,
        source: artifact.source,
        bytes: slice.bytes.length,
        events: typeof events === 'string' ? 0 : events.total,
        from: slice.from,
        to: slice.to,
        total: slice.total,
        sha256,
      }
    },
  })
}
