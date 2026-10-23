/**
 * Git plumbing for the channel repository (docs/channel-git.md §1, §6).
 *
 * The channel is a bare mirror plus object plumbing: no working tree, so two
 * writers never fight over checked-out files, and a rejected push costs one
 * refetch instead of a rebase.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachmentNameProblem, attachmentPath, nextSeq } from '@local-global/lg-protocol'
import type { MessageType, Sender } from '@local-global/lg-protocol'
import { redactSecrets } from './redact.js'

/** Where a channel repository keeps its messages. */
export const MESSAGES_DIR = 'messages'

/** One git invocation result. */
export interface GitResult {
  readonly stdout: string
  readonly stderr: string
}

/** Options for one git invocation. */
export interface GitOptions {
  readonly cwd?: string
  readonly input?: string | Uint8Array
  readonly env?: Readonly<Record<string, string>>
}

/** A failed git command; message and stderr are already redacted. */
export class GitError extends Error {
  readonly exitCode: number | null
  readonly stderr: string

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message)
    this.name = 'GitError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

async function execGit(args: readonly string[], options: GitOptions): Promise<{ stdout: Buffer; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'protocol.file.allow=always', ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    // A command that exits before reading stdin closes the pipe; that is not a
    // failure of the command itself.
    child.stdin.on('error', () => {})
    child.on('error', (error) => reject(new Error(redactSecrets(error.message))))
    child.on('close', (code) => {
      const stdout = Buffer.concat(out)
      const stderr = Buffer.concat(err).toString('utf8')
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      // Remote URLs reach argv and stderr; neither may carry credentials onward.
      const detail = redactSecrets(stderr.trim() || stdout.toString('utf8').trim())
      reject(new GitError(`git ${redactSecrets(args.join(' '))} failed (exit ${String(code)}): ${detail}`, code, redactSecrets(stderr)))
    })
    child.stdin.end(options.input ?? '')
  })
}

/**
 * Run git with a fixed argv (never a shell) and capture its output.
 * @param args - argv after `git`.
 * @param options - working directory, stdin, extra environment.
 * @returns stdout and stderr exactly as git wrote them (callers trim what they must).
 * @throws GitError carrying git's redacted stderr when the command fails.
 */
export async function runGit(args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const { stdout, stderr } = await execGit(args, options)
  return { stdout: stdout.toString('utf8'), stderr }
}

/** One file to commit next to a message, under `attachments/<seq>/`. */
export interface AppendAttachment {
  readonly name: string
  readonly content: Uint8Array
}

/** What one append produced. */
export interface AppendResult {
  readonly seq: string
  readonly filename: string
  readonly commit: string
  /** The message text that was committed. */
  readonly text: string
}

/** A message the caller wants appended, rendered once its sequence is known. */
export interface AppendRequest {
  readonly sender: Sender
  readonly type: MessageType
  readonly text: string
  readonly filename: string
  /** Committed together with the message, in the same commit. */
  readonly attachments?: readonly AppendAttachment[]
}

/** The channel as it stood at the commit an append is built on. */
export interface AppendView {
  /** The commit the new message will sit on; `undefined` for an empty channel. */
  readonly parent: string | undefined
  /** Every `messages/*.md` file at `parent`, byte-exact. */
  readMessages(): Promise<Map<string, Buffer>>
}

/** Retry knobs for {@link ChannelRepo.append}. */
export interface AppendOptions {
  /** Maximum push attempts; default {@link DEFAULT_APPEND_ATTEMPTS}. */
  readonly attempts?: number
  /** First backoff ceiling in ms; doubles per attempt. */
  readonly backoffMs?: number
  readonly maxBackoffMs?: number
  /** Replaceable for tests. */
  readonly random?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** Attempts per append. Several writers can lose a round each, so this exceeds the contract's three retries. */
export const DEFAULT_APPEND_ATTEMPTS = 8
const DEFAULT_BACKOFF_MS = 100
const DEFAULT_MAX_BACKOFF_MS = 2000

/** Only a refused push is worth retrying; auth and network failures are not. */
function isRetryablePush(error: unknown): boolean {
  const text = error instanceof GitError ? error.stderr : error instanceof Error ? error.message : String(error)
  return /rejected|non-fast-forward|fetch first|cannot lock ref|failed to update ref|stale info/iu.test(text)
}

const locks = new Map<string, Promise<unknown>>()

/** Run `fn` after every earlier holder of `key` has finished, so one mirror is never driven concurrently. */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  locks.set(key, tail)
  try {
    return await run
  } finally {
    if (locks.get(key) === tail) locks.delete(key)
  }
}

interface TreeEntry {
  readonly name: string
  readonly sha: string
}

/** A bare channel mirror that can read history and append exactly one message per commit. */
export class ChannelRepo {
  readonly dir: string
  readonly remote: string
  readonly branch: string

  constructor(dir: string, remote: string, branch: string) {
    this.dir = dir
    this.remote = remote
    this.branch = branch
  }

