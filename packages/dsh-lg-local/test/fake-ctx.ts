/** A minimal stand-in for the cordis context: just what the Local plugins touch. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Guard = (exec: { name: string; arguments: unknown; agent?: unknown }) => string | undefined
type Handler = (payload: never) => unknown

export interface Tool {
  name: string
  execute: (args: unknown, exec: { agent?: unknown }) => Promise<unknown>
  render?: unknown
}

export interface FakeCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any
  guards: Guard[]
  tools: Map<string, Tool>
  services: Map<string, unknown>
  handlers: Map<string, Handler[]>
  logs: string[]
  /** First denial among the registered guards, as dsh's monotonic guard layer reports it. */
  guard(name: string, args: unknown, agent?: unknown): string | undefined
  emit(event: string, payload: unknown): Promise<void>
  tool(name: string): Tool
}

export function fakeCtx(services: Record<string, unknown> = {}): FakeCtx {
  const provided = new Map<string, unknown>(Object.entries(services))
  const guards: Guard[] = []
  const tools = new Map<string, Tool>()
  const handlers = new Map<string, Handler[]>()
  const logs: string[] = []
  const ctx = {
    tools: {
      guard: (guard: Guard) => {
        guards.push(guard)
        return () => undefined
      },
      register: (definition: Tool) => {
        tools.set(definition.name, definition)
        return () => undefined
      },
    },
    effect: (setup: () => (() => void) | void) => setup(),
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    get: (name: string) => provided.get(name),
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => undefined
    },
    logger: () => ({
      info: (text: string) => logs.push(`info ${text}`),
      warn: (text: string) => logs.push(`warn ${text}`),
    }),
  }
  return {
    ctx,
    guards,
    tools,
    services: provided,
    handlers,
    logs,
    guard(name, args, agent) {
      for (const guard of guards) {
        const reason = guard({ name, arguments: args, ...(agent === undefined ? {} : { agent }) })
        if (reason !== undefined) return reason
      }
      return undefined
    },
    async emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) await handler(payload as never)
    },
    tool(name) {
      const found = tools.get(name)
      if (found === undefined) throw new Error(`no tool ${name}`)
      return found
    },
  }
}

/** An agent whose session started in `cwd`. */
export const agentIn = (cwd: string): { session: { header: { cwd: string } } } => ({ session: { header: { cwd } } })

export const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

export function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `lgl-${prefix}-`))
}

/** A repo with one commit containing `files`. */
export function repo(files: Record<string, string> = { 'a.txt': 'one\n' }): string {
  const dir = tmp('repo')
  git(dir, 'init', '--quiet', '--initial-branch=main', '.')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'config', 'user.email', 'test@invalid')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', 'base')
  return dir
}
