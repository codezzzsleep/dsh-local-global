/**
 * Shared shapes for {@link formatMessage}; kept in their own module so the
 * renderer and its callers do not form an import cycle.
 */
import type { MessageType, Sender } from './types.js'

/** Everything needed to render one message file. */
export interface FormatInput {
  /** Four-digit sequence. */
  readonly seq: string
  readonly sender: Sender
  readonly type: MessageType
  /** Field region; rendered as YAML in insertion order. */
  readonly fields: Readonly<Record<string, unknown>>
  /** Optional Markdown body after the `---` terminator. */
  readonly body?: string
}

/** Rendered message coordinates. */
export interface FormattedMessage {
  /** `messages/<seq>-<sender>-<type>.md`. */
  readonly filename: string
  /** Complete file text, LF, trailing newline. */
  readonly text: string
}

/** `messages/<4 digits>-<sender>-<TYPE>.md`. */
export const FILENAME_RE = /^(\d{4})-(human|global|local)-([A-Z_]+)\.md$/
