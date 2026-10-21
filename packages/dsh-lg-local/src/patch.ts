/**
 * `lg-patch-apply` — apply a PATCH message's attachment, or explain why not.
 *
 * Four outcomes, and nothing else (SPEC "lg-patch-apply" / PA-1):
 * APPLIED, REJECTED (bytes or sha256 disagree), DUPLICATE (already applied),
 * CONFLICT (does not apply, and the worktree is rolled back).
 *
 * git is always invoked with fixed arguments through `spawnSync([...])`, never
 * through a shell, so a patch name can never become a command.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` is declared in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

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
  all: () => Promise<readonly { seq: string; type: string; fields: Readonly<Record<string, unknown>> }[]>
  readAttachment?: (path: string) => Promise<Buffer | undefined>
}

/** Run git with fixed arguments; never a shell. */
function git(args: readonly string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Apply the patch carried by one PATCH message.
 *
 * Pure with respect to the channel: the caller supplies the message fields and
 * the attachment bytes, so every branch can be unit-tested without a channel.
 * @param patch - the PATCH message's fields plus the attachment bytes.
 * @param cwd - the worktree to apply into.
 * @returns the verdict, its explanation, and the new commit when applied.
 */
export function applyPatch(patch: { name: string; base: string; bytes: number; sha256: string; data?: Buffer }, cwd: string): ApplyResult {
  const { name, base, bytes, sha256, data } = patch
  if (data === undefined) return { verdict: 'REJECTED', detail: `attachment attachments/<seq>/${name} is missing` }
  if (data.length !== bytes) return { verdict: 'REJECTED', detail: `attachment is ${String(data.length)} bytes, the message declares ${String(bytes)}` }
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== sha256) return { verdict: 'REJECTED', detail: `attachment sha256 is ${actual}, the message declares ${sha256}` }

  const scratch = mkdtempSync(join(tmpdir(), 'lg-patch-'))
  const file = join(scratch, `${name}.patch`)
  try {
    writeFileSync(file, data)

    // Already applied? `git apply --check --reverse` succeeds exactly then.
    const reversed = git(['apply', '--check', '--reverse', file], cwd)
    if (reversed.status === 0) return { verdict: 'DUPLICATE', detail: 'the patch is already applied in this worktree' }

    // The patch has to sit on a commit this branch actually descends from.
    const ancestor = git(['merge-base', '--is-ancestor', base, 'HEAD'], cwd)
    if (ancestor.status !== 0) return { verdict: 'REJECTED', detail: `base ${base} is not an ancestor of HEAD` }

    const applied = git(['am', '--3way', file], cwd)
    if (applied.status === 0) {
      const head = git(['rev-parse', 'HEAD'], cwd).stdout.trim()
      return { verdict: 'APPLIED', detail: `applied ${name}`, commit: head }
    }

    // Anything else is a conflict, and the worktree must not be left half-done.
    git(['am', '--abort'], cwd)
    git(['checkout', '--', '.'], cwd)
    return { verdict: 'CONFLICT', detail: (applied.stderr || applied.stdout).trim().slice(0, 400) }
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
    async execute(args: unknown, exec: { agent?: unknown }) {
      const input = args as { seq?: unknown; cwd?: unknown }
      const seq = typeof input.seq === 'string' ? input.seq : ''
      if (seq.length === 0) throw new Error('lg_apply_patch: "seq" is required')
      const channel = (ctx as unknown as { get?: (name: string) => unknown }).get?.('lgChannel') as ChannelLike | undefined
      if (channel?.readAttachment === undefined) throw new Error('lg_apply_patch: no channel is composed, so the attachment cannot be fetched')

      const message = (await channel.all()).find((entry) => entry.seq === seq && entry.type === 'PATCH')
      if (message === undefined) throw new Error(`lg_apply_patch: no PATCH message at #${seq}`)

      const fields = message.fields
      const data = await channel.readAttachment(`attachments/${seq}/${String(fields['name'])}`)
      const dir =
        typeof input.cwd === 'string'
          ? input.cwd
          : ((exec.agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd ?? process.cwd())
      return applyPatch(
        {
          name: String(fields['name']),
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
