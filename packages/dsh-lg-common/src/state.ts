/**
 * Durable channel state: the delivery cursor and the one bound session.
 *
 * Lives under the DSH home (`$DSH_HOME/lg/<slug>.json`) so it survives a
 * restart with the profile; it is never committed to the channel repository.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Role } from './config.js'
import { redactSecrets } from './redact.js'

/** Persisted state of one `lg-channel` instance. */
export interface PersistedState {
  readonly repo: string
  readonly role: Role
  /** Highest sequence delivered to the bound session. */
  readonly cursor: string
  /** Session this side delivers to, once `/lg-bind` ran. */
  readonly boundSessionId: string | null
  /** Ids already handed to the bound session, so a re-fetch never repeats one. */
  readonly deliveredIds: string[]
  /** Set when a human HALT was delivered; polling stops for good. */
  readonly halted: boolean
  /** Message files this side archived itself (relay); never delivered back (CH-9). */
  readonly archived: string[]
  /** Sent-copy mismatches already reported, as `<file>@<archive digest>`. */
  readonly reportedMismatches: string[]
  readonly updatedAt: string
}

/** The state a fresh channel starts from. */
export function initialState(repo: string, role: Role): PersistedState {
  return {
    // Only a redacted URL is kept on disk: the state file is for matching, not for connecting.
    repo: redactSecrets(repo),
    role,
    cursor: '0000',
    boundSessionId: null,
    deliveredIds: [],
    halted: false,
    archived: [],
    reportedMismatches: [],
    updatedAt: new Date().toISOString(),
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Atomic JSON state file. */
export class StateStore {
  private readonly file: string
  private readonly legacyFile: string | undefined

  constructor(file: string, legacyFile?: string) {
    this.file = file
    this.legacyFile = legacyFile
  }

  /**
   * Adopt the pre-SPEC state file once, so a bound session keeps its cursor.
   *
   * The default `stateDir` moved from `$DSH_HOME/lg` to
   * `$DSH_HOME/lg/state/<仓库标识>`; without this a running deployment would
   * silently start from a fresh cursor — and CH-2 would then skip every message
   * the session had not yet seen. The old file is copied, never moved or
   * deleted, so a rollback still finds it.
   * @returns true when a legacy file was adopted.
   */
  async migrate(): Promise<boolean> {
    if (this.legacyFile === undefined) return false
    if (await this.exists(this.file)) return false
    try {
      const raw = await readFile(this.legacyFile, 'utf8')
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, raw, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /** Whether a path exists. */
  private async exists(path: string): Promise<boolean> {
    try {
      await readFile(path, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /**
   * Load persisted state, ignoring a file that belongs to another repo/role.
   * @param repo - configured repository URL.
   * @param role - configured role.
   * @returns the stored state, or a fresh one.
   */
  async load(repo: string, role: Role): Promise<PersistedState> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      // Older files hold the raw URL; compare redacted forms so both match.
      if (typeof parsed.repo !== 'string' || redactSecrets(parsed.repo) !== redactSecrets(repo) || parsed.role !== role) {
        return initialState(repo, role)
      }
      return {
        repo: redactSecrets(repo),
        role,
        cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '0000',
        deliveredIds: strings(parsed.deliveredIds),
        boundSessionId: typeof parsed.boundSessionId === 'string' ? parsed.boundSessionId : null,
        halted: parsed.halted === true,
        archived: strings(parsed.archived),
        reportedMismatches: strings(parsed.reportedMismatches),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      }
    } catch {
      return initialState(repo, role)
    }
  }

  /**
   * Persist state, replacing the file atomically.
   * @param state - the complete new state.
   */
  async save(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const scratch = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(scratch, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(scratch, this.file)
  }
}
