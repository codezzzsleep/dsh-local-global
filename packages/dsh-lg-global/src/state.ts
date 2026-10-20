/**
 * Shared pause state for the Global side.
 *
 * `lg-integrity` writes it; `lg-scope`'s guard reads it. A failed check must
 * stop Global from working — logging is not enough, and throwing inside
 * `apply()` only stops the integrity plugin itself from loading.
 */

/** One reason Global is paused. */
export interface PauseReason {
  readonly code: string
  readonly detail: string
  readonly at: string
}

/** Process-wide pause state shared by every lg-global plugin. */
export class GuardState {
  private verified = false
  private reasons: PauseReason[] = [
    { code: 'not-verified', detail: 'integrity has not reported a clean composition yet', at: new Date(0).toISOString() },
  ]

  /** Record a failure; repeated codes replace their previous detail. */
  pause(code: string, detail: string): void {
    const entry: PauseReason = { code, detail, at: new Date().toISOString() }
    const index = this.reasons.findIndex((reason) => reason.code === code)
    if (index === -1) this.reasons.push(entry)
    else this.reasons[index] = entry
  }

  /** Drop one failure after a successful recheck. */
  resume(code: string): void {
    this.reasons = this.reasons.filter((reason) => reason.code !== code)
  }

  /** True until integrity reports a clean composition, or while any check fails. */
  get paused(): boolean {
    return !this.verified || this.reasons.length > 0
  }

  /** Mark the composition verified; only integrity calls this, and only on a clean run. */
  markVerified(): void {
    this.verified = true
    this.reasons = this.reasons.filter((reason) => reason.code !== 'not-verified')
  }

  /** Drop the verified mark so the next failed check pauses again. */
  invalidate(): void {
    this.verified = false
  }

  /** First reason, used in the denial message. */
  get first(): PauseReason | undefined {
    return this.reasons[0]
  }

  /** Snapshot for tools and logs. */
  list(): readonly PauseReason[] {
    return [...this.reasons]
  }

  /** Human-readable denial reason. */
  denial(): string {
    const first = this.first
    return first === undefined ? 'lg-global paused' : `lg-global paused: ${first.code} — ${first.detail}`
  }
}

/** The one instance every lg-global plugin shares inside a process. */
export const lgState = new GuardState()
