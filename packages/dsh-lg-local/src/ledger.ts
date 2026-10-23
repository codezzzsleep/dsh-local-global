/**
 * The durable record of spent approvals.
 *
 * Each DECISION that approved an action may be used once. The channel only
 * learns of a use when a later REPORT lists it in `consumed_approvals`, so the
 * gate keeps its own record on disk: a spent approval stays spent after a
 * restart, and `lg-report-gate` can ask which spends no REPORT has listed yet.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One approval that has been used. */
export interface SpentApproval {
  /** Sequence of the approving DECISION. */
  readonly decision: string
  /** The action fingerprint it approved. */
  readonly fingerprint: string
  readonly consumedAt: string
}

/** File name under the state directory. */
export const LEDGER_FILE = 'consumed-approvals.json'

const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 30_000

/**
 * The per-channel key, with any userinfo removed: the ledger is plain JSON on
 * disk and must never hold a credential embedded in the repo URL.
 */
export function ledgerKey(repo: string): string {
  return repo.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1')
}

interface LedgerFile {
  readonly version: 1
  /** Spent approvals per channel repository, so two channels never share a decision number. */
  readonly channels: Record<string, SpentApproval[]>
}

/** The ledger cannot be read or written; callers must fail closed. */
export class LedgerError extends Error {}

/** Spent approvals of one channel, kept in one JSON file. */
export class ApprovalLedger {
  private readonly file: string
  private readonly channel: string

  constructor(stateDir: string, channel: string) {
    this.file = join(stateDir, LEDGER_FILE)
    this.channel = ledgerKey(channel)
  }

  private load(): LedgerFile {
    if (!existsSync(this.file)) return { version: 1, channels: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LedgerFile>
      if (parsed.version !== 1 || typeof parsed.channels !== 'object' || parsed.channels === null) throw new Error('unexpected shape')
      return { version: 1, channels: parsed.channels }
    } catch (error) {
      throw new LedgerError(`the approval ledger ${this.file} is unreadable (${error instanceof Error ? error.message : String(error)}); not guessing which approvals are spent`)
    }
  }

  /** Every approval spent for this channel. */
  list(): readonly SpentApproval[] {
    return this.load().channels[this.channel] ?? []
  }

  /**
   * Record spent approvals before the action runs.
   *
   * The file is replaced atomically and flushed, so a crash leaves either the
   * old record or the new one.
   * @param entries - the approvals being used.
   * @throws {LedgerError} when the record cannot be written.
   */
  spend(entries: readonly SpentApproval[]): void {
    const release = this.lock()
    try {
      this.spendLocked(entries)
    } finally {
      release()
    }
  }

  /**
   * Serialize read-modify-write across processes sharing the state dir, so two
   * gates can neither both spend one decision nor drop each other's entries.
   */
  private lock(): () => void {
    const path = `${this.file}.lock`
    mkdirSync(dirname(path), { recursive: true })
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        closeSync(openSync(path, 'wx', 0o600))
        return () => rmSync(path, { force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new LedgerError(`cannot lock ${path}: ${(error as Error).message}`)
        try {
          // A crashed holder must not block every C-class action forever.
          if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true })
        } catch {
          // Gone between the two calls: retry.
        }
        if (Date.now() > deadline) throw new LedgerError(`the approval ledger is locked by another process (${path}); not spending`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
    }
  }

  private spendLocked(entries: readonly SpentApproval[]): void {
    const state = this.load()
    const known = state.channels[this.channel] ?? []
    const fresh = entries.filter((entry) => !known.some((spent) => spent.decision === entry.decision))
    if (fresh.length === 0) return
    const next: LedgerFile = { version: 1, channels: { ...state.channels, [this.channel]: [...known, ...fresh] } }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const scratch = `${this.file}.${process.pid}.tmp`
      const fd = openSync(scratch, 'w', 0o600)
      try {
        writeSync(fd, `${JSON.stringify(next, null, 2)}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(scratch, this.file)
    } catch (error) {
      throw new LedgerError(`cannot record the spent approval in ${this.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
