/**
 * Fail-safe HALT detection (SPEC "投递": HALT outranks everything).
 */
import { parseFilename } from './parse.js'

const HALT_HEADER_RE = /^\[LG HALT from human\]$/u

/**
 * Decide from the file name and first line alone whether a file is a human HALT.
 *
 * Deliberately ignores the field region: a HALT whose YAML is broken or whose
 * fields are wrong must still stop the session. Either coordinate is enough, so
 * a corrupted header or a renamed file cannot hide one.
 * @param filename - basename under `messages/`.
 * @param text - complete file text.
 * @returns true when the file names itself as a HALT from human.
 */
export function isHumanHalt(filename: string, text: string): boolean {
  const named = parseFilename(filename)
  if (named.ok && named.parts.sender === 'human' && named.parts.type === 'HALT') return true
  const firstLine = (text.split('\n', 1)[0] ?? '').replace(/\r$/u, '')
  return HALT_HEADER_RE.test(firstLine)
}
