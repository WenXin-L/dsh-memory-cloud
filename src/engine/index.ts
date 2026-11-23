/**
 * Engine mode (design §3.1 A, api-notes §1, §2.2, §7): the memory compaction
 * engine's host seam, threshold mapping, shrink guard, preset takeover, and the
 * headless row toggle. The engine class itself lives in `./entry.ts`
 * (`lib/engine.js`, row `dsh-memory-cloud-brain/engine`) so importing this
 * barrel does not load compaction-basic.
 */
export type {
  CheckpointComposer,
  CheckpointRequest,
  CompactionMode,
  EffectiveMode,
  ModelCapacity,
  ResolvedBudget,
  ScopeDecision,
} from '../contracts.ts'
export {
  DEFAULT_COMPOSE_TIMEOUT_MS,
  ENGINE_ROW,
  HOST_ENGINE_ROW,
  isEngineHost,
  isMemoryCompactionEngine,
  MEMORY_CLOUD_SERVICE,
  MEMORY_ENGINE_BRAND,
  type EngineBudgetHints,
  type EngineCheckpointRequest,
  type EngineFallback,
  type EngineFallbackKind,
  type EngineHost,
} from './host.ts'
export {
  DEFAULT_ENGINE_HEADROOM_TOKENS,
  meterRetainTokens,
  RETAIN_CEILING_SHARE,
  thresholdConfigFor,
  type MeterRetainInput,
  type SurfaceTokens,
  type ThresholdConfig,
  type ThresholdOptions,
} from './budget.ts'
export {
  DEFAULT_SHRINK_RATIO,
  estimateMessageTokens,
  fitsShrinkGuard,
  framedCheckpointTokens,
  maxCheckpointChars,
  measureRegion,
  MIN_CHECKPOINT_CHARS,
  priceConversation,
  type MessageLike,
  type RegionMeasure,
} from './shrink.ts'
export {
  COMPACTION_BASIC_ROW,
  configHash,
  createTakeoverController,
  DEFAULT_PRESET_ID,
  hasCompactionGroup,
  isTakenOver,
  PRESET_MODULE,
  releasePreset,
  sameConfig,
  takeOverPreset,
  type ConfigEditorEntryLike,
  type ConfigEditorLike,
  type PresetTakeoverState,
  type PresetTakeoverStatus,
  type RefreshOutcome,
  type TakeoverController,
  type TakeoverControllerOptions,
  type TakeoverErrorCode,
  type TakeoverOutcome,
  type TakeoverRecord,
  type TakeoverRecords,
  type TakeoverStateStore,
  type TakeoverStatus,
} from './takeover.ts'
export {
  readHostEngineState,
  setHostEngineEnabled,
  type HostEngineApplication,
  type HostEngineOutcome,
  type HostEngineState,
  type HostEngineStep,
  type PluginChangeLike,
  type PluginManagerLike,
  type PluginRowLike,
} from './headless.ts'
