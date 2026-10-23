/**
 * `@local-global/dsh-lg-local` — Local-side plugins.
 * @module @local-global/dsh-lg-local
 */
export {
  apply as evidence,
  resolveEvidenceConfig,
  secretHits,
  domainHits,
  staleOf,
  staleReasons,
  topicDir,
  versionState,
  DEFAULT_SECRET_PATTERNS,
  TREE_DIGEST,
  type EvidenceConfig,
  type Manifest,
  type ManifestStatus,
  type RawFile,
  type VersionState,
} from './evidence.js'
export { apply as patchApply, applyPatch, type ApplyResult, type ApplyVerdict } from './patch.js'
export { apply as protect, resolveProtectConfig, protectReason, protectedHit, commandHit, DEFAULT_PROTECTED_PATHS, type ProtectConfig, type ProtectService } from './protect.js'
export {
  apply as actionGate,
  resolveActionGateConfig,
  gateReason,
  matchRule,
  matchRules,
  DEFAULT_RULES,
  type ActionGateConfig,
  type ActionGateService,
  type GateRule,
} from './action-gate.js'
export { ApprovalLedger, LedgerError, LEDGER_FILE, type SpentApproval } from './ledger.js'
export { parseShell, type Invocation } from './shell.js'
export { apply as reportGate, gateReasons, gateMessage, collectFacts, claimsCompletion, type GateFacts } from './report-gate.js'
