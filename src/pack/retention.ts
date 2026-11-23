import type { RetentionScore } from '../contracts.ts'

const DAY_MS = 86_400_000
const DEFAULT_HALF_LIFE_DAYS = 14
const MIN_HALF_LIFE_DAYS = 0.001
const DEFAULT_IMPORTANCE = 5

/**
 * `T = 0.5^(Δt / (h·S)) × (0.5 + I/20)` with Δt in days since
 * `lastRecalledAt ?? endedAt ?? startedAt` (never negative), `S ≥ 1`, and `I`
 * clamped to 1–10. Ranges from ~0 (long forgotten) to 1 (fresh, importance 10).
 */
export const retentionScore: RetentionScore = (meta, now, halfLifeDays) => {
  const anchor = meta.lastRecalledAt ?? meta.endedAt ?? meta.startedAt
  const elapsedDays = Number.isFinite(anchor) && Number.isFinite(now) ? Math.max(0, now - anchor) / DAY_MS : 0
  const strength = Number.isFinite(meta.strength) ? Math.max(1, meta.strength) : 1
  const halfLife = Number.isFinite(halfLifeDays) ? Math.max(MIN_HALF_LIFE_DAYS, halfLifeDays) : DEFAULT_HALF_LIFE_DAYS
  const importance = Number.isFinite(meta.importance) ? Math.min(10, Math.max(1, meta.importance)) : DEFAULT_IMPORTANCE
  return 0.5 ** (elapsedDays / (halfLife * strength)) * (0.5 + importance / 20)
}
