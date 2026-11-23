/** Token estimation, level budgets, retention scoring, and memory-block rendering (design §3.4, §3.7). */
export type {
  BudgetInput,
  BudgetResolver,
  CompressionLevel,
  LevelOverrides,
  LevelPreset,
  MemoryPacker,
  ModelCapacity,
  PackCandidate,
  PackedTier,
  PackInput,
  PackResult,
  PackStats,
  ResolvedBudget,
  RetentionScore,
  TierQuotas,
  TokenBudget,
  TokenEstimator,
  TokenEstimatorOptions,
} from '../contracts.ts'
export { DEFAULT_TOKEN_ESTIMATOR_OPTIONS, LEVEL_PRESETS } from '../contracts.ts'
export type { CalibratingTokenEstimator, TextCharCounts, TokenEstimatorConfig } from './estimator.ts'
export { CALIBRATION_BOUNDS, countTextChars, createTokenEstimator } from './estimator.ts'
export { retentionScore } from './retention.ts'
export {
  BUDGET_LIMITS,
  createBudgetResolver,
  ONGOING_MAX_TOKENS,
  ONGOING_SHARE,
  POST_COMPACTION_SHARE,
  RECALL_SHARE,
  resolveBudget,
  splitQuotas,
  TIER_SHARES,
} from './budget.ts'
export type { MemoryPackerOptions } from './packer.ts'
export {
  createMemoryPacker,
  MEMORY_BLOCK_CLOSE,
  MEMORY_BLOCK_HEADER,
  MEMORY_BLOCK_HEADINGS,
  MEMORY_BLOCK_OPEN,
  omittedNotice,
} from './packer.ts'
