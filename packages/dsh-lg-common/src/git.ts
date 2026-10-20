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
import { nextSeq } from '@local-global/lg-protocol'
import type { MessageType, Sender } from '@local-global/lg-protocol'

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
  readonly input?: string
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Run git with a fixed argv (never a shell) and capture its output.
 * @param args - argv after `git`.
 * @param options - working directory, stdin, extra environment.
 * @returns stdout and stderr exactly as git wrote them (callers trim what they must).
 * @throws Error carrying git's stderr when the command fails.
 */
export async function runGit(args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  return await new Promise<GitResult>((resolve, reject) => {
    const child = spawn('git', ['-c', 'protocol.file.allow=always', ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(`git ${args.join(' ')} failed (exit ${String(code)}): ${stderr.trim() || stdout.trim()}`))
    })
    child.stdin.end(options.input ?? '')
  })
}

/** What one append produced. */
export interface AppendResult {
  readonly seq: string
  readonly filename: string
  readonly commit: string
}

/** A message the caller wants appended, rendered once its sequence is known. */
export interface AppendRequest {
  readonly sender: Sender
  readonly type: MessageType
  readonly text: string
  readonly filename: string
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
   */
  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    try {
      await runGit(['rev-parse', '--git-dir'], { cwd: this.dir })
    } catch {
      await runGit(['init', '--bare', '--initial-branch', this.branch, this.dir])
      await runGit(['remote', 'add', 'origin', this.remote], { cwd: this.dir })
    }
    await this.fetch()
  }

  /** Fetch every branch into `refs/remotes/origin/*`. */
  async fetch(): Promise<void> {
    try {
      await runGit(['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { cwd: this.dir })
    } catch (error) {
      // An empty remote has nothing to fetch; anything else is a real failure.
      const message = error instanceof Error ? error.message : String(error)
      if (!/couldn't find remote ref|no such ref|does not appear to be a git repository/iu.test(message)) {
        throw error
      }
    }
  }

  /** Current origin commit for the channel branch, or `undefined` for an empty channel. */
  async originHead(): Promise<string | undefined> {
    try {
      const { stdout } = await runGit(['rev-parse', '--verify', `origin/${this.branch}`], { cwd: this.dir })
      return stdout.trim() || undefined
    } catch {
      return undefined
    }
  }

  /** Message file names on the origin branch, in tree order. */
  async listMessages(): Promise<string[]> {
    try {
      const { stdout } = await runGit(['ls-tree', '--name-only', `origin/${this.branch}`, `${MESSAGES_DIR}/`], { cwd: this.dir })
      return stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => line.slice(MESSAGES_DIR.length + 1))
        .filter((name) => name.endsWith('.md'))
        .sort()
    } catch {
      return []
    }
  }

  /**
   * Read one file at the origin branch head.
   * @param path - repository-relative path.
   * @returns the blob contents, or `undefined` when absent.
   */
  async readFile(path: string): Promise<string | undefined> {
    try {
      const { stdout } = await runGit(['show', `origin/${this.branch}:${path}`], { cwd: this.dir })
      return stdout
    } catch {
      return undefined
    }
  }

  /**
   * Append one message as its own commit and push it.
   *
   * On a rejected push the commit is discarded and the sequence is recomputed
   * from the refreshed remote (§6 step 4). The rendered file is rebuilt for
   * each attempt because its name carries the sequence.
   * @param build - renders the request for a given sequence.
   * @param attempts - maximum push attempts, 3 by default.
   * @returns the sequence, file name, and commit that landed.
   * @throws Error after the final failed attempt.
   */
  async append(build: (seq: string) => AppendRequest, attempts = 3): Promise<AppendResult> {
    let failure: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.fetch()
      const parent = await this.originHead()
      const files = parent === undefined ? [] : await this.listMessages()
      const seq = nextSeq(files)
      const request = build(seq)
      const commit = await this.commitFile(parent, `${MESSAGES_DIR}/${request.filename}`, request, seq)
      try {
        await runGit(['push', 'origin', `${commit}:refs/heads/${this.branch}`], { cwd: this.dir })
        await runGit(['update-ref', `refs/remotes/origin/${this.branch}`, commit], { cwd: this.dir })
        return { seq, filename: request.filename, commit }
      } catch (error) {
        failure = error
      }
    }
    throw new Error(`lg-channel: could not append a message after ${String(attempts)} attempts: ${failure instanceof Error ? failure.message : String(failure)}`)
  }

  /** Build one commit object that adds `path` to `parent` (or to the empty tree). */
  private async commitFile(parent: string | undefined, path: string, request: AppendRequest, seq: string): Promise<string> {
    const scratch = await mkdtemp(join(tmpdir(), 'lg-index-'))
    try {
      const env = {
        GIT_INDEX_FILE: join(scratch, 'index'),
        GIT_AUTHOR_NAME: request.sender,
        GIT_AUTHOR_EMAIL: `${request.sender}@local-global.invalid`,
        GIT_COMMITTER_NAME: request.sender,
        GIT_COMMITTER_EMAIL: `${request.sender}@local-global.invalid`,
      }
      const { stdout: blob } = await runGit(['hash-object', '-w', '--stdin'], { cwd: this.dir, input: request.text })
      if (parent !== undefined) await runGit(['read-tree', parent], { cwd: this.dir, env })
      await runGit(['update-index', '--add', '--cacheinfo', `100644,${blob.trim()},${path}`], { cwd: this.dir, env })
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
