/**
 * Message ids (SPEC "字段约定"): `G-0042`, `L-0107`, `H-0003`, increasing per sender.
 */
import { ID_PREFIX, ID_RE, type ParsedMessage, type Sender } from './types.js'

/** Render one sender's id for a counter value, at least four digits. */
export function formatId(sender: Sender, counter: number): string {
  return `${ID_PREFIX[sender]}${String(counter).padStart(4, '0')}`
}

/**
 * Highest counter any message already carries for a sender's prefix.
 *
 * Counts every well-formed id on every message, valid or not, so an id once
 * written is never handed out again.
 * @param sender - the sender whose prefix to scan.
 * @param messages - messages already in the channel.
 * @returns the highest counter, or 0 when there is none.
 */
export function highestIdCounter(sender: Sender, messages: readonly Pick<ParsedMessage, 'fields'>[]): number {
  let highest = 0
  for (const message of messages) {
    const id = message.fields['id']
    if (typeof id !== 'string' || !ID_RE.test(id) || !id.startsWith(ID_PREFIX[sender])) continue
    const counter = Number.parseInt(id.slice(2), 10)
    if (counter > highest) highest = counter
  }
  return highest
}

/**
 * Allocate the next id for a sender.
 * @param sender - who is about to write.
 * @param messages - messages already in the channel.
 * @returns the id one above the sender's highest, `L-0001` for a fresh sender.
 */
export function nextId(sender: Sender, messages: readonly Pick<ParsedMessage, 'fields'>[]): string {
  return formatId(sender, highestIdCounter(sender, messages) + 1)
}
