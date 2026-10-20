/**
 * C-class action fingerprints (docs/channel-git.md §7).
 */
import { createHash } from 'node:crypto'

/**
 * Fingerprint one matched action so a DECISION can approve exactly that command.
 *
 * Shape: `<rule id>:<first 12 hex of sha256(command UTF-8)>`.
 * @param ruleId - the lg-action-gate rule that matched.
 * @param command - the exact command text that will run.
 * @returns the fingerprint carried by QUESTION.action and DECISION.approve_action.
 */
export function actionFingerprint(ruleId: string, command: string): string {
  const digest = createHash('sha256').update(command, 'utf8').digest('hex').slice(0, 12)
  return `${ruleId}:${digest}`
}
