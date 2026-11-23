/** `session/event` capture into open episodes and episode sealing (design §3.5). */
export type {
  Clock,
  EpisodeMeta,
  MemoryStore,
  RawEventRecord,
  ScopeResolver,
  SealReason,
  SessionDescriptor,
  TokenEstimator,
} from '../contracts.ts'
export { MEMORY_SOURCE_KIND, SUMMARIZE_PURPOSE } from '../contracts.ts'
export type { Capture, CaptureDeps, CaptureLogger, CaptureOptions, CaptureStore } from './capture.ts'
export { createCapture } from './capture.ts'
export { EpisodeNotOpenError, isEpisodeNotOpenError, isOwnedByLiveForeignProcess } from '../store/owner.ts'
export type { AttachCaptureOptions } from './dsh.ts'
export { attachCaptureToDsh, describeSessionHeader, toRawEventRecord } from './dsh.ts'
export {
  EXCLUDED_SOURCE_KINDS,
  SYNTHETIC_SOURCE_KINDS,
  isExcludedRecord,
  isMessageRecord,
  isSyntheticRecord,
  readShadowedSeqs,
  recordText,
  stripReasoning,
  userSourceKind,
} from './records.ts'
