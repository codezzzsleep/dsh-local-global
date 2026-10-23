/**
 * The durable record of spent approvals.
 *
 * Each DECISION that approved an action may be used once. The channel only
 * learns of a use when a later REPORT lists it in `consumed_approvals`, so the
 * gate keeps its own record on disk: a spent approval stays spent after a
 * restart, and `lg-report-gate` can ask which spends no REPORT has listed yet.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
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
    this.channel = channel
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
