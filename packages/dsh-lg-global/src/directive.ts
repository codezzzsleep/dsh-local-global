/**
 * `lg-directive` — Global's write exit.
 *
 * Six tools with stricter checks than `lg_post`: a DIRECTIVE must be complete
 * and tied to the spec (GD-1), a REVIEW numbers its own findings, a DECISION
 * only answers what is open, drafts become a CLAIM and a PATCH (GD-2), and a
 * STOP is only sent for a commit whose every criterion has current `real`
 * evidence (GD-3, invariant 5). Every refusal is an error result that lists
 * all the reasons, and nothing is written to the channel for a refused call.
 */
import { resolve as resolvePath, isAbsolute, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` lives in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'
import type { ChannelView, ParsedMessage } from '@local-global/lg-protocol'
import { DraftsError, DraftsRepo, type DraftsConfig, type PreparedPatch } from './drafts.js'
import { checkDecision, checkDirective, checkReview, specRequirementIds } from './directive-rules.js'
import { manifestProblems, treeDigestAt } from './evidence-check.js'
import { checkRepoPath, type RepoRuntime } from './repo.js'
import { GuardState, lgState } from './state.js'
import { serviceOf } from './tools.js'

export const name = 'lg-directive'
export const inject = ['tools']

/** Raw plugin config. */
export interface RawDirectiveConfig {
  readonly workspace?: unknown
  /** Spec path inside the repository, read from the mirror to validate requirement ids. */
  readonly specPath?: unknown
  /** Evidence root inside the repository; must match Local's `evidenceRoot`. */
  readonly evidenceRoot?: unknown
  readonly draftsDir?: unknown
  readonly draftsGitDir?: unknown
  readonly authorName?: unknown
  readonly authorEmail?: unknown
  readonly maxPatchBytes?: unknown
}

/** Resolved configuration. */
export interface DirectiveConfig {
  readonly specPath: string
  readonly evidenceRoot: string
  readonly draftsDir: string
  readonly draftsGitDir: string
  readonly authorName: string
  readonly authorEmail: string
  readonly maxPatchBytes: number
}

const EVIDENCE_ROOT = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/u

function lexicallyInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Validate raw config and fill defaults.
 * @param raw - composition config.
 * @param writeRoots - the roots lg-scope lets Global write, when known.
 * @param protectedPaths - paths no tool may write (role file, mirror), which a reset must never delete.
 * @throws TypeError when a value is unusable, the drafts git dir could be written by Global, or a reset could delete something protected.
 */
export function resolveDirectiveConfig(raw: RawDirectiveConfig, writeRoots: readonly string[] = [], protectedPaths: readonly string[] = []): DirectiveConfig {
  if (typeof raw.workspace !== 'string' || !isAbsolute(raw.workspace)) throw new TypeError('lg-directive: set "workspace" or run with an lg-scope workspace')
  const workspace = resolvePath(raw.workspace)
  const specPath = raw.specPath === undefined ? 'docs/spec.md' : checkRepoPath(raw.specPath, 'specPath')
  const evidenceRoot = raw.evidenceRoot === undefined ? 'evidence' : String(raw.evidenceRoot)
  if (!EVIDENCE_ROOT.test(evidenceRoot)) throw new TypeError('lg-directive: "evidenceRoot" must be plain relative path segments such as "evidence"')
  const draftsDir = resolvePath(workspace, raw.draftsDir === undefined ? 'drafts' : String(raw.draftsDir))
  const draftsGitDir = resolvePath(workspace, raw.draftsGitDir === undefined ? 'drafts.git' : String(raw.draftsGitDir))
  // A reset empties the work tree, so it has to be a directory of its own.
  if (draftsDir === workspace || !lexicallyInside(workspace, draftsDir)) throw new TypeError('lg-directive: "draftsDir" must be a directory inside the workspace, not the workspace itself')
  if (lexicallyInside(draftsDir, draftsGitDir) || lexicallyInside(draftsGitDir, draftsDir)) {
    throw new TypeError('lg-directive: the drafts git dir and the drafts work tree must not contain each other')
  }
  for (const root of writeRoots) {
    if (lexicallyInside(root, draftsGitDir) || lexicallyInside(draftsGitDir, root)) {
      throw new TypeError(`lg-directive: the drafts git dir ${draftsGitDir} overlaps the write root ${root}; Global could rewrite its own git configuration`)
    }
  }
  if (writeRoots.length > 0 && !writeRoots.some((root) => lexicallyInside(root, draftsDir))) {
    throw new TypeError(`lg-directive: the drafts directory ${draftsDir} is outside the write roots, so Global could not edit it`)
  }
  for (const path of protectedPaths) {
    if (lexicallyInside(draftsDir, path)) throw new TypeError(`lg-directive: the drafts directory ${draftsDir} contains the protected path ${path}; a reset would delete it`)
  }
  const text = (value: unknown, fallback: string, label: string): string => {
    if (value === undefined) return fallback
    if (typeof value !== 'string' || value.trim().length === 0 || /[<>\n\0]/u.test(value)) throw new TypeError(`lg-directive: "${label}" must be a plain non-empty string`)
    return value.trim()
  }
  const max = raw.maxPatchBytes === undefined ? 4 * 1024 * 1024 : raw.maxPatchBytes
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 32 * 1024 * 1024) throw new TypeError('lg-directive: "maxPatchBytes" must be an integer from 1 to 33554432')
  return {
    specPath,
    evidenceRoot,
    draftsDir,
    draftsGitDir,
    authorName: text(raw.authorName, 'Global', 'authorName'),
    authorEmail: text(raw.authorEmail, 'global@lg.invalid', 'authorEmail'),
    maxPatchBytes: max,
  }
}

/** The slice of the channel runtime these tools use. */
export interface ChannelLike {
  snapshot(): Promise<{ view: ChannelView; messages: readonly ParsedMessage[] }>
  post(input: { type: string; fields: Record<string, unknown>; body?: string; attachments?: readonly { name: string; content: string | Uint8Array }[] }): Promise<{ seq: string; id: string }>
  readonly repo?: { fetch?: () => Promise<void> }
  readonly halted?: boolean
}

/** The slice of `lg-checkpoint` the REVIEW tool consults. */
interface CheckpointLike {
  reviewProblem(refs: readonly string[], body: string): string | undefined
}

/** What a tool call returns: the text the model reads, plus fields for programs. */
export interface ToolOutput {
  readonly text: string
  readonly [key: string]: unknown
}

/** What the runtime reads from the plugin context. */
export interface DirectiveDeps {
  readonly raw: RawDirectiveConfig
  readonly workspace: () => string | undefined
  readonly channel: () => ChannelLike | undefined
  readonly repo: () => RepoRuntime | undefined
  readonly checkpoint: () => CheckpointLike | undefined
  readonly state?: GuardState
}

const SHA40 = /^[0-9a-f]{40}$/u
const refuse = (tool: string, reasons: readonly string[]): never => {
  throw new Error(`${tool}: refused, nothing was sent.\n${reasons.map((reason) => `- ${reason}`).join('\n')}`)
}

/** Every Global write tool, over one channel, one mirror and one drafts repository. */
export class DirectiveRuntime {
  private readonly state: GuardState
  private drafts: { mirrorDir: string; repo: DraftsRepo } | undefined

  constructor(private readonly deps: DirectiveDeps) {
    this.state = deps.state ?? lgState
  }

  private config(): DirectiveConfig {
    const writeRoots = this.state.component<{ writeRoots?: readonly string[] }>('scope')?.writeRoots ?? []
    const config = resolveDirectiveConfig({ workspace: this.deps.workspace(), ...this.deps.raw }, writeRoots, this.state.protectedList())
    // No write tool may touch the drafts git dir, whatever the write roots say.
    this.state.protect(config.draftsGitDir)
    return config
  }

  private channel(tool: string): ChannelLike {
    const channel = this.deps.channel()
    if (channel === undefined) throw new Error(`${tool}: lg-channel is not running; install @local-global/dsh-lg-common`)
    return channel
  }

  private repo(tool: string): RepoRuntime {
    const repo = this.deps.repo()
    if (repo === undefined) throw new Error(`${tool}: lg-repo is not running`)
    return repo
  }

  /** The channel as it is on the remote now, not as the last poll saw it. */
  private async view(tool: string): Promise<{ channel: ChannelLike; view: ChannelView; messages: readonly ParsedMessage[] }> {
    const channel = this.channel(tool)
    if (channel.halted === true) throw new Error(`${tool}: the channel is halted by a human HALT`)
    try {
      await channel.repo?.fetch?.()
    } catch (error) {
      throw new Error(`${tool}: the channel cannot be fetched, so its state is unknown: ${error instanceof Error ? error.message : String(error)}`)
    }
    const { view, messages } = await channel.snapshot()
    return { channel, view, messages }
  }

  private draftsRepo(config: DirectiveConfig, mirrorDir: string): DraftsRepo {
    if (this.drafts?.mirrorDir !== mirrorDir) {
      const draftsConfig: DraftsConfig = {
        dir: config.draftsDir,
        gitDir: config.draftsGitDir,
        mirrorDir,
        authorName: config.authorName,
        authorEmail: config.authorEmail,
        maxPatchBytes: config.maxPatchBytes,
        evidenceRoot: config.evidenceRoot,
      }
      this.drafts = { mirrorDir, repo: new DraftsRepo(draftsConfig) }
    }
    return this.drafts.repo
  }

  /** Requirement ids of the spec at the mirror's HEAD, with a sentence saying how they were checked. */
  private async specIds(config: DirectiveConfig): Promise<{ ids?: Set<string>; note: string }> {
    try {
      const mirror = this.repo('lg_directive').mirror()
      const head = await mirror.head()
      const shown = await mirror.show(head, config.specPath)
      if (shown.encoding !== 'utf8') throw new Error('not text')
      const ids = specRequirementIds(shown.text)
      if (ids.size === 0) throw new Error('it defines no requirement ids')
      return { ids, note: `requirement ids checked against ${config.specPath} at mirror ${head.slice(0, 12)}` }
    } catch (error) {
      return { note: `${config.specPath} could not be used from the mirror (${error instanceof Error ? error.message : String(error)}); requirement ids were checked by pattern only` }
    }
  }

  /** `lg_directive` */
  async directive(args: Record<string, unknown>): Promise<ToolOutput> {
    const config = this.config()
    const { channel, view } = await this.view('lg_directive')
    const spec = await this.specIds(config)
    const checked = checkDirective(args, spec.ids)
    if (!checked.ok) return refuse('lg_directive', checked.problems)
    const versions = view.analysis.effective.filter((message) => message.type === 'DIRECTIVE').map((message) => Number(message.fields['version']))
    const version = Math.max(0, ...versions.filter((value) => Number.isInteger(value))) + 1
    const body = typeof args['body'] === 'string' ? args['body'] : ''
    const posted = await channel.post({ type: 'DIRECTIVE', fields: { version, ...checked.fields }, body })
    return { text: `posted DIRECTIVE v${String(version)} as #${posted.seq} (${posted.id}); ${spec.note}`, seq: posted.seq, id: posted.id, version }
  }

  /** `lg_review` */
  async review(args: Record<string, unknown>): Promise<ToolOutput> {
    const { channel, messages } = await this.view('lg_review')
    const checked = checkReview(args, new Set(messages.map((message) => message.seq)))
    if (!checked.ok) return refuse('lg_review', checked.problems)
    const body = typeof args['body'] === 'string' ? args['body'] : ''
    const problem = this.deps.checkpoint()?.reviewProblem(checked.fields.refs, body)
    if (problem !== undefined) return refuse('lg_review', [problem])
    const posted = await channel.post({ type: 'REVIEW', fields: { ...checked.fields }, body })
    return { text: `posted REVIEW as #${posted.seq} (${posted.id}) with ${String(checked.fields.findings.length)} finding(s) numbered F-1..`, seq: posted.seq, id: posted.id }
  }

  /** `lg_decision` */
  async decision(args: Record<string, unknown>): Promise<ToolOutput> {
    const { channel, view } = await this.view('lg_decision')
    const checked = checkDecision(args, view.openQuestions)
    if (!checked.ok) return refuse('lg_decision', checked.problems)
    const posted = await channel.post({ type: 'DECISION', fields: { ...checked.fields } })
    return { text: `posted DECISION as #${posted.seq} (${posted.id}) answering ${checked.fields.answers.map((seq) => `#${seq}`).join(', ')}${checked.fields.approve_action === undefined ? '' : `, approving ${checked.fields.approve_action}`}`, seq: posted.seq, id: posted.id }
  }

  /** `lg_draft_reset` */
  async draftReset(args: Record<string, unknown>): Promise<ToolOutput> {
    const config = this.config()
    const mirror = this.repo('lg_draft_reset').mirror()
    const base = await mirror.resolveCommit(args['base'], 'base')
    try {
      const done = await this.draftsRepo(config, mirror.config.mirrorDir).reset(base)
      return { text: `drafts/ reset to ${base.slice(0, 12)} (${String(done.files)} files)`, base, files: done.files }
    } catch (error) {
      if (error instanceof DraftsError) return refuse('lg_draft_reset', [error.message])
      throw error
    }
  }

  /** `lg_patch_send` */
  async patchSend(args: Record<string, unknown>): Promise<ToolOutput> {
    const config = this.config()
    const channel = this.channel('lg_patch_send')
    if (channel.halted === true) throw new Error('lg_patch_send: the channel is halted by a human HALT')
    const mirror = this.repo('lg_patch_send').mirror()
    try {
      const { patch, delivered } = await this.draftsRepo(config, mirror.config.mirrorDir).send(typeof args['message'] === 'string' ? args['message'] : '', async (prepared) => {
        // CLAIM first: a PATCH names the claim it fulfils.
        const claim = await channel.post({ type: 'CLAIM', fields: { scope: claimScope(prepared), implementer: 'global' }, body: '' })
        try {
          const sent = await channel.post({
            type: 'PATCH',
            fields: { name: prepared.name, claim: claim.seq, base: prepared.base, format: 'git-format-patch', bytes: prepared.bytes, sha256: prepared.sha256 },
            body: typeof args['message'] === 'string' ? args['message'] : '',
            attachments: [{ name: prepared.name, content: prepared.data }],
          })
          return { claim, patch: sent }
        } catch (error) {
          throw new Error(`CLAIM #${claim.seq} was posted but the PATCH was not: ${error instanceof Error ? error.message : String(error)}; calling lg_patch_send again resends it`)
        }
      })
      return {
        text: `posted CLAIM #${delivered.claim.seq} and PATCH #${delivered.patch.seq} (${patch.name}, ${String(patch.bytes)} bytes, sha256 ${patch.sha256.slice(0, 12)}, base ${patch.base.slice(0, 12)}, ${String(patch.paths.length)} path(s))`,
        claim: delivered.claim.seq,
        patch: delivered.patch.seq,
        name: patch.name,
        bytes: patch.bytes,
        sha256: patch.sha256,
        base: patch.base,
      }
    } catch (error) {
      if (error instanceof DraftsError) return refuse('lg_patch_send', [error.message])
      throw error
    }
  }

  /** `lg_stop` */
  async stop(args: Record<string, unknown>, agent?: unknown): Promise<ToolOutput> {
    const config = this.config()
    const repo = this.repo('lg_stop')
    const commit = args['final_commit']
    if (typeof commit !== 'string' || !SHA40.test(commit)) return refuse('lg_stop', ['final_commit must be a full 40-character lowercase commit id'])

    // Judge the mirror as it is on the remote now; a stale mirror would approve stale work.
    let synced: { head: string; remoteHead: string; equal: boolean }
    try {
      synced = await repo.sync(agent)
    } catch (error) {
      return refuse('lg_stop', [`lg_repo_sync failed: ${error instanceof Error ? error.message : String(error)}`])
    }
    if (this.state.paused) return refuse('lg_stop', [this.state.denial()])
    const reasons: string[] = []
    if (!synced.equal) reasons.push(`the mirror (${synced.head.slice(0, 12)}) differs from the remote (${synced.remoteHead.slice(0, 12)}) after sync`)
    if (commit !== synced.head) reasons.push(`final_commit ${commit.slice(0, 12)} is not the mirror HEAD ${synced.head.slice(0, 12)}`)
    if (commit !== synced.remoteHead) reasons.push(`final_commit ${commit.slice(0, 12)} is not the remote head ${synced.remoteHead.slice(0, 12)}`)
    if (reasons.length > 0) return refuse('lg_stop', reasons)

    const { channel, view } = await this.view('lg_stop')
    const directive = view.directive
    if (directive === undefined) return refuse('lg_stop', ['the channel has no DIRECTIVE, so there are no acceptance criteria to stop on'])
    const required = (Array.isArray(directive.fields['acceptance']) ? (directive.fields['acceptance'] as unknown[]) : [])
      .map((item) => (typeof item === 'object' && item !== null ? String((item as Record<string, unknown>)['id']) : ''))
      .filter((id) => id.length > 0)

    const given = new Map<string, string[]>()
    if (!Array.isArray(args['acceptance'])) return refuse('lg_stop', ['acceptance must be a list of {id: "AC-n", evidence: ["<manifest path>", ...]}'])
    for (const item of args['acceptance'] as unknown[]) {
      const record = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
      const id = record['id']
      const evidence = record['evidence']
      if (typeof id !== 'string' || !Array.isArray(evidence) || evidence.some((path) => typeof path !== 'string')) {
        reasons.push(`acceptance entry ${JSON.stringify(item)} is not {id: "AC-n", evidence: [paths]}`)
      } else if (given.has(id)) reasons.push(`${id} is listed twice`)
      else given.set(id, evidence as string[])
    }
    for (const id of required) if (!given.has(id)) reasons.push(`${id} of DIRECTIVE v${String(directive.fields['version'])} has no entry`)
    for (const id of given.keys()) if (!required.includes(id)) reasons.push(`${id} is not a criterion of DIRECTIVE v${String(directive.fields['version'])}`)
    if (reasons.length > 0) return refuse('lg_stop', reasons)

    const mirrorDir = repo.mirror().config.mirrorDir
    const digest = await treeDigestAt(mirrorDir, commit, config.evidenceRoot)
    for (const id of required) {
      const paths = given.get(id) ?? []
      if (paths.length === 0) reasons.push(`${id}: no evidence cited`)
      for (const path of paths) {
        for (const problem of await manifestProblems({ mirrorDir, commit, path, digest, evidenceRoot: config.evidenceRoot })) reasons.push(`${id}: ${path}: ${problem}`)
      }
    }
    if (reasons.length > 0) return refuse('lg_stop', reasons)

    const posted = await channel.post({ type: 'STOP', fields: { final_commit: commit, acceptance: required.map((id) => ({ id, evidence: given.get(id) ?? [] })) } })
    return { text: `posted STOP as #${posted.seq} (${posted.id}) at ${commit.slice(0, 12)}; ${String(required.length)} criteria have current real evidence`, seq: posted.seq, id: posted.id }
  }
}

