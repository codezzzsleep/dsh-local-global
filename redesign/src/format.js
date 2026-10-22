/** Plain-text rendering of messages for prompts and logs. */

function indent(text, prefix = '    ') {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

/**
 * What Local sees at a check-in. Framed as advice: Local is the one doing the
 * work and decides what to do with it.
 */
export function formatForLocal(items) {
  if (items.length === 0) return ''
  const lines = [
    'Messages from the reviewer or the human since your last check.',
    'They are advice. You decide what to do; if you disagree, say so in your next report and why.',
    '',
  ]
  for (const m of items) {
    const meta = [m.re && `re ${m.re}`, m.verdict && `verdict=${m.verdict}`].filter(Boolean)
    lines.push(
      `- [${m.id}] ${m.kind} from ${m.from}${meta.length ? ` (${meta.join(', ')})` : ''}: ${m.summary}`,
    )
    for (const a of m.acceptance ?? []) lines.push(`    acceptance: ${a}`)
    for (const f of m.findings ?? []) lines.push(`    finding: ${f}`)
    if (m.body) lines.push(indent(m.body))
  }
  return lines.join('\n')
}

/** One line per message, for `lg human log`. */
export function formatLine(m) {
  const verdict = m.verdict ? `=${m.verdict}` : ''
  const artifacts = m.artifacts?.length ? ` [${m.artifacts.length} artifact(s)]` : ''
  return `${m.created_at}  ${m.id}  ${m.from} -> ${m.to}  ${m.kind}${verdict}: ${m.summary}${artifacts}`
}
