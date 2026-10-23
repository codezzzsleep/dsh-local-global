/**
 * Attachment naming (SPEC "文件与格式": `attachments/<序号>/`).
 */

/** Where a channel repository keeps message attachments. */
export const ATTACHMENTS_DIR = 'attachments'

const MAX_NAME_BYTES = 255

/**
 * Explain why a name cannot be an attachment file name.
 *
 * An attachment is a single file directly under `attachments/<seq>/`, so
 * separators, dot-names and control characters are all refused: none of them
 * can climb out of the message's own directory.
 * @param name - candidate file name.
 * @returns the problem, or `undefined` when the name is usable.
 */
export function attachmentNameProblem(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.length === 0) return 'attachment name must be a non-empty string'
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return `attachment name is longer than ${String(MAX_NAME_BYTES)} bytes`
  if (/[/\\]/u.test(name)) return 'attachment name must not contain a path separator'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(name)) return 'attachment name must not contain control characters'
  if (name.startsWith('.')) return 'attachment name must not start with a dot'
  return undefined
}

/**
 * Repository path of one attachment.
 * @param seq - four-digit sequence of the owning message.
 * @param name - attachment file name.
 * @returns `attachments/<seq>/<name>`.
 * @throws TypeError when the sequence or name is unusable.
 */
export function attachmentPath(seq: string, name: string): string {
  if (!/^\d{4}$/u.test(seq)) throw new TypeError(`attachment sequence must be four digits, got ${JSON.stringify(seq)}`)
  const problem = attachmentNameProblem(name)
  if (problem !== undefined) throw new TypeError(problem)
  return `${ATTACHMENTS_DIR}/${seq}/${name}`
}
