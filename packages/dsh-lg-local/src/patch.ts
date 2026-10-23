/**
 * `lg-patch-apply` — apply a PATCH message's attachment, or explain why not.
 *
 * Four outcomes, and nothing else (SPEC "lg-patch-apply" / PA-1):
 * APPLIED, REJECTED (the patch or the worktree is not fit to apply: bad bytes
 * or sha256, a dirty worktree, an operation in progress, a git failure that is
 * not a conflict), DUPLICATE (already applied), CONFLICT (does not apply, and
 * the worktree is back where it was).
 *
 * git is always invoked with fixed arguments through `spawnSync([...])`, never
 * through a shell, and the patch lives in a scratch file whose name is fixed,
 * so a patch name can never become a command or a path.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

import { validateMessage, type ParsedMessage } from '@local-global/lg-protocol'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` is declared in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

import { expandTilde, service, sessionCwd } from './common.js'
import { protectReason, resolveProtectConfig, type ProtectService } from './protect.js'

export const name = 'lg-patch-apply'
export const inject = ['tools']

/** How one apply attempt ended. */
export type ApplyVerdict = 'APPLIED' | 'REJECTED' | 'DUPLICATE' | 'CONFLICT'

/** Result of one attempt. */
export interface ApplyResult {
  readonly verdict: ApplyVerdict
  readonly detail: string
  readonly commit?: string
}

/** The slice of the channel runtime this plugin needs. */
interface ChannelLike {
  all?: () => Promise<readonly ParsedMessage[]>
  readAttachment?: (path: string) => Promise<Buffer | undefined>
}

