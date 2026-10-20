/**
 * Parser for one channel message file (docs/channel-git.md §2–§3).
 */
import { parse as parseYaml } from 'yaml'
import type { MessageError, ParseResult, Sender, MessageType } from './types.js'

const FILENAME_RE = /^(\d{4})-(human|global|local)-([A-Z_]+)\.md$/
const HEADER_RE = /^\[LG ([A-Z_]+) from (human|global|local)\]$/
const TERMINATOR = '---'

/** Result of splitting `messages/<name>` into its declared coordinates. */
export interface FilenameParts {
  readonly seq: string
  readonly sender: Sender
  readonly type: string
}

/**
 * Read the sequence, sender, and type a file name declares.
 * @param filename - basename under `messages/`.
 * @returns the declared parts, or the format error that rejects it.
 */
export function parseFilename(filename: string): { ok: true; parts: FilenameParts } | { ok: false; errors: MessageError[] } {
  const match = FILENAME_RE.exec(filename)
  if (match === null) {
    return {
      ok: false,
      errors: [{ code: 'filename-format', message: `file name "${filename}" is not <4 digits>-<human|global|local>-<TYPE>.md` }],
    }
  }
  return { ok: true, parts: { seq: match[1]!, sender: match[2] as Sender, type: match[3]! } }
}

/**
 * Parse one message file.
 *
 * Collects every structural problem instead of stopping at the first, so a
 * rejected message can be reported with its complete reason list.
 * @param filename - basename under `messages/`, used to cross-check the header.
 * @param text - complete file text.
 * @returns the parsed message, or the errors that reject it.
 */
export function parseMessage(filename: string, text: string): ParseResult {
  const errors: MessageError[] = []
  const named = parseFilename(filename)
  if (!named.ok) return { ok: false, errors: named.errors }
  const { seq, sender: fileSender, type: fileType } = named.parts

  const lines = text.split('\n')
  const firstLine = (lines[0] ?? '').replace(/\r$/, '')
  const header = HEADER_RE.exec(firstLine)
  if (header === null) {
    errors.push({
      code: 'header-format',
      message: `first line "${firstLine}" does not match [LG <TYPE> from <sender>]`,
    })
    return { ok: false, errors }
  }

  const headerType = header[1]!
  const headerSender = header[2] as Sender
  if (headerSender !== fileSender) {
    errors.push({
      code: 'sender-mismatch',
      message: `file name says sender "${fileSender}" but the first line says "${headerSender}"`,
    })
  }
  if (headerType !== fileType) {
    errors.push({
      code: 'type-mismatch',
      message: `file name says type "${fileType}" but the first line says "${headerType}"`,
    })
  }
  if (errors.length > 0) return { ok: false, errors }

  let terminator = -1
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').replace(/\r$/, '') === TERMINATOR) {
      terminator = index
      break
    }
  }

  const yamlLines = terminator === -1 ? lines.slice(1) : lines.slice(1, terminator)
  const bodyLines = terminator === -1 ? [] : lines.slice(terminator + 1)
  const yamlText = yamlLines.join('\n').trim()

  let fields: Record<string, unknown> = {}
  if (yamlText.length > 0) {
    try {
      const parsed: unknown = parseYaml(yamlText, { prettyErrors: false })
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push({ code: 'fields-not-mapping', message: 'the field region is not a YAML mapping' })
      } else {
        fields = parsed as Record<string, unknown>
      }
    } catch (error) {
      errors.push({
        code: 'fields-yaml',
        message: `the field region is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    message: {
      seq,
      sender: fileSender,
      type: fileType as MessageType,
      filename,
      fields,
      body: bodyLines.join('\n'),
      raw: text,
    },
  }
}
