/**
 * Config resolution and defaults for `lg-channel`.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The side of the channel this process plays. */
export type Role = 'local' | 'global'

/** Fully resolved channel configuration. */
export interface ChannelConfig {
  /** Git URL of the channel repository (`file://`, `https://`, or `ssh`). */
  readonly repo: string
  /** Branch holding `messages/`, `attachments/`, and `status/`. */
  readonly branch: string
  readonly role: Role
  /** Poll period in seconds; the contract default is 60. */
  readonly pollSeconds: number
  /** Whether `lg_record_relayed` is available (docs/channel-git.md §8). */
  readonly relay: boolean
  /** Bare mirror used for fetch/push plumbing. */
  readonly cloneDir: string
  /** Directory holding the durable cursor and binding. */
  readonly stateDir: string
  /** Stable short name derived from the repo URL. */
  readonly slug: string
}

/** Raw plugin config as it appears in `cordis.patch.yml`. */
export interface RawChannelConfig {
  readonly repo?: unknown
  readonly branch?: unknown
  readonly role?: unknown
  readonly pollSeconds?: unknown
  readonly relay?: unknown
  readonly cloneDir?: unknown
  readonly stateDir?: unknown
}

/** The configured DSH home, falling back to `~/.dsh` when the process has no env. */
export function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** Short, filesystem-safe repository identity plus a hash of the full URL. */
export function repoSlug(repo: string): string {
  const tail = repo.replace(/\/+$/, '').split('/').pop() ?? 'channel'
  const base = tail.replace(/\.git$/, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'channel'
  const digest = createHash('sha256').update(repo, 'utf8').digest('hex').slice(0, 8)
  return `${base}-${digest}`
}

function asBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`lg-channel: ${field} must be a boolean`)
  return value
}

/**
 * Validate raw config and fill in the documented defaults.
 * @param raw - config object from the composition.
 * @returns the resolved configuration.
 * @throws TypeError when a required field is missing or a value is out of range.
 */
export function resolveChannelConfig(raw: RawChannelConfig): ChannelConfig {
  if (typeof raw.repo !== 'string' || raw.repo.trim().length === 0) {
    throw new TypeError('lg-channel: "repo" is required (git URL of the channel repository)')
  }
  if (raw.role !== 'local' && raw.role !== 'global') {
    throw new TypeError('lg-channel: "role" is required and must be "local" or "global"')
  }
  const repo = raw.repo
  const branch = raw.branch === undefined ? 'main' : String(raw.branch)
  const pollSeconds = raw.pollSeconds === undefined ? 60 : Number(raw.pollSeconds)
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1) {
    throw new TypeError('lg-channel: "pollSeconds" must be a positive number')
  }
  const relay = asBoolean(raw.relay, false, 'relay')
  const home = dshHome()
  const slug = repoSlug(repo)
  const stateDir = raw.stateDir === undefined ? join(home, 'lg') : String(raw.stateDir)
  const cloneDir = raw.cloneDir === undefined ? join(home, 'lg', `${slug}.git`) : String(raw.cloneDir)
  return { repo, branch, role: raw.role, pollSeconds, relay, cloneDir, stateDir, slug }
}
