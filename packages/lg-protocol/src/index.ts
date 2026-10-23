/**
 * `@local-global/lg-protocol` — message envelopes, patch envelopes, and
 * derived channel state for the Local–Global git channel.
 *
 * The wire contract is `docs/channel-git.md` in the plugin repository.
 * @module @local-global/lg-protocol
 */

export {
  ALLOWED_SENDERS,
  LEGACY_MAX_SEQ,
  MESSAGE_TYPES,
  OPTIONAL_FIELDS,
  REQUIRED_FIELDS,
  FINDING_SEVERITIES,
  REVIEW_VERDICTS,
  COMMON_OPTIONAL_FIELDS,
  ID_PREFIX,
  ID_RE,
  SENDERS,
  deliveryLabel,
  isLegacyMessage,
  isLegacySeq,
  type Finding,
  type FindingSeverity,
  type MessageError,
  type MessageType,
  type ParsedMessage,
  type ParseResult,
  type ReviewVerdict,
  type Sender,
} from './types.js'

export { parseFilename, parseMessage, type FilenameParts } from './parse.js'
export { checkIdentities, validateMessage } from './validate.js'
export { formatMessage, formatParsed } from './format.js'
export { FILENAME_RE, type FormattedMessage, type FormatInput } from './format-types.js'
export { findSeqAnomalies, nextSeq } from './seq.js'
export { foldState, type Approval, type ChannelState, type OpenFinding } from './fold.js'
export { actionFingerprint } from './fingerprint.js'
