/**
 * Durable channel state: the delivery cursor and the one bound session.
 *
 * Lives under the DSH home (`$DSH_HOME/lg/<slug>.json`) so it survives a
 * restart with the profile; it is never committed to the channel repository.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Role } from './config.js'

/** Persisted state of one `lg-channel` instance. */
export interface PersistedState {
  readonly repo: string
  readonly role: Role
  /** Highest sequence delivered to the bound session. */
  readonly cursor: string
  /** Session this side delivers to, once `/lg-bind` ran. */
  readonly boundSessionId: string | null
  /** Set when a human HALT was delivered; polling stops for good. */
  readonly halted: boolean
  readonly updatedAt: string
}

/** The state a fresh channel starts from. */
export function initialState(repo: string, role: Role): PersistedState {
  return { repo, role, cursor: '0000', boundSessionId: null, halted: false, updatedAt: new Date().toISOString() }
}

/** Atomic JSON state file. */
export class StateStore {
  private readonly file: string

  constructor(file: string) {
    this.file = file
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
      if (parsed.repo !== repo || parsed.role !== role) return initialState(repo, role)
      return {
        repo,
        role,
        cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '0000',
        boundSessionId: typeof parsed.boundSessionId === 'string' ? parsed.boundSessionId : null,
        halted: parsed.halted === true,
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
    const scratch = `${this.file}.${process.pid}.tmp`
    await writeFile(scratch, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(scratch, this.file)
  }
}
