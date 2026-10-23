/**
 * The drafts repository behind `lg_draft_reset` and `lg_patch_send`.
 *
 * Global can write anything under `drafts/` with `write` and `edit`, so that
 * directory is only ever a *work tree*: the git dir lives next to it
 * (`<workspace>/drafts.git`), outside every write root and protected from
 * writes. Every git call names that git dir and work tree explicitly, runs
 * with the hardened environment of `runGit` (no user or system config, hooks
 * off, no fsmonitor) plus the extras below, and never lets git discover a
 * repository from inside the work tree. A hook, a `.git/config` or a
 * `.gitattributes` planted under `drafts/` therefore has nothing to hook into.
 *
 * Objects come from the mirror by `git fetch` into the drafts git dir; nothing
 * is ever written into the mirror.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { GitError, runGit, runGitBytes } from './repo.js'

/** Where the drafts live and who authors their commits. */
export interface DraftsConfig {
  /** The work tree Global edits. */
  readonly dir: string
  /** The git dir; outside `dir` and outside every write root. */
  readonly gitDir: string
  /** The read-only mirror objects are fetched from. */
  readonly mirrorDir: string
  readonly authorName: string
  readonly authorEmail: string
  readonly maxPatchBytes: number
  /** Repository-relative evidence root; a patch may not touch it (Local owns evidence). */
  readonly evidenceRoot: string
}

const SHA = /^[0-9a-f]{40}$/u
const DRAFT_BRANCH = 'refs/heads/draft'
const BASE_REF = 'refs/lg/base'
const SENT_REF = 'refs/lg/sent'

/** Config on every drafts call, on top of the pairs `runGit` always passes. */
const HARDENING = [
  'core.attributesFile=/dev/null',
  'core.excludesFile=/dev/null',
  'core.untrackedCache=false',
  'core.autocrlf=false',
  'core.editor=/bin/false',
  'commit.gpgsign=false',
  'gpg.program=/bin/false',
  'gc.auto=0',
  'maintenance.auto=false',
]

/** What a prepared patch carries. */
export interface PreparedPatch {
  readonly base: string
  readonly head: string
  readonly data: Buffer
  readonly bytes: number
  readonly sha256: string
  /** Attachment name; a plain file name. */
  readonly name: string
  /** Every path the patch changes, relative to the repository root. */
  readonly paths: readonly string[]
}

/** Why a drafts operation was refused. */
export class DraftsError extends Error {}

