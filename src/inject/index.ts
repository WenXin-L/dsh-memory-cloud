/** Static usage section, session-start memory block, and assist-mode refill after compaction (design §3.1 B, §3.4). */
export type { MemoryPacker, PackResult, ResolvedBudget, ScopeDecision } from '../contracts.ts'
export { MEMORY_SOURCE_KIND } from '../contracts.ts'
export { attachInjector } from './attach.ts'
export type { AttachInjectorOptions } from './attach.ts'
export {
  createInjector,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_PACK_TIMEOUT_MS,
  describeSession,
  isMemoryMessage,
  scanSurface,
  STALE_PACK_MS,
} from './injector.ts'
export type {
  InjectAgent,
  InjectLogger,
  Injector,
  InjectorDeps,
  InjectReason,
  InjectSession,
  InjectSessionHeader,
  InjectSurfaceEvent,
  PackedMemory,
  PackRequest,
  PreStepPayload,
  SurfaceMemoryState,
} from './injector.ts'
export { buildUsageSection, USAGE_SECTION_NAME } from './usage.ts'
export type { UsageLanguage } from './usage.ts'
