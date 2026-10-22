/** The human's side: send tasks and notes, read the log. Uses the human token only. */
import { newId } from './ids.js'
import { formatLine } from './format.js'

const SUMMARY_LIMIT = 480

/** Post a task or note to one side. Long text goes into `body`. */
export async function say(comm, { to, text, kind = 'task' }) {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('empty message')
  const { id } = await comm.post({
    kind,
    to,
    summary: trimmed.slice(0, SUMMARY_LIMIT),
    body: trimmed.length > SUMMARY_LIMIT ? trimmed : undefined,
    client_id: newId(),
  })
  return id
}

/** Messages, oldest first, optionally filtered by kind and recipient. */
export async function log(comm, { kind, to } = {}) {
  const { messages } = await comm.log()
  return messages
    .filter((m) => (kind === undefined || m.kind === kind) && (to === undefined || m.to === to))
    .map(formatLine)
}
