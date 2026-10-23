/**
 * Renderer for one channel message file (docs/channel-git.md §2–§3).
 */
import { stringify as stringifyYaml } from 'yaml'
import type { FormattedMessage, FormatInput } from './format-types.js'
import type { ParsedMessage } from './types.js'

function assemble(
  input: { seq: string; sender: string; type: string },
  yamlText: string,
  body: string,
): FormattedMessage {
  const yamlBlock = yamlText.length === 0 ? '' : `${yamlText}\n`
  // The body is kept verbatim; only a missing final newline is supplied.
  const bodyText = body.length === 0 || body.endsWith('\n') ? body : `${body}\n`
  return {
    filename: `${input.seq}-${input.sender}-${input.type}.md`,
    text: `[LG ${input.type} from ${input.sender}]\n${yamlBlock}---\n${bodyText}`,
  }
}

/**
 * Render a message into the exact file name and file text the contract expects.
 *
 * The header and field region use LF and the file ends with a newline. The body
 * is written verbatim, so its own blank trailing lines survive a parse/render
 * round trip (PR-3).
 * @param input - sender, type, sequence, fields, and optional body.
 * @returns the file name under `messages/` and its complete text.
 */
export function formatMessage(input: FormatInput): FormattedMessage {
  const yamlText = stringifyYaml(input.fields, { lineWidth: 0 }).trimEnd()
  return assemble(input, yamlText, input.body ?? '')
}

/**
 * Render a parsed message back to the bytes it was read from (PR-3).
 *
 * The field region is replayed as written, so hand-written YAML (flow lists,
 * quoting, comments) survives; {@link formatMessage} would normalise it. Holds
 * for any message that follows the file contract (LF, `---` terminator, final
 * newline).
 * @param message - a message returned by `parseMessage`.
 * @returns the file name and the original text.
 */
export function formatParsed(message: ParsedMessage): FormattedMessage {
  if (message.yamlText === undefined) {
    return formatMessage({ seq: message.seq, sender: message.sender, type: message.type, fields: message.fields, body: message.body })
  }
  return assemble(message, message.yamlText, message.body)
}