/** A plain file name: it ends up in an attachment path, so no separators and no leading dot. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Run git with fixed arguments; never a shell. */
function git(args: readonly string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Whether git's `<path>` (a file or directory under the git dir) exists. */
function gitPathExists(name: string, cwd: string): boolean {
  const found = git(['rev-parse', '--git-path', name], cwd)
  return found.status === 0 && existsSync(resolvePath(cwd, found.stdout.trim()))
}

/** Uncommitted paths, untracked files included. */
function dirtyPaths(cwd: string): string[] {
  return git(['status', '--porcelain=v1', '--untracked-files=all'], cwd)
    .stdout.split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
}

/** What `git am` prints when the patch simply does not fit the tree. */
const CONFLICT_TEXT = /patch failed at|failed to merge|conflict|patch does not apply|does not match index|already exists in working directory|could not build fake ancestor|sha1 information is lacking/i

/**
 * Apply the patch carried by one PATCH message.
 *
 * Pure with respect to the channel: the caller supplies the message fields and
 * the attachment bytes, so every branch can be unit-tested without a channel.
 * The worktree must be clean, so a failed apply can be undone completely
 * without touching anyone's uncommitted work.
 * @param patch - the PATCH message's fields plus the attachment bytes.
 * @param cwd - the worktree to apply into.
 * @returns the verdict, its explanation, and the new commit when applied.
 */
export function applyPatch(patch: { name: string; base: string; bytes: number; sha256: string; data?: Buffer }, cwd: string): ApplyResult {
  const { name, base, bytes, sha256, data } = patch
  if (!SAFE_NAME.test(name)) return { verdict: 'REJECTED', detail: `patch name ${JSON.stringify(name)} is not a plain file name` }
  if (data === undefined) return { verdict: 'REJECTED', detail: `attachment attachments/<seq>/${name} is missing` }
  if (data.length !== bytes) return { verdict: 'REJECTED', detail: `attachment is ${String(data.length)} bytes, the message declares ${String(bytes)}` }
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== sha256) return { verdict: 'REJECTED', detail: `attachment sha256 is ${actual}, the message declares ${sha256}` }
  if (data.subarray(0, 5).toString('latin1') !== 'From ') return { verdict: 'REJECTED', detail: 'attachment is not a git format-patch (mbox) file' }

  if (git(['rev-parse', '--show-toplevel'], cwd).status !== 0) return { verdict: 'REJECTED', detail: `${cwd} is not inside a git worktree` }
  for (const [marker, what] of [['rebase-apply', 'a git am or rebase'], ['rebase-merge', 'a rebase'], ['MERGE_HEAD', 'a merge'], ['CHERRY_PICK_HEAD', 'a cherry-pick']] as const) {
    if (gitPathExists(marker, cwd)) return { verdict: 'REJECTED', detail: `${what} is in progress in this worktree; finish or abort it first` }
  }
  const dirty = dirtyPaths(cwd)
  if (dirty.length > 0) {
    return { verdict: 'REJECTED', detail: `the worktree has ${String(dirty.length)} uncommitted path(s) (${dirty.slice(0, 5).join(', ')}); commit or stash them before applying a patch` }
  }
  if (git(['var', 'GIT_COMMITTER_IDENT'], cwd).status !== 0) {
    return { verdict: 'REJECTED', detail: 'git committer identity is not configured (user.name and user.email); git am cannot commit' }
  }

  const scratch = mkdtempSync(join(tmpdir(), 'lg-patch-'))
  const file = join(scratch, 'patch.mbox')
  try {
    writeFileSync(file, data)

    // Already applied? `git apply --check --reverse` succeeds exactly then.
    const reversed = git(['apply', '--check', '--reverse', file], cwd)
    if (reversed.status === 0) return { verdict: 'DUPLICATE', detail: 'the patch is already applied in this worktree' }

    // The patch has to sit on a commit this branch actually descends from.
    const ancestor = git(['merge-base', '--is-ancestor', base, 'HEAD'], cwd)
    if (ancestor.status !== 0) return { verdict: 'REJECTED', detail: `base ${base} is not an ancestor of HEAD` }

    const before = git(['rev-parse', 'HEAD'], cwd).stdout.trim()
    const applied = git(['am', '--3way', file], cwd)
    if (applied.status === 0) {
      const head = git(['rev-parse', 'HEAD'], cwd).stdout.trim()
      return { verdict: 'APPLIED', detail: `applied ${name}`, commit: head }
    }

    // Undo only what this apply did. The worktree was clean, so going back to
    // `before` loses nothing that was not the patch's own.
    const message = (applied.stderr || applied.stdout).trim().slice(0, 400)
    if (gitPathExists('rebase-apply', cwd)) git(['am', '--abort'], cwd)
    if (git(['rev-parse', 'HEAD'], cwd).stdout.trim() !== before || dirtyPaths(cwd).length > 0) git(['reset', '--hard', before], cwd)
    const leftover = dirtyPaths(cwd)
    const note = leftover.length === 0 ? '' : ` (rollback left ${leftover.slice(0, 5).join(', ')})`
    if (CONFLICT_TEXT.test(message)) return { verdict: 'CONFLICT', detail: `${message}${note}` }
    return { verdict: 'REJECTED', detail: `git am failed for a reason other than a conflict, worktree restored: ${message}${note}` }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register({
    name: 'lg_apply_patch',
    description:
      'Apply the attachment of a PATCH message by sequence. Returns APPLIED with the new commit, REJECTED when the bytes or sha256 disagree, DUPLICATE when it is already applied, or CONFLICT with the worktree rolled back.',
    parameters: {
      type: 'object',
      properties: {
        seq: { type: 'string', description: 'PATCH message sequence, e.g. 0004' },
        cwd: { type: 'string', description: 'Worktree to apply into; defaults to the session directory' },
      },
      required: ['seq'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { verdict: { type: 'string' }, detail: { type: 'string' }, commit: { type: 'string' } },
        required: ['verdict', 'detail'],
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { verdict?: unknown; detail?: unknown; commit?: unknown }
        return [{ type: 'text' as const, text: `${String(v.verdict)}: ${String(v.detail)}${v.commit === undefined ? '' : ` (${String(v.commit)})`}` }]
      },
    },
    async execute(args: unknown, exec: { agent?: unknown }): Promise<ApplyResult> {
      const input = (typeof args === 'object' && args !== null ? args : {}) as { seq?: unknown; cwd?: unknown }
      const seq = typeof input.seq === 'string' ? input.seq : ''
      if (!/^\d{4}$/.test(seq)) throw new Error('lg_apply_patch: "seq" must be a four-digit sequence such as 0004')
      const channel = service<ChannelLike>(ctx, 'lgChannel')
      if (channel?.all === undefined || channel.readAttachment === undefined) {
        throw new Error('lg_apply_patch: lg-channel is not composed (install @local-global/dsh-lg-common), so the PATCH and its attachment cannot be fetched')
      }

      const message = (await channel.all()).find((entry) => entry.seq === seq && entry.type === 'PATCH')
      if (message === undefined) throw new Error(`lg_apply_patch: no PATCH message at #${seq}`)
      // Only Global proposes patches, and only a well-formed message is applied.
      if (message.sender !== 'global') return { verdict: 'REJECTED', detail: `PATCH #${seq} was sent by ${message.sender}; only global may send a PATCH` }
      const problems = validateMessage(message)
      if (problems.length > 0) return { verdict: 'REJECTED', detail: `PATCH #${seq} is not a valid message: ${problems.map((problem) => problem.message).join('; ')}` }

      const fields = message.fields
      const patchName = String(fields['name'])
      if (!SAFE_NAME.test(patchName)) return { verdict: 'REJECTED', detail: `patch name ${JSON.stringify(patchName)} is not a plain file name` }

      const here = sessionCwd(ctx, exec.agent)
      const dir = typeof input.cwd === 'string' && input.cwd !== '' ? resolvePath(here, expandTilde(input.cwd)) : here
      const guard = service<ProtectService>(ctx, 'lgProtect')
      const refused = guard?.check !== undefined ? guard.check('lg_apply_patch', { cwd: dir }, here) : protectReason(resolveProtectConfig({}), 'lg_apply_patch', { cwd: dir }, here)
      if (refused !== undefined) throw new Error(refused)

      const data = await channel.readAttachment(`attachments/${seq}/${patchName}`)
      return applyPatch(
        {
          name: patchName,
          base: String(fields['base']),
          bytes: Number(fields['bytes']),
          sha256: String(fields['sha256']),
          ...(data === undefined ? {} : { data }),
        },
        dir,
      )
    },
  })
}
