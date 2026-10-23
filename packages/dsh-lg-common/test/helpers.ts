import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { formatMessage, type MessageType, type Sender } from '@local-global/lg-protocol'
import { ChannelRuntime } from '../src/channel.js'
import { resolveChannelConfig } from '../src/config.js'
import { ChannelRepo, runGit } from '../src/git.js'

/** One recorded call on a stub agent. */
export interface Call {
  readonly kind: 'steer' | 'followup' | 'inject' | 'cancel'
  readonly text: string
}

/** Stands in for a dsh Agent: records what the channel does to it. */
export class AgentStub {
  status: 'idle' | 'running' = 'idle'
  failure: Error | undefined
  readonly calls: Call[] = []

  private record(kind: Call['kind'], message?: { content: readonly { text: string }[] }): void {
    if (this.failure !== undefined && kind !== 'cancel') throw this.failure
    this.calls.push({ kind, text: message?.content[0]?.text ?? '' })
  }

  steer(message: { content: readonly { text: string }[] }): void {
    this.record('steer', message)
  }

  followup(message: { content: readonly { text: string }[] }): void {
    this.record('followup', message)
  }

  inject(message: { content: readonly { text: string }[] }): void {
    this.record('inject', message)
  }

  cancel(): void {
    this.record('cancel')
  }

  /** Texts delivered to the model, in order (cancels excluded). */
  get texts(): string[] {
    return this.calls.filter((call) => call.kind !== 'cancel').map((call) => call.text)
  }
}

/** A throwaway channel remote plus helpers to open sides of it. */
export class Rig {
  readonly agents = new Map<string, AgentStub>()
  workspace = ''
  remote = ''
  private sides = 0

  async open(): Promise<void> {
    this.workspace = await mkdtemp(join(tmpdir(), 'lg-rig-'))
    this.remote = join(this.workspace, 'channel.git')
    await runGit(['init', '--bare', '--initial-branch', 'main', this.remote])
    await runGit(['config', 'protocol.file.allow', 'always'], { cwd: this.remote })
  }

  async close(): Promise<void> {
    await rm(this.workspace, { recursive: true, force: true })
  }

  context(): Context {
    return { agents: { get: (id: string) => this.agents.get(id) } } as unknown as Context
  }

  /** Start one side of the channel; `relay` defaults to on. */
  async side(role: 'local' | 'global', options: { name?: string; relay?: boolean; repo?: string } = {}): Promise<ChannelRuntime> {
    this.sides += 1
    const name = options.name ?? `${role}${String(this.sides)}`
    const config = resolveChannelConfig({
      repo: options.repo ?? `file://${this.remote}`,
      role,
      pollSeconds: 10,
      relay: options.relay ?? true,
      cloneDir: join(this.workspace, `${name}-mirror.git`),
      stateDir: join(this.workspace, `${name}-state`),
    })
    const channel = new ChannelRuntime(this.context(), config)
    await channel.start()
    return channel
  }

  /** Bind a side to a fresh stub agent and return the stub. */
  async bound(channel: ChannelRuntime, id = 's1'): Promise<AgentStub> {
    const agent = new AgentStub()
    this.agents.set(id, agent)
    await channel.bind(id)
    return agent
  }

  private raw?: ChannelRepo

  /** Write a message file straight into the archive, bypassing every check a side applies. */
  async write(sender: Sender, type: MessageType | string, text: string): Promise<string> {
    if (this.raw === undefined) {
      this.raw = new ChannelRepo(join(this.workspace, 'raw.git'), this.remote, 'main')
      await this.raw.ensure()
    }
    const result = await this.raw.append((seq) => ({
      sender,
      type: type as MessageType,
      filename: `${seq}-${sender}-${type}.md`,
      text,
    }))
    return result.filename
  }

  /** Render fields into message text, as a well-behaved writer would, and archive it. */
  async put(sender: Sender, type: MessageType, fields: Record<string, unknown>, body = ''): Promise<string> {
    return await this.write(sender, type, formatMessage({ seq: '9999', sender, type, fields, body }).text)
  }
}

export const COMMIT = '7c9ce1e63a4a750a16407727e20a8d5028b02a59'

/** Fields that satisfy docs/channel-git.md §4, per type, for the ones the tests use. */
export const VALID = {
  CLAIM: (extra: Record<string, unknown> = {}) => ({ scope: ['x'], implementer: 'global', ...extra }),
  REPORT: (extra: Record<string, unknown> = {}) => ({ refs: ['0001'], commit: COMMIT, directive_version: 1, evidence: [], negative_tests: [], ...extra }),
  QUESTION: (extra: Record<string, unknown> = {}) => ({ options: ['A'], blocking: false, default_action: 'wait', ...extra }),
  DECISION: (extra: Record<string, unknown> = {}) => ({ answers: ['0001'], choice: 'A', reason: 'ok', ...extra }),
  REVIEW: (extra: Record<string, unknown> = {}) => ({ refs: ['0001'], verdict: 'changes-requested', findings: [{ id: 'F-1', severity: 'blocking', text: 'fix' }], ...extra }),
  HALT: (extra: Record<string, unknown> = {}) => ({ reason: 'stop', ...extra }),
}
