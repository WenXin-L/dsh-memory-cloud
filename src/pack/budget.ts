import type { BudgetInput, BudgetResolver, LevelOverrides, LevelPreset, ResolvedBudget, TierQuotas } from '../contracts.ts'
import { COMPRESSION_LEVELS, LEVEL_PRESETS } from '../contracts.ts'

const K = 1024

/** Floors (and the one ceiling) applied to presets and user overrides. */
export const BUDGET_LIMITS = {
  minWorkingMemoryTokens: 4 * K,
  minRetainTokens: 0,
  minMemoryBudgetTokens: 2 * K,
  maxRecentSummaryCount: 64,
  minRecentSummaryTokens: 64,
  minGistTokens: 8,
  minRecallLimitTokens: 512,
} as const

/** Share of M per tier after the ongoing reserve; unused shares roll forward at packing time. */
export const TIER_SHARES = { profile: 0.1, recent: 0.55, distant: 0.35 } as const

/** Checkpoint-only reserve for in-progress items: 5% of M, at most 1.5K. */
export const ONGOING_SHARE = 0.05
export const ONGOING_MAX_TOKENS = 1536

/** M + retain must stay strictly below 3/5 (60%) of the threshold; kept as a fraction for exact integer math. */
export const POST_COMPACTION_SHARE = { numerator: 3, denominator: 5 } as const

/** A single `memory_read` may take at most this share of the threshold. */
export const RECALL_SHARE = 0.25

export function createBudgetResolver(): BudgetResolver {
  return { resolve: resolveBudget }
}

/**
 * Design §3.7 with the api-notes §7.3 adjustments, resolved as a ladder from
 * level 1 up to the requested level so that threshold, retain, M and recall
 * limit never increase from level 1 to level 5, whatever the window:
 * - threshold `T = min(level ceiling, W − O − H, T of the level below)`,
 *   `thresholdRatio = T / W` (level 1 keeps the host's 0.8 unless capped, and a
 *   level capped by the one below inherits its ratio);
 * - retain and `M = clamp(min(Mmax, r × (W − O − H)), 2K, Mmax)` are capped by
 *   the level below;
 * - `M + retain < 0.6 T`: both shrink in proportion, M not below 2K, and retain
 *   gets the rest. On windows too small for that, M drops below 2K and retain to 0.
 * Overridden fields skip the ladder cap but keep the window clamps and the 60% rule.
 */
export function resolveBudget(input: BudgetInput): ResolvedBudget {
  const preset: LevelPreset = LEVEL_PRESETS[input.level] ?? LEVEL_PRESETS[3]
  const overrides = input.overrides ?? {}
  const space = spaceOf(input)
  let below: Rung | undefined
  for (const level of COMPRESSION_LEVELS) {
    if (level >= preset.level) break
    below = climb(space, LEVEL_PRESETS[level], {}, below)
  }
  const { thresholdTokens, thresholdRatio, retainTokens, memoryBudgetTokens, recallLimitTokens } = climb(space, preset, overrides, below)

  const quotas = splitQuotas(memoryBudgetTokens)
  const recentSummaryTokens = clamp(
    given(overrides.recentSummaryTokens) ?? preset.recentSummaryTokens,
    BUDGET_LIMITS.minRecentSummaryTokens,
    Math.max(BUDGET_LIMITS.minRecentSummaryTokens, quotas.recent),
  )

  return {
    level: preset.level,
    thresholdTokens,
    thresholdRatio,
    retainTokens,
    memoryBudgetTokens,
    quotas,
    recentSummaryCount: clamp(given(overrides.recentSummaryCount) ?? preset.recentSummaryCount, 0, BUDGET_LIMITS.maxRecentSummaryCount),
    recentSummaryTokens,
    gistTokens: clamp(given(overrides.gistTokens) ?? preset.gistTokens, BUDGET_LIMITS.minGistTokens, Math.max(BUDGET_LIMITS.minGistTokens, recentSummaryTokens)),
    recallLimitTokens,
  }
}

interface Space {
  readonly window: number
  readonly output: number
  /** `W − O − H`, at least 1. */
  readonly available: number
  /** `r × (W − O − H)`. */
  readonly shareTokens: number
}

/** One level resolved on top of the level below it. */
interface Rung {
  readonly thresholdTokens: number
  readonly thresholdRatio: number
  /** Retain and M before the 60% fit; the next level's presets are capped by these. */
  readonly retainCeiling: number
  readonly memoryCeiling: number
  readonly retainTokens: number
  readonly memoryBudgetTokens: number
  readonly recallLimitTokens: number
}

function spaceOf(input: BudgetInput): Space {
  const window = Math.max(1, whole(input.capacity.contextWindow))
  const output = whole(input.capacity.reservedOutputTokens)
  const available = Math.max(1, window - output - whole(input.headroomTokens))
  const share = Number.isFinite(input.memoryShare) ? Math.min(1, Math.max(0, input.memoryShare)) : 0
  return { window, output, available, shareTokens: Math.floor(share * available) }
}

