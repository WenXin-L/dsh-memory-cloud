import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CheckpointComposer, CheckpointRequest, ModelCapacity, ResolvedBudget, ScopeDecision } from '../contracts.ts'

/** Host-level Cordis service the engine reads lazily with `ctx.get()`; never declared in `inject`. */
export const MEMORY_CLOUD_SERVICE = 'memoryCloud'

/**
 * Marks {@link MemoryCompactionEngine} instances. `lib/index.js` and
 * `lib/engine.js` are separate bundles, so the host recognizes the engine by
 * this registry symbol instead of `instanceof`.
 */
export const MEMORY_ENGINE_BRAND: unique symbol = Symbol.for('dsh-memory-cloud-brain.engine')

/** Whether a `compaction` service is this package's memory engine (from either bundle). */
export function isMemoryCompactionEngine(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { [MEMORY_ENGINE_BRAND]?: unknown })[MEMORY_ENGINE_BRAND] === true
}

/** Default engine-row `composeTimeoutMs`: how long `CheckpointComposer.compose()` may run before the fallback. */
export const DEFAULT_COMPOSE_TIMEOUT_MS = 120_000

/** Loader row and module the engine is mounted under inside preset compaction groups. */
export const ENGINE_ROW = {
  id: 'dsh-memory-cloud-brain:engine',
  name: 'dsh-memory-cloud-brain/engine',
} as const

/**
 * The shipped-disabled top-level row for headless/sdk profiles. Its id avoids
 * `:` because the Loader cannot resolve a top-level id containing its nested-id
 * separator (`cordis-plugin-loader/src/config/tree.ts` `resolve()`).
 */
export const HOST_ENGINE_ROW = {
  id: 'dsh-memory-cloud-brain-engine',
  name: ENGINE_ROW.name,
} as const

/** Why the engine handed a compaction back to compaction-basic. */
export type EngineFallbackKind =
  | 'subagent'
  | 'no-capture'
  | 'scope-error'
  | 'budget-error'
  | 'region-too-small'
  | 'compose-error'
  | 'compose-timeout'
  | 'empty'
  | 'shrink-guard'

export interface EngineFallback {
  readonly kind: EngineFallbackKind
  /** `threshold` = level mapping in `compactIfNeeded`; `summarize` = checkpoint composition. */
  readonly stage: 'threshold' | 'summarize'
  readonly sessionId: string
  readonly detail?: string
  readonly error?: unknown
}

/** Facts the engine already resolved for the routed model, so the host need not resolve them again. */
export interface EngineBudgetHints {
  /** H the engine hands to compaction-basic; pass it to the budget resolver so both sides agree on T. */
  readonly headroomTokens: number
  readonly capacity?: ModelCapacity
}

/**
 * What the memory side provides to the engine as the `memoryCloud` service.
 * Every method may throw; the engine treats a throw as a fallback.
 */
export interface EngineHost {
  budgetFor(agent: Agent, hints?: EngineBudgetHints): Promise<ResolvedBudget>
  readonly composer: CheckpointComposer
  scopeFor(agent: Agent): ScopeDecision
  /**
   * False hands the agent's compactions to compaction-basic with its configured
   * defaults (assist/off modes). Called with the agent being compacted.
   */
  isEnabled(agent?: Agent): boolean
  notifyFallback(reason: EngineFallback): void
}

/** The checkpoint request the engine sends; `maxChars` is the cap it enforces. */
export type EngineCheckpointRequest = CheckpointRequest

export function isEngineHost(value: unknown): value is EngineHost {
  if (typeof value !== 'object' || value === null) return false
  const host = value as Partial<Record<keyof EngineHost, unknown>>
  return typeof host.budgetFor === 'function'
    && typeof host.scopeFor === 'function'
    && typeof host.isEnabled === 'function'
    && typeof host.notifyFallback === 'function'
    && typeof host.composer === 'object' && host.composer !== null
    && typeof (host.composer as { compose?: unknown }).compose === 'function'
}
