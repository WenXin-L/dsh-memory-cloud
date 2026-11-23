import type { ModelCapacity, ResolvedBudget } from '../contracts.ts'

/** Pressure headroom the engine passes to compaction-basic instead of its 65 536 default (api-notes §1.2, §7.3). */
export const DEFAULT_ENGINE_HEADROOM_TOKENS = 8192

/**
 * Retained tail ceiling as a share of the effective threshold, matching the
 * pack module's `M + retain < 0.6 T` invariant so a matching budget is never
 * altered and DSH's `retainTokens < thresholdTokens` check always holds.
 */
export const RETAIN_CEILING_SHARE = 0.6

/** The compaction-basic fields the engine swaps per routed model. */
export interface ThresholdConfig {
  readonly thresholdRatio: number
  readonly headroomTokens: number
  readonly retainTokens: number
  /** Summary cap for the `super.summarize()` fallback; tracks headroom unless set explicitly. */
  readonly maxTokens: number
  /** The threshold compaction-basic will compute from these fields: `floor(min(W × ratio, W − O − headroom))`. */
  readonly thresholdTokens: number
}

export interface ThresholdOptions {
  readonly headroomTokens: number
  /** Explicit summary cap from the engine row; defaults to the effective headroom like compaction-basic. */
  readonly maxTokens?: number
}

/**
 * Map an absolute level budget onto compaction-basic's ratio-based policy for
 * one routed model, reproducing `resolveCompactSpec` so the result never
 * triggers `TargetPressureConfigError`. Returns `undefined` when the model
 * leaves no usable pressure budget; the caller then keeps the base config.
 */
export function thresholdConfigFor(
  budget: Pick<ResolvedBudget, 'thresholdTokens' | 'retainTokens'>,
  capacity: ModelCapacity,
  options: ThresholdOptions,
): ThresholdConfig | undefined {
  const window = capacity.contextWindow
  const reserved = capacity.reservedOutputTokens
  if (!Number.isInteger(window) || window <= 0 || !Number.isInteger(reserved) || reserved < 0) return undefined
  const messageBudget = window - reserved
  if (messageBudget < 4) return undefined

  const headroomTokens = Math.min(wholeOrZero(options.headroomTokens), Math.floor(messageBudget / 2))
  const target = Math.min(window, Math.max(1, wholeOrZero(budget.thresholdTokens)))
  const thresholdRatio = Math.min(1, target / window)
  const thresholdTokens = pressureThreshold(capacity, thresholdRatio, headroomTokens)
  if (thresholdTokens < 2) return undefined

  const retainTokens = Math.max(0, Math.min(wholeOrZero(budget.retainTokens), retainCeiling(thresholdTokens)))
  const explicitMax = options.maxTokens
  const maxTokens = explicitMax !== undefined && Number.isInteger(explicitMax) && explicitMax > 0
    ? explicitMax
    : Math.max(1, headroomTokens)
  return { thresholdRatio, headroomTokens, retainTokens, maxTokens, thresholdTokens }
}

/** compaction-basic's pressure threshold for one routed model: `floor(min(W × ratio, W − O − headroom))`. */
export function pressureThreshold(capacity: ModelCapacity, thresholdRatio: number, headroomTokens: number): number {
  const window = capacity.contextWindow
  return Math.floor(Math.min(window * thresholdRatio, window - capacity.reservedOutputTokens - headroomTokens))
}

/** The largest retained tail below both a threshold and {@link RETAIN_CEILING_SHARE} of it. */
export function retainCeiling(thresholdTokens: number): number {
  return Math.min(thresholdTokens - 1, Math.ceil(thresholdTokens * RETAIN_CEILING_SHARE) - 1)
}

/** Conversation size (everything after the system head) under both pricings. */
export interface SurfaceTokens {
  /** DSH token-meter pricing: the fixed 4-chars/token heuristic compaction-basic sums to pick the retained tail. */
  readonly meterTokens: number
  /** Our CJK-aware estimate, on the same scale as provider usage and the level budgets. */
  readonly realTokens: number
}

export interface MeterRetainInput {
  readonly thresholdTokens: number
  readonly memoryBudgetTokens: number
  readonly surface?: SurfaceTokens
  /** The meter's usage-anchored total for the routed request (conversation plus system prompt and tools). */
  readonly measuredTokens?: number
}

/**
 * compaction-basic keeps the newest surface nodes until their per-node meter
 * prices reach `retainTokens`, but those prices use DSH's 4-chars/token
 * heuristic while pressure is anchored on provider usage. Chinese text is
 * priced at roughly 0.4× its real size, so a level retain in real tokens could
 * exceed the whole priced surface: no range is ever selected and pressure
 * compaction silently never runs. Convert the real-token retain into meter
 * prices, after capping it so checkpoint (M) + retained tail + the fixed
 * request overhead (system prompt and tools) stays below
 * {@link RETAIN_CEILING_SHARE} of the threshold.
 */
export function meterRetainTokens(retainTokens: number, input: MeterRetainInput): number {
  let real = wholeOrZero(retainTokens)
  const surface = input.surface
  if (surface !== undefined && input.measuredTokens !== undefined && Number.isFinite(input.measuredTokens)) {
    const overhead = Math.max(0, input.measuredTokens - surface.realTokens)
    const ceiling = Math.ceil(wholeOrZero(input.thresholdTokens) * RETAIN_CEILING_SHARE) - 1 - wholeOrZero(input.memoryBudgetTokens) - overhead
    real = Math.min(real, Math.max(0, Math.floor(ceiling)))
  }
  if (surface === undefined || !(surface.realTokens > 0) || !(surface.meterTokens >= 0)) return real
  const scale = Math.min(1, surface.meterTokens / surface.realTokens)
  return Math.max(0, Math.floor(real * scale))
}

function wholeOrZero(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}