  /**
   * Create the bare mirror on first use and fetch the branch.
   * @returns nothing; the repository is ready for {@link listMessages}.
   * @throws GitError when the remote cannot be reached.
   */
  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    try {
      await runGit(['rev-parse', '--git-dir'], { cwd: this.dir })
    } catch {
      await runGit(['init', '--bare', '--initial-branch', this.branch, this.dir])
    }
    // Keep origin in step with the configuration (a rotated token, a moved remote).
    let current: string | undefined
    try {
      current = (await runGit(['remote', 'get-url', 'origin'], { cwd: this.dir })).stdout.trim()
    } catch {
      current = undefined
    }
    if (current === undefined) await runGit(['remote', 'add', 'origin', this.remote], { cwd: this.dir })
    else if (current !== this.remote) await runGit(['remote', 'set-url', 'origin', this.remote], { cwd: this.dir })
    await this.fetch()
  }

  /**
   * Fetch every branch into `refs/remotes/origin/*`.
   *
   * An existing remote with no branches yet is an empty channel and succeeds;
   * an unreachable or missing remote is an error. Treating the latter as empty
   * would let a first bind start the cursor at 0000 and replay history later (CH-2).
   * @throws GitError when git cannot fetch.
   */
  async fetch(): Promise<void> {
    await withLock(this.dir, async () => await this.fetchNow())
  }

  private async fetchNow(): Promise<void> {
    await runGit(['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { cwd: this.dir })
  }

  /** Current origin commit for the channel branch, or `undefined` for an empty channel. */
  async originHead(): Promise<string | undefined> {
    try {
      const { stdout } = await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${this.branch}^{commit}`], { cwd: this.dir })
      return stdout.trim() || undefined
    } catch (error) {
      // `--verify --quiet` exits 1 without a word when the ref is simply absent.
      if (error instanceof GitError && error.exitCode === 1 && error.stderr.trim() === '') return undefined
      throw error
    }
  }

  private async lsTree(path: string, head: string | undefined): Promise<TreeEntry[]> {
    if (head === undefined) return []
    const { stdout } = await execGit(['ls-tree', '-z', head, '--', path], { cwd: this.dir })
    const entries: TreeEntry[] = []
    for (const record of stdout.toString('utf8').split('\0')) {
      const tab = record.indexOf('\t')
      if (tab === -1) continue
      const [, type, sha] = record.slice(0, tab).split(' ')
      if (type !== 'blob' || sha === undefined) continue
      entries.push({ name: record.slice(tab + 1), sha })
    }
    return entries
  }

  /**
   * Message file names on the origin branch (or at `rev`), sorted.
   * @throws GitError on a real git failure; an empty channel is `[]`.
   */
  async listMessages(rev?: string): Promise<string[]> {
    const entries = await this.lsTree(`${MESSAGES_DIR}/`, rev ?? (await this.originHead()))
    return entries
      .map((entry) => entry.name.slice(MESSAGES_DIR.length + 1))
      .filter((name) => name.endsWith('.md'))
      .sort()
  }

  /**
   * Read every `messages/*.md` blob at one commit, byte-exact, in two git calls.
   * @param rev - commit to read; the origin head by default.
   * @returns file name → bytes, ascending by name.
   */
  async readMessages(rev?: string): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>()
    const entries = (await this.lsTree(`${MESSAGES_DIR}/`, rev ?? (await this.originHead())))
      .map((entry) => ({ name: entry.name.slice(MESSAGES_DIR.length + 1), sha: entry.sha }))
      .filter((entry) => entry.name.endsWith('.md'))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    if (entries.length === 0) return out
    const { stdout } = await execGit(['cat-file', '--batch'], {
      cwd: this.dir,
      input: `${entries.map((entry) => entry.sha).join('\n')}\n`,
    })
    let offset = 0
    for (const entry of entries) {
      const newline = stdout.indexOf(0x0a, offset)
      const [, kind, size] = stdout.toString('utf8', offset, newline).split(' ')
      if (newline === -1 || kind !== 'blob' || size === undefined) {
        throw new Error(`lg-channel: unexpected git cat-file output for messages/${entry.name}`)
      }
      const start = newline + 1
      out.set(entry.name, stdout.subarray(start, start + Number(size)))
      offset = start + Number(size) + 1
    }
    return out
  }

  /**
   * Read one path byte-exactly.
   *
   * `readFile` goes through a utf8 decode; an attachment's sha256 has to match
   * the bytes on disk, so this one keeps them raw (SPEC "lg-patch-apply").
   * @param path - path inside the repository.
   * @param rev - commit to read; the origin head by default.
   * @returns the blob's bytes, or `undefined` when the path is absent.
   * @throws GitError on a real git failure.
   */
  async readBytes(path: string, rev?: string): Promise<Buffer | undefined> {
    const [entry] = await this.lsTree(path, rev ?? (await this.originHead()))
    if (entry === undefined) return undefined
    const { stdout } = await execGit(['cat-file', 'blob', entry.sha], { cwd: this.dir })
    return stdout
  }

  /**
   * Read one file as utf8 text.
   * @param path - repository-relative path.
   * @param rev - commit to read; the origin head by default.
   * @returns the text, or `undefined` when absent.
   */
  async readFile(path: string, rev?: string): Promise<string | undefined> {
    return (await this.readBytes(path, rev))?.toString('utf8')
  }

  /** The commit that added `path` on the origin branch, or `undefined` when it is absent. */
  async commitAdding(path: string): Promise<string | undefined> {
    const head = await this.originHead()
    if (head === undefined) return undefined
    const { stdout } = await runGit(['log', '-1', '--format=%H', '--diff-filter=A', head, '--', path], { cwd: this.dir })
    return stdout.trim() || undefined
  }

  /**
   * Append one message as its own commit and push it.
   *
   * On a rejected push the commit is discarded and the sequence is recomputed
   * from the refreshed remote (§6 step 4). Retries back off with full jitter so
   * writers that collided do not collide again in lock step. The rendered file
   * is rebuilt for each attempt because its name carries the sequence; an error
   * thrown by `build` is the caller's and is never retried.
   * @param build - renders the request for a given sequence, reading the channel at `view`.
   * @param options - attempt count, or the full retry options.
   * @returns the sequence, file name, commit and text that landed.
   * @throws Error after the final failed attempt or the first non-retryable failure.
   */
  async append(
    build: (seq: string, view: AppendView) => AppendRequest | Promise<AppendRequest>,
    options: number | AppendOptions = {},
  ): Promise<AppendResult> {
    const settings = typeof options === 'number' ? { attempts: options } : options
    const attempts = Math.max(1, settings.attempts ?? DEFAULT_APPEND_ATTEMPTS)
    const backoff = settings.backoffMs ?? DEFAULT_BACKOFF_MS
    const cap = settings.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    const random = settings.random ?? Math.random
    const sleep = settings.sleep ?? (async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms)))

    return await withLock(this.dir, async () => {
      let failure: unknown
      let made = 0
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        made = attempt
        await this.fetchNow()
        const parent = await this.originHead()
        const seq = nextSeq(await this.listMessages(parent))
        const request = await build(seq, { parent, readMessages: async () => await this.readMessages(parent) })
        const commit = await this.commitFile(parent, request, seq)
        try {
          await runGit(['push', 'origin', `${commit}:refs/heads/${this.branch}`], { cwd: this.dir })
          await runGit(['update-ref', `refs/remotes/origin/${this.branch}`, commit], { cwd: this.dir })
          return { seq, filename: request.filename, commit, text: request.text }
        } catch (error) {
          failure = error
          if (!isRetryablePush(error)) break
          if (attempt < attempts) await sleep(Math.floor(random() * Math.min(cap, backoff * 2 ** (attempt - 1))))
        }
      }
      throw new Error(
        `lg-channel: could not append a message after ${String(made)} attempts: ${redactSecrets(failure instanceof Error ? failure.message : String(failure))}`,
      )
    })
  }

  /** Build one commit object that adds the message and its attachments to `parent` (or to the empty tree). */
  private async commitFile(parent: string | undefined, request: AppendRequest, seq: string): Promise<string> {
    if (request.filename !== `${seq}-${request.sender}-${request.type}.md`) {
      throw new Error(`lg-channel: message file name "${request.filename}" does not match sequence ${seq}, sender and type`)
    }
    const files: { path: string; content: Uint8Array }[] = [{ path: `${MESSAGES_DIR}/${request.filename}`, content: Buffer.from(request.text, 'utf8') }]
    const seen = new Set<string>()
    for (const attachment of request.attachments ?? []) {
      const problem = attachmentNameProblem(attachment.name)
      if (problem !== undefined) throw new Error(`lg-channel: ${problem}: ${JSON.stringify(attachment.name)}`)
      if (seen.has(attachment.name)) throw new Error(`lg-channel: attachment "${attachment.name}" is listed twice`)
      seen.add(attachment.name)
      files.push({ path: attachmentPath(seq, attachment.name), content: attachment.content })
    }

    const scratch = await mkdtemp(join(tmpdir(), 'lg-index-'))
    try {
      // Only the index is redirected. Author and committer come from the
      // machine's git configuration: the message's sender is declared by its
      // first line and file name (docs/channel-git.md §9), never by inventing
      // a git identity that does not exist on this machine.
      const env = { GIT_INDEX_FILE: join(scratch, 'index') }
      if (parent !== undefined) await runGit(['read-tree', parent], { cwd: this.dir, env })
      for (const file of files) {
        const { stdout: blob } = await runGit(['hash-object', '-w', '--stdin'], { cwd: this.dir, input: file.content })
        await runGit(['update-index', '--add', '--cacheinfo', `100644,${blob.trim()},${file.path}`], { cwd: this.dir, env })
      }
      const { stdout: tree } = await runGit(['write-tree'], { cwd: this.dir, env })
      const args = ['commit-tree', tree.trim(), '-m', `msg ${seq} ${request.sender} ${request.type}`]
      if (parent !== undefined) args.push('-p', parent)
      const { stdout: commit } = await runGit(args, { cwd: this.dir, env })
      return commit.trim()
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
}
