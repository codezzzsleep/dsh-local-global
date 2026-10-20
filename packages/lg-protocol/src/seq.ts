/**
 * Sequence allocation for `messages/` (docs/channel-git.md §2, §6).
 */

/** `messages/<4 digits>-...md`, the only names that carry a sequence. */
const SEQ_IN_FILENAME_RE = /^(\d{4})-[a-z]+-[A-Z_]+\.md$/

/**
 * Compute the next sequence number from the names already present.
 *
 * Non-message names are ignored, so stray attachments or README files do not
 * shift the counter.
 * @param filenames - basenames currently under `messages/`.
 * @returns the next four-digit sequence, `0001` for an empty channel.
 * @throws RangeError when the channel has reached 9999.
 */
export function nextSeq(filenames: readonly string[]): string {
  let highest = 0
  for (const name of filenames) {
    const match = SEQ_IN_FILENAME_RE.exec(name)
    if (match === null) continue
    const value = Number.parseInt(match[1]!, 10)
    if (value > highest) highest = value
  }
  const next = highest + 1
  if (next > 9999) throw new RangeError('channel sequence exhausted at 9999')
  return String(next).padStart(4, '0')
}

/**
 * Detect gaps and duplicates in a sequence of message numbers.
 * @param seqs - four-digit sequences in ascending file order.
 * @returns one entry per anomaly; empty when the run is contiguous from `0001`.
 */
export function findSeqAnomalies(seqs: readonly string[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  let expected = 1
  for (const seq of seqs) {
    if (seen.has(seq)) {
      // A duplicate consumes no number, so it must not shift the expectation.
      problems.push(`duplicate sequence ${seq}`)
      continue
    }
    seen.add(seq)
    const value = Number.parseInt(seq, 10)
    if (value !== expected) {
      problems.push(`expected ${String(expected).padStart(4, '0')} but found ${seq}`)
    }
    expected = value + 1
  }
  return problems
}
