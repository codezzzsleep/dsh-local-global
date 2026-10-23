/**
 * Keep credentials out of everything a user can read: status text, errors, logs.
 */

/** `scheme://user:secret@host` → `scheme://***@host`; the userinfo is the secret. */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/giu
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgh[opsur]_[A-Za-z0-9]{16,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/gu,
  /\bsk-[A-Za-z0-9_-]{16,}/gu,
  /\bglpat-[A-Za-z0-9_-]{16,}/gu,
]
const KEY_VALUE_RE = /\b((?:access_|auth_|api_)?(?:token|password|passwd|secret|key)=)[^\s&'"]+/giu
const AUTH_HEADER_RE = /\b(Authorization:\s*)(?:Bearer\s+|Basic\s+|token\s+)?[^\s'"]+/giu

/**
 * Mask credentials in free text.
 * @param text - any user-visible string (URL, git stderr, a log line).
 * @returns the text with URL userinfo, known token shapes and `token=` style values masked.
 */
export function redactSecrets(text: string): string {
  let out = text.replace(URL_USERINFO_RE, '$1***@')
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '***')
  out = out.replace(KEY_VALUE_RE, '$1***')
  return out.replace(AUTH_HEADER_RE, '$1***')
}
