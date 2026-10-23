/**
 * A real world for the M4 suites: a code repository with a remote, a read-only
 * mirror of it, a real Local and Global side of a git channel, and the Global
 * write tools over all of them. Nothing is stubbed except the agent.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChannelRuntime } from '../../dsh-lg-common/src/channel.js'
import { AgentStub, Rig } from '../../dsh-lg-common/test/helpers.js'
import { DirectiveRuntime, type ChannelLike, type DirectiveDeps, type RawDirectiveConfig, type ToolOutput } from '../src/directive.js'
import { RepoMirror, runGit, type RepoRuntime } from '../src/repo.js'
import { GuardState } from '../src/state.js'

const identity = { GIT_AUTHOR_NAME: 'Local Dev', GIT_AUTHOR_EMAIL: 'local@dev.invalid', GIT_COMMITTER_NAME: 'Local Dev', GIT_COMMITTER_EMAIL: 'local@dev.invalid' }

export const SPEC = [
  '# Spec',
  '',
  '| 编号 | 要求 | 验证 |',
  '| --- | --- | --- |',
  '| GD-1 | directive | tests |',
  '| GD-2 | patch | e2e |',
  '| GD-3 | stop | tests |',
  '| QA-1 | tests pass | output |',
  '',
].join('\n')

/** Run git in a directory with Local's identity. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runGit(args, { cwd, env: identity, allowFile: true })).stdout.trim()
}

export interface World {
  readonly root: string
  readonly workspace: string
  readonly drafts: string
  readonly draftsGit: string
  /** Local's worktree; `remote` is its origin. */
  readonly work: string
  readonly remote: string
  readonly rig: Rig
  readonly global: ChannelRuntime
  readonly local: ChannelRuntime
  readonly mirror: RepoMirror
  readonly state: GuardState
  readonly runtime: DirectiveRuntime
  readonly agent: AgentStub
  /** Write files into Local's worktree, commit and push; returns the commit. */
  commit(files: Record<string, string>, message?: string): Promise<string>
  /** Fetch the remote into the mirror. */
  sync(): Promise<string>
  call(tool: 'lg_directive' | 'lg_review' | 'lg_decision' | 'lg_draft_reset' | 'lg_patch_send' | 'lg_stop', args: Record<string, unknown>): Promise<ToolOutput>
  /** Post a message as the human or Local through the real channel. */
  put(sender: 'human' | 'local' | 'global', type: string, fields: Record<string, unknown>, body?: string): Promise<string>
  close(): Promise<void>
}

export interface WorldOptions {
  files?: Record<string, string>
  config?: RawDirectiveConfig
  /** Keep the guard paused (the default after boot, as in a real session before integrity ran). */
  paused?: boolean
  deps?: Partial<DirectiveDeps>
}

/** Build the world; the guard is verified unless `paused` is set. */
export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'lg-m4-'))
  const workspace = join(root, 'workspace')
  const drafts = join(workspace, 'drafts')
  const draftsGit = join(workspace, 'drafts.git')
  mkdirSync(drafts, { recursive: true })
  const work = join(root, 'work')
  const remote = join(root, 'remote.git')
  await runGit(['init', '--quiet', '--bare', '--initial-branch', 'main', remote])
  await runGit(['init', '--quiet', '--initial-branch', 'main', work])
  const write = (files: Record<string, string>): void => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true })
      writeFileSync(join(work, path), text)
    }
  }
  write({ 'docs/spec.md': SPEC, 'src/a.txt': 'one\n', ...options.files })
  await git(work, 'add', '-A')
  await git(work, 'commit', '--quiet', '-m', 'base')
  await git(work, 'push', '--quiet', remote, 'main')

  const state = new GuardState()
  if (options.paused !== true) state.markVerified()
  state.setComponent('scope', { writeRoots: [drafts] })
  const mirror = new RepoMirror({ remote, branch: 'main', mirrorDir: join(root, 'mirror.git') }, { allowFile: true, state })
  await mirror.sync()
  const repo = {
    ready: Promise.resolve(),
    recheck: async () => [],
    mirror: () => mirror,
    sync: async () => {
      const done = await mirror.sync()
      return { ...done, equal: done.head === done.remoteHead }
    },
  } as unknown as RepoRuntime

  const rig = new Rig()
  await rig.open()
  const global = await rig.side('global', { relay: false })
  const local = await rig.side('local', { relay: false })
  const agent = await rig.bound(global)
  const runtime = new DirectiveRuntime({
    raw: { draftsDir: drafts, draftsGitDir: draftsGit, ...options.config },
    workspace: () => workspace,
    channel: () => global as unknown as ChannelLike,
    repo: () => repo,
    checkpoint: () => undefined,
    state,
    ...options.deps,
  })

  const methods = {
    lg_directive: (args: Record<string, unknown>) => runtime.directive(args),
    lg_review: (args: Record<string, unknown>) => runtime.review(args),
    lg_decision: (args: Record<string, unknown>) => runtime.decision(args),
    lg_draft_reset: (args: Record<string, unknown>) => runtime.draftReset(args),
    lg_patch_send: (args: Record<string, unknown>) => runtime.patchSend(args),
    lg_stop: (args: Record<string, unknown>) => runtime.stop(args),
  }
  return {
    root,
    workspace,
    drafts,
    draftsGit,
    work,
    remote,
    rig,
    global,
    local,
    mirror,
    state,
    runtime,
    agent,
    async commit(files, message = 'change') {
      write(files)
      await git(work, 'add', '-A')
      await git(work, 'commit', '--quiet', '-m', message)
      await git(work, 'push', '--quiet', remote, 'main')
      return await git(work, 'rev-parse', 'HEAD')
    },
    async sync() {
      return (await mirror.sync()).head
    },
    call: async (tool, args) => await methods[tool](args),
    async put(sender, type, fields, body = '') {
      return await rig.put(sender, type as never, fields, body)
    },
    async close() {
      await rig.close()
      if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    },
  }
}

/** A fully valid DIRECTIVE argument set; override one field to break it. */
export function validDirective(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: 'Ship the Global write exit with enforced invariants.',
    priorities: ['P1 build lg_directive', 'P2 build lg_stop'],
    acceptance: [
      { id: 'AC-1', text: 'GD-1: lg_directive refuses incomplete directives, shown by negative tests.' },
      { id: 'AC-2', text: 'GD-3: lg_stop refuses stale evidence.' },
    ],
    scope: { in: ['packages/dsh-lg-global'], out: ['packages/dsh-lg-local'] },
    ...overrides,
  }
}

/** The message text of a refused call. */
export async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the call to be refused, but it succeeded')
}
