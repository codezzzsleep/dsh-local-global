import { randomBytes } from 'node:crypto'

/** Sortable by creation time: a 15-digit millisecond prefix plus a random suffix. */
export function newId(now = Date.now()) {
  return `${String(now).padStart(15, '0')}-${randomBytes(4).toString('hex')}`
}
