/**
 * Helpers shared by the Local plugins: service lookup, the session's current
 * directory, and physical path resolution.
 */
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

/** `ctx.get(name)` without a hard dependency on the service's package. */
export function service<T>(ctx: unknown, name: string): T | undefined {
  try {
    return (ctx as { get?: (name: string) => unknown }).get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

/** Publish a service; the returned disposer is a no-op when `ctx.provide` is absent. */
export function provide(ctx: unknown, name: string, value: unknown): () => void {
  const release = (ctx as { provide?: (name: string, value: unknown) => () => void }).provide?.(name, value)
  return () => release?.()
}

/**
 * The session's current working directory.
 *
 * `session.header.cwd` is the original project; the directory the agent has
 * since moved to lives in the `workingDirectory` service.
 * @param ctx - plugin context.
 * @param agent - the agent a tool call runs for.
 * @returns an absolute directory.
 */
export function sessionCwd(ctx: unknown, agent: unknown): string {
  const session = (agent as { session?: { header?: { cwd?: string } } } | undefined)?.session
  const directories = service<{ get?: (session: unknown) => string }>(ctx, 'workingDirectory')
  if (session !== undefined && directories?.get !== undefined) {
    try {
      const cwd = directories.get(session)
      if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd
    } catch {
      // fall through to the header
    }
  }
  const header = session?.header?.cwd
  return typeof header === 'string' && header.length > 0 ? header : process.cwd()
}

/** `~` and `~/x` expanded against the home directory. */
export function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Absolute path with symlinks resolved as far as the path exists.
 *
 * A path that does not exist yet (a file about to be written) resolves its
 * deepest existing ancestor and keeps the rest, so a symlinked directory
 * cannot hide the real destination.
 * @param path - any path; relative ones resolve against `base`.
 * @param base - directory for relative paths.
 * @returns the physical absolute path.
 */
export function physicalPath(path: string, base: string = process.cwd()): string {
  const absolute = resolvePath(base, expandTilde(path))
  let head = absolute
  const tail: string[] = []
  while (!existsSync(head)) {
    const parent = dirname(head)
    if (parent === head) return absolute
    tail.unshift(head.slice(parent.length).replace(/^\/+/, ''))
    head = parent
  }
  try {
    return resolvePath(realpathSync.native(head), ...tail)
  } catch {
    return absolute
  }
}

/** Whether `target` equals `root` or sits inside it. */
export function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`)
}
