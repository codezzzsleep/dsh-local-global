/**
 * `@local-global/dsh-lg-local` — Local-side plugins.
 * @module @local-global/dsh-lg-local
 */
export { apply as evidence, resolveEvidenceConfig, secretHits, staleOf, DEFAULT_SECRET_PATTERNS, type EvidenceConfig, type Manifest, type RawFile } from './evidence.js'
export { apply as patchApply, applyPatch, type ApplyResult, type ApplyVerdict } from './patch.js'
