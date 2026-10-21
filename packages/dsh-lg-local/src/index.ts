/**
 * `@local-global/dsh-lg-local` — Local-side plugins.
 * @module @local-global/dsh-lg-local
 */
export { apply as evidence, resolveEvidenceConfig, secretHits, staleOf, DEFAULT_SECRET_PATTERNS, type EvidenceConfig, type Manifest, type RawFile } from './evidence.js'
export { apply as patchApply, applyPatch, type ApplyResult, type ApplyVerdict } from './patch.js'
export { apply as protect, resolveProtectConfig, protectReason, protectedHit, type ProtectConfig } from './protect.js'
export { apply as actionGate, resolveActionGateConfig, gateReason, matchRule, DEFAULT_RULES, type ActionGateConfig, type GateRule } from './action-gate.js'
export { apply as reportGate, gateReasons, gateMessage, collectFacts, type GateFacts } from './report-gate.js'
