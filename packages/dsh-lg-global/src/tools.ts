/**
 * The exact tool names a Global session may call.
 *
 * Shared by the call-time guard (lg-scope) and the visibility check
 * (lg-integrity) so the two cannot drift apart. There is no prefix rule: a
 * Local-only tool such as `lg_apply_patch` or `lg_evidence_add` must fail both.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  // dsh-tool-fs, dsh-tool-fs-search, dsh-tool-web, dsh-tool-working-directory
  'read',
  'read_image',
  'write',
  'edit',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'working_directory',
  // dsh-lg-global
  'lg_repo_sync',
  'lg_repo_log',
  'lg_repo_diff',
  'lg_repo_show',
  'lg_integrity_check',
  // dsh-lg-common: session evidence (in the preset) and the channel tools
  'lg_evidence_session',
  'lg_post',
  'lg_record_relayed',
  'lg_read',
  'lg_open_questions',
  // M4: Global's write exit
  'lg_directive',
  'lg_review',
  'lg_decision',
  'lg_draft_reset',
  'lg_patch_send',
  'lg_stop',
] as const

/** A name nothing registers: the self-test sends it through the real pipeline. */
export const CANARY_TOOL = 'lg_selftest_canary'

/** Read a cordis service by name without depending on the context's typing. */
export function serviceOf<T>(ctx: unknown, name: string): T | undefined {
  try {
    return (ctx as { get?: (name: string) => unknown }).get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

/** Replace every secret in `text`. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    out = out.split(secret).join('***')
  }
  return out
}