/** One drafts repository: reset it to a mirror commit, then turn the edits into a patch. */
export class DraftsRepo {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly config: DraftsConfig) {}

  /** Serialize operations: a reset must never interleave with a send. */
  private locked<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async git(args: readonly string[], options: { input?: string; env?: Record<string, string>; fetch?: boolean; maxBytes?: number } = {}): Promise<Buffer> {
    const { author, committer } = { author: this.config.authorName, committer: this.config.authorName }
    const { stdout } = await runGitBytes(args, {
      cwd: this.config.dir,
      env: {
        GIT_DIR: this.config.gitDir,
        GIT_WORK_TREE: this.config.dir,
        GIT_ATTR_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: author,
        GIT_AUTHOR_EMAIL: this.config.authorEmail,
        GIT_COMMITTER_NAME: committer,
        GIT_COMMITTER_EMAIL: this.config.authorEmail,
        ...options.env,
      },
      config: HARDENING,
      // The file transport is only for fetching from the mirror's own directory.
      allowFile: options.fetch === true,
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    })
    return stdout
  }

  private async text(args: readonly string[], options: Parameters<DraftsRepo['git']>[1] = {}): Promise<string> {
    return (await this.git(args, options)).toString('utf8').trim()
  }

  /** The work tree must be a real directory and the git dir must stay out of it. */
  private async guardPaths(): Promise<void> {
    const { dir, gitDir } = this.config
    await mkdir(dir, { recursive: true })
    const stat = await lstat(dir)
    if (!stat.isDirectory()) throw new DraftsError(`lg-directive: ${dir} is not a plain directory (a symbolic link or a file)`)
    const realDir = await realpath(dir)
    const realGit = await realpath(gitDir).catch(() => gitDir)
    const rel = relative(realDir, realGit)
    if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))) throw new DraftsError(`lg-directive: the drafts git dir ${gitDir} is inside the work tree ${dir}`)
  }

  private async ensure(): Promise<void> {
    await this.guardPaths()
    const { gitDir } = this.config
    await mkdir(gitDir, { recursive: true })
    const exists = await lstat(join(gitDir, 'HEAD')).then(() => true, () => false)
    if (!exists) {
      await this.git(['init', '--quiet', '--initial-branch', 'draft'])
      // `init` with an explicit git dir records a bare repository; this one has a work tree.
      await this.git(['config', 'core.bare', 'false'])
    }
  }

  private async refOf(ref: string): Promise<string | undefined> {
    try {
      const sha = await this.text(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
      return SHA.test(sha) ? sha : undefined
    } catch {
      return undefined
    }
  }

  /** The commit the drafts were last reset to, or undefined before the first reset. */
  async base(): Promise<string | undefined> {
    await this.ensure()
    return await this.refOf(BASE_REF)
  }

  /**
   * Replace the work tree with the tree of a mirror commit.
   * @param base - a full commit id the caller already resolved in the mirror.
   * @returns the number of files checked out.
   */
  async reset(base: string): Promise<{ base: string; files: number }> {
    if (!SHA.test(base)) throw new DraftsError('lg-directive: base must be a full commit id')
    return await this.locked(async () => {
      await this.ensure()
      // Everything the mirror has, so any commit it can resolve is reachable here.
      await this.git(
        ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', this.config.mirrorDir, '+refs/heads/*:refs/mirror/heads/*', '+refs/remotes/origin/*:refs/mirror/origin/*'],
        { fetch: true },
      )
      if ((await this.refOf(base)) !== base) throw new DraftsError(`lg-directive: ${base} is not a commit reachable from the mirror's branches`)

      // `rm` does not follow symbolic links, so a link left in drafts/ is removed, not traversed.
      for (const entry of await readdir(this.config.dir)) await rm(join(this.config.dir, entry), { recursive: true, force: true })
      await this.git(['read-tree', '--reset', '--end-of-options', `${base}^{tree}`])
      await this.git(['checkout-index', '--all', '--force'])
      await this.git(['update-ref', DRAFT_BRANCH, base])
      await this.git(['symbolic-ref', 'HEAD', DRAFT_BRANCH])
      await this.git(['update-ref', BASE_REF, base])
      await this.git(['update-ref', '-d', SENT_REF]).catch(() => undefined)
      const files = (await this.text(['ls-files', '-z'])).split('\0').filter((line) => line.length > 0).length
      return { base, files }
    })
  }

  /**
   * Commit the work tree on top of the reset base and render everything since the
   * base as one `git format-patch` mailbox.
   * @param message - the commit message of the new commit.
   * @param deliver - posts the patch; the commit is marked sent only if it resolves.
   * @returns whatever `deliver` returned, with the patch.
   */
  async send<T>(message: string, deliver: (patch: PreparedPatch) => Promise<T>): Promise<{ patch: PreparedPatch; delivered: T }> {
    const subject = message.trim()
    if (subject.length === 0) throw new DraftsError('lg_patch_send: "message" must not be empty')
    if (subject.length > 4000) throw new DraftsError('lg_patch_send: "message" is longer than 4000 characters')
    return await this.locked(async () => {
      await this.ensure()
      const base = await this.refOf(BASE_REF)
      if (base === undefined) throw new DraftsError('lg_patch_send: drafts/ has not been reset to a mirror commit; call lg_draft_reset first')
      const head = await this.refOf(DRAFT_BRANCH)
      if (head === undefined) throw new DraftsError('lg_patch_send: the drafts branch is missing; call lg_draft_reset again')

      await this.git(['add', '--all', '--force', '--', '.'])
      const index = await this.text(['write-tree'])
      const unsent = head !== (await this.refOf(SENT_REF))
      const changed = index !== (await this.text(['rev-parse', '--verify', '--end-of-options', `${head}^{tree}`]))
      if (!changed && !unsent) throw new DraftsError('lg_patch_send: drafts/ has no changes since the last patch; edit files first')

      let commit = head
      if (changed) {
        const paths = await this.changed(base)
        this.assertAcceptable(paths)
        commit = await this.text(['commit-tree', index, '-p', head, '-F', '-'], { input: `${subject}\n` })
        await this.git(['update-ref', DRAFT_BRANCH, commit, head])
      }

      const paths = await this.changed(base)
      if (paths.length === 0) throw new DraftsError('lg_patch_send: the drafts are identical to the base; there is nothing to send')
      this.assertAcceptable(paths)
      let data: Buffer
      try {
        data = await this.git(
          ['format-patch', '--stdout', '--binary', '--full-index', '--no-signature', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', `${base}..${commit}`],
          { maxBytes: this.config.maxPatchBytes },
        )
      } catch (error) {
        if (error instanceof GitError && /output exceeded/u.test(error.message)) {
          throw new DraftsError(`lg_patch_send: the patch is larger than ${String(this.config.maxPatchBytes)} bytes; split the change`)
        }
        throw error
      }
      if (data.subarray(0, 5).toString('latin1') !== 'From ') throw new DraftsError('lg_patch_send: git did not produce a format-patch mailbox')
      const sha256 = createHash('sha256').update(data).digest('hex')
      const patch: PreparedPatch = { base, head: commit, data, bytes: data.length, sha256, name: `draft-${base.slice(0, 12)}-${commit.slice(0, 12)}.patch`, paths }
      const delivered = await deliver(patch)
      await this.git(['update-ref', SENT_REF, commit])
      return { patch, delivered }
    })
  }

  /** Paths that differ between the base and the index, with a gitlink anywhere refused. */
  private async changed(base: string): Promise<string[]> {
    const raw = (await this.git(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--end-of-options', base])).toString('utf8')
    const tokens = raw.split('\0')
    const paths: string[] = []
    for (let index = 0; index + 1 < tokens.length; index += 2) {
      const meta = tokens[index] ?? ''
      const path = tokens[index + 1] ?? ''
      if (!meta.startsWith(':')) break
      const [srcMode, dstMode] = meta.slice(1).split(' ')
      if (srcMode === '160000' || dstMode === '160000') throw new DraftsError(`lg_patch_send: ${path} is a nested git repository (a gitlink); remove it or call lg_draft_reset`)
      paths.push(path)
    }
    return paths
  }

  private assertAcceptable(paths: readonly string[]): void {
    const root = this.config.evidenceRoot.toLowerCase()
    const evidence = paths.filter((path) => path.toLowerCase() === root || path.toLowerCase().startsWith(`${root}/`))
    if (evidence.length > 0) {
      throw new DraftsError(`lg_patch_send: a patch may not change the evidence root (${this.config.evidenceRoot}/), which only Local writes: ${evidence.slice(0, 5).join(', ')}`)
    }
  }
}