/** The CLAIM scope: every path, or its top-level directories when the list is long. */
function claimScope(patch: PreparedPatch): string[] {
  if (patch.paths.length <= 200) return [...patch.paths]
  return [...new Set(patch.paths.map((path) => (path.includes('/') ? `${path.split('/')[0] ?? ''}/` : path)))].sort()
}

type ToolDefinition = Parameters<Context['tools']['register']>[0]

interface Spec {
  readonly name: string
  readonly description: string
  readonly properties: Record<string, unknown>
  readonly required: readonly string[]
  readonly run: (args: Record<string, unknown>, agent: unknown) => Promise<ToolOutput>
}

/**
 * Compose the six write tools.
 * @param ctx - plugin context.
 * @param raw - composition config.
 */
export function apply(ctx: Context, raw: RawDirectiveConfig = {}): void {
  const runtime = new DirectiveRuntime({
    raw,
    workspace: () => serviceOf<string>(ctx, 'lgWorkspace'),
    channel: () => serviceOf<ChannelLike>(ctx, 'lgChannel'),
    repo: () => serviceOf<RepoRuntime>(ctx, 'lgRepo'),
    checkpoint: () => serviceOf<CheckpointLike>(ctx, 'lgCheckpoint'),
  })
  const strings = { type: 'array', items: { type: 'string' } }
  const specs: Spec[] = [
    {
      name: 'lg_directive',
      description:
        'Send a DIRECTIVE. The version is the current one plus one. A DIRECTIVE replaces the previous one as a whole: restate goal, priorities, every acceptance criterion (AC-1, AC-2, ... in order) and scope in full, never "same as v2". Every acceptance text must cite a requirement id of the spec (e.g. GD-1). Refused when anything is missing, incremental, or cites no known requirement.',
      properties: {
        goal: { type: 'string' },
        priorities: strings,
        acceptance: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
        scope: { type: 'object', properties: { in: strings, out: strings }, required: ['in', 'out'] },
        body: { type: 'string' },
      },
      required: ['goal', 'priorities', 'acceptance', 'scope'],
      run: async (args) => await runtime.directive(args),
    },
    {
      name: 'lg_review',
      description:
        'Send a REVIEW. refs are the messages reviewed; findings are numbered F-1, F-2, ... by the tool (each REVIEW restarts at F-1). verdict "accepted" cannot carry a blocking finding. While a global checkpoint is open, a REVIEW citing its anchor must answer Q1, Q2 and Q3 in the body.',
      properties: {
        refs: strings,
        verdict: { type: 'string', enum: ['accepted', 'changes-requested'] },
        findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['blocking', 'minor'] }, text: { type: 'string' } }, required: ['severity', 'text'] } },
        body: { type: 'string' },
      },
      required: ['refs', 'verdict', 'findings'],
      run: async (args) => await runtime.review(args),
    },
    {
      name: 'lg_decision',
      description:
        'Send a DECISION answering open QUESTIONs or OBJECTIONs by sequence. approve_action, when given, must be exactly the action fingerprint the question carries; leave it out to decline.',
      properties: { answers: strings, choice: { type: 'string' }, reason: { type: 'string' }, approve_action: { type: 'string' } },
      required: ['answers', 'choice', 'reason'],
      run: async (args) => await runtime.decision(args),
    },
    {
      name: 'lg_draft_reset',
      description: 'Reset drafts/ to a commit of the read-only mirror (any revision the mirror resolves). Replaces everything in drafts/.',
      properties: { base: { type: 'string' } },
      required: ['base'],
      run: async (args) => await runtime.draftReset(args),
    },
    {
      name: 'lg_patch_send',
      description:
        'Commit the changes in drafts/ on top of the base set by lg_draft_reset, render git format-patch for everything since that base, and send a CLAIM followed by a PATCH with the patch attached. bytes and sha256 are computed by the tool. Refused when there are no changes or the patch touches the evidence directory.',
      properties: { message: { type: 'string' } },
      required: ['message'],
      run: async (args) => await runtime.patchSend(args),
    },
    {
      name: 'lg_stop',
      description:
        'Send STOP. Syncs the mirror first; final_commit must be the mirror HEAD and the remote head. acceptance must cover every criterion of the current DIRECTIVE, each with evidence manifest paths (evidence/<topic>/manifest.json) that are real, written on a clean worktree, current for final_commit, and whose raw files match. Refused otherwise, with the reason per criterion.',
      properties: {
        final_commit: { type: 'string' },
        acceptance: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, evidence: strings }, required: ['id', 'evidence'] } },
      },
      required: ['final_commit', 'acceptance'],
      run: async (args, agent) => await runtime.stop(args, agent),
    },
  ]

  for (const spec of specs) {
    ctx.tools.register({
      name: spec.name,
      description: spec.description,
      parameters: { type: 'object', properties: spec.properties, required: [...spec.required] },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_args: unknown, value: ToolOutput) => [{ type: 'text' as const, text: value.text }],
      },
      async execute(args: unknown, exec?: { agent?: unknown }) {
        return await spec.run(typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}, exec?.agent)
      },
    } as ToolDefinition)
  }
}
