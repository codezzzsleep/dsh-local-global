/**
 * Renderer for one channel message file (docs/channel-git.md §2–§3).
 */
import { stringify as stringifyYaml } from 'yaml'
import type { FormattedMessage, FormatInput } from './format-types.js'

/**
 * Render a message into the exact file name and file text the contract expects.
 *
 * The output always ends with a single newline and uses LF only.
 * @param input - sender, type, sequence, fields, and optional body.
 * @returns the file name under `messages/` and its complete text.
 */
export function formatMessage(input: FormatInput): FormattedMessage {
  const filename = `${input.seq}-${input.sender}-${input.type}.md`
  const header = `[LG ${input.type} from ${input.sender}]`
  const yamlText = stringifyYaml(input.fields, { lineWidth: 0 }).trimEnd()
  const body = input.body ?? ''
  const bodyText = body.length === 0 ? '' : `${body.replace(/\n+$/, '')}\n`
  return {
    filename,
    text: `${header}\n${yamlText}\n---\n${bodyText}`,
  }
}