function climb(space: Space, preset: LevelPreset, overrides: LevelOverrides, below: Rung | undefined): Rung {
  const threshold = thresholdOf(space, preset, given(overrides.workingMemoryTokens), below)

  const retainOverride = given(overrides.retainTokens)
  const retainCeiling = retainOverride !== undefined
    ? Math.max(BUDGET_LIMITS.minRetainTokens, retainOverride)
    : capped(below?.retainCeiling, preset.retain.kind === 'ratio' ? Math.floor(Math.max(0, space.window - space.output) * preset.retain.ratio) : preset.retain.tokens)

  const memoryOverride = given(overrides.memoryBudgetTokens)
  const memoryCeiling = memoryOverride !== undefined
    ? memoryFor(space, memoryOverride)
    : capped(below?.memoryCeiling, memoryFor(space, preset.memoryBudgetTokens))

  const fitted = fitUnderThreshold(memoryCeiling, retainCeiling, threshold.tokens)

  const recallOverride = given(overrides.recallLimitTokens)
  const recall = clamp(
    recallOverride ?? preset.recallLimitTokens,
    BUDGET_LIMITS.minRecallLimitTokens,
    Math.max(BUDGET_LIMITS.minRecallLimitTokens, Math.floor(threshold.tokens * RECALL_SHARE)),
  )

  return {
    thresholdTokens: threshold.tokens,
    thresholdRatio: threshold.ratio,
    retainCeiling,
    memoryCeiling,
    retainTokens: retainOverride !== undefined ? fitted.retain : capped(below?.retainTokens, fitted.retain),
    memoryBudgetTokens: memoryOverride !== undefined ? fitted.memory : capped(below?.memoryBudgetTokens, fitted.memory),
    recallLimitTokens: recallOverride !== undefined ? recall : capped(below?.recallLimitTokens, recall),
  }
}

function thresholdOf(space: Space, preset: LevelPreset, override: number | undefined, below: Rung | undefined): { tokens: number; ratio: number } {
  if (override !== undefined) return absoluteThreshold(space, Math.max(BUDGET_LIMITS.minWorkingMemoryTokens, override))
  const own = preset.workingMemory.kind === 'ratio' ? relativeThreshold(space, preset.workingMemory.ratio) : absoluteThreshold(space, preset.workingMemory.tokens)
  return below !== undefined && below.thresholdTokens <= own.tokens ? { tokens: below.thresholdTokens, ratio: below.thresholdRatio } : own
}

function relativeThreshold(space: Space, ratio: number): { tokens: number; ratio: number } {
  const tokens = space.window * ratio
  return tokens <= space.available ? { tokens: Math.max(1, Math.floor(tokens)), ratio: Math.min(1, ratio) } : absoluteThreshold(space, tokens)
}

function absoluteThreshold(space: Space, ceiling: number): { tokens: number; ratio: number } {
  const tokens = Math.max(1, Math.floor(Math.min(ceiling, space.available)))
  return { tokens, ratio: tokens / space.window }
}

function memoryFor(space: Space, ceilingTokens: number): number {
  const ceiling = Math.max(BUDGET_LIMITS.minMemoryBudgetTokens, ceilingTokens)
  return clamp(Math.min(ceiling, space.shareTokens), BUDGET_LIMITS.minMemoryBudgetTokens, ceiling)
}

/** Shrink M and retain in proportion until `M + retain < 0.6 T`; M keeps 2K (or the whole allowance when smaller) and retain takes the rest. */
function fitUnderThreshold(memory: number, retain: number, thresholdTokens: number): { memory: number; retain: number } {
  const allowance = Math.max(0, Math.ceil((thresholdTokens * POST_COMPACTION_SHARE.numerator) / POST_COMPACTION_SHARE.denominator) - 1)
  if (memory + retain <= allowance) return { memory, retain }
  const scaled = Math.floor((memory * allowance) / (memory + retain))
  const fittedMemory = Math.min(allowance, Math.max(Math.min(BUDGET_LIMITS.minMemoryBudgetTokens, memory), scaled))
  return { memory: fittedMemory, retain: Math.min(retain, allowance - fittedMemory) }
}

function capped(limit: number | undefined, value: number): number {
  return limit === undefined ? value : Math.min(limit, value)
}

/** Split M into the ongoing reserve plus profile/recent/distant shares; the parts always sum to M. */
export function splitQuotas(memoryBudgetTokens: number): TierQuotas {
  const total = whole(memoryBudgetTokens)
  const ongoing = Math.min(ONGOING_MAX_TOKENS, Math.floor(total * ONGOING_SHARE))
  const rest = total - ongoing
  const profile = Math.floor(rest * TIER_SHARES.profile)
  const recent = Math.floor(rest * TIER_SHARES.recent)
  return { profile, recent, distant: rest - profile - recent, ongoing }
}

function given(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? Math.floor(value) : undefined
}

function whole(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)))
}
