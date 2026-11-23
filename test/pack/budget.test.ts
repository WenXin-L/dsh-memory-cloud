import { describe, expect, it } from 'vitest'
import type { BudgetInput, CompressionLevel, ResolvedBudget } from '../../src/pack/index.ts'
import { BUDGET_LIMITS, createBudgetResolver, LEVEL_PRESETS, splitQuotas } from '../../src/pack/index.ts'

const K = 1024
const resolver = createBudgetResolver()
const LEVELS: readonly CompressionLevel[] = [1, 2, 3, 4, 5]

function resolve(patch: Partial<BudgetInput> & { level: CompressionLevel }): ResolvedBudget {
  return resolver.resolve({
    capacity: { contextWindow: 128 * K, reservedOutputTokens: 8 * K },
    headroomTokens: 8 * K,
    memoryShare: 0.25,
    ...patch,
  })
}

/** How compaction-basic derives its threshold from our ratio (`config.ts` resolveTargetPolicy). */
function hostThreshold(budget: ResolvedBudget, input: BudgetInput): number {
  const { contextWindow: w, reservedOutputTokens: o } = input.capacity
  return Math.floor(Math.min(w * budget.thresholdRatio, w - o - input.headroomTokens))
}

function expectInvariants(budget: ResolvedBudget): void {
  expect(budget.thresholdRatio).toBeGreaterThan(0)
  expect(budget.thresholdRatio).toBeLessThanOrEqual(1)
  expect(budget.retainTokens).toBeLessThan(budget.thresholdTokens)
  expect(budget.memoryBudgetTokens + budget.retainTokens).toBeLessThan(0.6 * budget.thresholdTokens)
  const { profile, recent, distant, ongoing } = budget.quotas
  expect(profile + recent + distant + ongoing).toBe(budget.memoryBudgetTokens)
  for (const quota of [profile, recent, distant, ongoing]) expect(quota).toBeGreaterThanOrEqual(0)
}

describe('resolveBudget on a 128K window (O = 8K, H = 8K, r = 0.25)', () => {
  it('level 1 keeps the host default ratio 0.8 and 0.16 (W − O) retain', () => {
    const budget = resolve({ level: 1 })
    expect(budget.thresholdRatio).toBe(0.8)
    expect(budget.thresholdTokens).toBe(Math.floor(128 * K * 0.8))
    expect(budget.retainTokens).toBe(Math.floor(120 * K * 0.16))
    expect(budget.memoryBudgetTokens).toBe(28 * K)
    expectInvariants(budget)
  })

  it('level 2 never keeps more than level 1: threshold and retain fall back to the host defaults', () => {
    const budget = resolve({ level: 2 })
    expect(budget.thresholdTokens).toBe(Math.floor(128 * K * 0.8))
    expect(budget.thresholdRatio).toBe(0.8)
    expect(budget.retainTokens).toBe(Math.floor(120 * K * 0.16))
    expect(budget.memoryBudgetTokens).toBe(28 * K)
    expectInvariants(budget)
  })

  it('level 3 keeps its own M and the level-1 threshold and retain', () => {
    const budget = resolve({ level: 3 })
    expect(budget.thresholdTokens).toBe(Math.floor(128 * K * 0.8))
    expect(budget.thresholdRatio).toBe(0.8)
    expect(budget.retainTokens).toBe(Math.floor(120 * K * 0.16))
    expect(budget.memoryBudgetTokens).toBe(24 * K)
    expect(budget.quotas).toEqual({ ongoing: 1228, profile: 2334, recent: 12841, distant: 8173 })
    expect(budget).toMatchObject({ recentSummaryCount: 6, recentSummaryTokens: 800, gistTokens: 50, recallLimitTokens: 8 * K })
    expectInvariants(budget)
  })

  it('level 4 and 5 use their absolute ceilings', () => {
    const four = resolve({ level: 4 })
    expect(four).toMatchObject({ thresholdTokens: 64 * K, thresholdRatio: 0.5, retainTokens: 12 * K, memoryBudgetTokens: 12 * K })
    const five = resolve({ level: 5 })
    expect(five).toMatchObject({ thresholdTokens: 32 * K, thresholdRatio: 0.25, retainTokens: 6 * K, memoryBudgetTokens: 6 * K })
    expect(five).toMatchObject({ recentSummaryCount: 2, recentSummaryTokens: 300, gistTokens: 25, recallLimitTokens: 2 * K })
    expectInvariants(four)
    expectInvariants(five)
  })

  it('splits M into ongoing + 10/55/35', () => {
    const budget = resolve({ level: 3 })
    const rest = budget.memoryBudgetTokens - budget.quotas.ongoing
    expect(budget.quotas.profile).toBe(Math.floor(rest * 0.1))
    expect(budget.quotas.recent).toBe(Math.floor(rest * 0.55))
    expect(budget.quotas.ongoing).toBeLessThanOrEqual(1536)
  })
})

describe('resolveBudget across windows', () => {
  const windows = [8 * K, 16 * K, 32 * K, 64 * K, 100_000, 128 * K, 200_000, 256 * K, 1_000_000, 1024 * K]

  it('never violates the invariants or trips compaction-basic TargetPressureConfigError', () => {
    for (const level of LEVELS) {
      for (const contextWindow of windows) {
        for (const reservedOutputTokens of [0, 4 * K, 32 * K]) {
          const input: BudgetInput = { level, capacity: { contextWindow, reservedOutputTokens }, headroomTokens: 4 * K, memoryShare: 0.25 }
          if (contextWindow - reservedOutputTokens - 4 * K <= 0) continue
          const budget = resolver.resolve(input)
          expectInvariants(budget)
          const host = hostThreshold(budget, input)
          expect(host).toBeGreaterThanOrEqual(budget.thresholdTokens - 1)
          expect(budget.retainTokens).toBeLessThan(host)
          expect(budget.memoryBudgetTokens).toBeLessThanOrEqual(Math.max(BUDGET_LIMITS.minMemoryBudgetTokens, LEVEL_PRESETS[level].memoryBudgetTokens))
        }
      }
    }
  })

  it('keeps M at least 2K on ordinary windows, scaling with r × (W − O − H)', () => {
    const small = resolve({ level: 1, capacity: { contextWindow: 64 * K, reservedOutputTokens: 8 * K }, memoryShare: 0.02 })
    expect(small.memoryBudgetTokens).toBe(2 * K)
    const scaled = resolve({ level: 1, memoryShare: 0.1 })
    expect(scaled.memoryBudgetTokens).toBe(Math.floor(0.1 * 112 * K))
    const capped = resolve({ level: 1, capacity: { contextWindow: 1024 * K, reservedOutputTokens: 8 * K } })
    expect(capped.memoryBudgetTokens).toBe(48 * K)
  })

  it('reduces retain when even a 2K block cannot fit under 60% of the threshold', () => {
    const budget = resolve({ level: 5, capacity: { contextWindow: 8 * K, reservedOutputTokens: 2 * K }, headroomTokens: 2 * K })
    expect(budget.thresholdTokens).toBe(4 * K)
    expect(budget.memoryBudgetTokens).toBe(2 * K)
    expect(budget.retainTokens).toBe(Math.ceil((4 * K * 3) / 5) - 1 - 2 * K)
    expectInvariants(budget)
  })

  it('lets M fall below 2K only on degenerate windows', () => {
    const budget = resolve({ level: 3, capacity: { contextWindow: 2000, reservedOutputTokens: 1000 }, headroomTokens: 500 })
    expect(budget.thresholdTokens).toBe(500)
    expect(budget.memoryBudgetTokens).toBe(299)
    expect(budget.retainTokens).toBe(0)
    expectInvariants(budget)
  })

  it('survives zero and non-finite capacity', () => {
    for (const capacity of [{ contextWindow: 0, reservedOutputTokens: 0 }, { contextWindow: Number.NaN, reservedOutputTokens: Number.NaN }]) {
      const budget = resolve({ level: 3, capacity })
      expect(budget.thresholdTokens).toBeGreaterThanOrEqual(1)
      expect(budget.thresholdRatio).toBeGreaterThan(0)
      expect(budget.thresholdRatio).toBeLessThanOrEqual(1)
      expect(budget.retainTokens).toBe(0)
    }
  })
})

describe('resolveBudget overrides', () => {
  it('applies overrides over the level preset', () => {
    const budget = resolve({
      level: 3,
      overrides: { workingMemoryTokens: 96 * K, retainTokens: 16 * K, memoryBudgetTokens: 20 * K, recentSummaryCount: 3, recentSummaryTokens: 600, gistTokens: 40, recallLimitTokens: 6 * K },
    })
    expect(budget).toMatchObject({
      thresholdTokens: 96 * K,
      thresholdRatio: 0.75,
      retainTokens: 16 * K,
      memoryBudgetTokens: 20 * K,
      recentSummaryCount: 3,
      recentSummaryTokens: 600,
      gistTokens: 40,
      recallLimitTokens: 6 * K,
    })
    expectInvariants(budget)
  })

  it('a working-memory override replaces level 1 ratio mode', () => {
    const budget = resolve({ level: 1, overrides: { workingMemoryTokens: 64 * K } })
    expect(budget.thresholdTokens).toBe(64 * K)
    expect(budget.thresholdRatio).toBe(0.5)
  })

  it('clamps overrides to sane minimums and the window', () => {
    const budget = resolve({
      level: 3,
      overrides: { workingMemoryTokens: 10, memoryBudgetTokens: 100, recentSummaryCount: 10_000, recentSummaryTokens: 1, gistTokens: 1, recallLimitTokens: 1 },
    })
    expect(budget.thresholdTokens).toBe(BUDGET_LIMITS.minWorkingMemoryTokens)
    expect(budget.recentSummaryCount).toBe(BUDGET_LIMITS.maxRecentSummaryCount)
    expect(budget.recentSummaryTokens).toBe(BUDGET_LIMITS.minRecentSummaryTokens)
    expect(budget.gistTokens).toBe(BUDGET_LIMITS.minGistTokens)
    expect(budget.recallLimitTokens).toBe(BUDGET_LIMITS.minRecallLimitTokens)
    expectInvariants(budget)

    const huge = resolve({ level: 3, overrides: { workingMemoryTokens: 10_000_000, retainTokens: 10_000_000, recallLimitTokens: 10_000_000 } })
    expect(huge.thresholdTokens).toBe(112 * K)
    expect(huge.recallLimitTokens).toBe(Math.floor(112 * K * 0.25))
    expectInvariants(huge)
  })

  it('ignores non-finite overrides', () => {
    const budget = resolve({ level: 3, overrides: { memoryBudgetTokens: Number.NaN, retainTokens: Number.POSITIVE_INFINITY } })
    expect(budget.memoryBudgetTokens).toBe(24 * K)
    expect(budget.retainTokens).toBe(Math.floor(120 * K * 0.16))
  })

  it('shrinks M and an oversized retain override in proportion instead of squeezing M to 2K', () => {
    const input: BudgetInput = { level: 3, capacity: { contextWindow: 48 * K, reservedOutputTokens: 2000 }, headroomTokens: 8 * K, memoryShare: 0.25, overrides: { retainTokens: 30 * K } }
    const available = 48 * K - 2000 - 8 * K
    const allowance = Math.ceil((available * 3) / 5) - 1
    const memory = Math.floor(0.25 * available)
    const budget = resolver.resolve(input)
    expect(budget.thresholdTokens).toBe(available)
    expect(budget.memoryBudgetTokens).toBe(Math.floor((memory * allowance) / (memory + 30 * K)))
    expect(budget.memoryBudgetTokens).toBeGreaterThan(BUDGET_LIMITS.minMemoryBudgetTokens)
    expect(budget.retainTokens).toBe(allowance - budget.memoryBudgetTokens)
    expectInvariants(budget)
  })
})

describe('resolveBudget ordering across levels', () => {
  it('matches the design table once the window is large enough', () => {
    const at = (level: CompressionLevel) => resolve({ level, capacity: { contextWindow: 1024 * K, reservedOutputTokens: 8 * K } })
    expect(at(2)).toMatchObject({ thresholdTokens: 256 * K, retainTokens: 48 * K, memoryBudgetTokens: 32 * K, recallLimitTokens: 12 * K })
    expect(at(3)).toMatchObject({ thresholdTokens: 128 * K, retainTokens: 24 * K, memoryBudgetTokens: 24 * K, recallLimitTokens: 8 * K })
    expect(at(4)).toMatchObject({ thresholdTokens: 64 * K, retainTokens: 12 * K, memoryBudgetTokens: 12 * K, recallLimitTokens: 4 * K })
    expect(at(5)).toMatchObject({ thresholdTokens: 32 * K, retainTokens: 6 * K, memoryBudgetTokens: 6 * K, recallLimitTokens: 2 * K })
  })

  it('never gives level 5 a larger block than level 3 on windows where they share a threshold (E2E regression)', () => {
    for (const capacity of [{ contextWindow: 32 * K, reservedOutputTokens: 2000 }, { contextWindow: 48 * K, reservedOutputTokens: 2000 }]) {
      const three = resolve({ level: 3, capacity })
      const five = resolve({ level: 5, capacity })
      expect(three.memoryBudgetTokens).toBeGreaterThan(BUDGET_LIMITS.minMemoryBudgetTokens)
      expect(five.memoryBudgetTokens).toBeLessThanOrEqual(three.memoryBudgetTokens)
      expect(five.retainTokens).toBeLessThanOrEqual(three.retainTokens)
    }
  })

  it('is non-increasing from level 1 to 5 and keeps every invariant for any window, O, H and r', () => {
    for (const contextWindow of [16 * K, 32 * K, 48 * K, 64 * K, 128 * K, 256 * K, 1024 * K, 1_000_000]) {
      for (const reservedOutputTokens of [0, 2000, 4 * K, 8 * K, 32 * K]) {
        for (const headroomTokens of [0, 4 * K, 8 * K, 64 * K]) {
          if (contextWindow - reservedOutputTokens - headroomTokens <= 0) continue
          for (const memoryShare of [0.1, 0.25]) {
            const inputs = LEVELS.map((level): BudgetInput => ({ level, capacity: { contextWindow, reservedOutputTokens }, headroomTokens, memoryShare }))
            const budgets = inputs.map(input => resolver.resolve(input))
            const hosts = budgets.map((budget, index) => hostThreshold(budget, inputs[index]!))
            budgets.forEach((budget, index) => {
              const label = `W=${contextWindow} O=${reservedOutputTokens} H=${headroomTokens} r=${memoryShare} level ${LEVELS[index]}`
              expectInvariants(budget)
              expect(budget.retainTokens, label).toBeLessThan(hosts[index]!)
              expect(hosts[index]!, label).toBeGreaterThanOrEqual(budget.thresholdTokens - 1)
              expect(budget.thresholdTokens, label).toBeLessThanOrEqual(contextWindow - reservedOutputTokens - headroomTokens)
              for (const value of [budget.thresholdTokens, hosts[index]!, budget.retainTokens, budget.memoryBudgetTokens, budget.recallLimitTokens]) {
                expect(value, label).toBeLessThanOrEqual(contextWindow)
              }
              if (index === 0) return
              const lower = budgets[index - 1]!
              expect(budget.thresholdTokens, label).toBeLessThanOrEqual(lower.thresholdTokens)
              expect(budget.thresholdRatio, label).toBeLessThanOrEqual(lower.thresholdRatio)
              expect(hosts[index]!, label).toBeLessThanOrEqual(hosts[index - 1]!)
              expect(budget.retainTokens, label).toBeLessThanOrEqual(lower.retainTokens)
              expect(budget.memoryBudgetTokens, label).toBeLessThanOrEqual(lower.memoryBudgetTokens)
              expect(budget.recallLimitTokens, label).toBeLessThanOrEqual(lower.recallLimitTokens)
            })
          }
        }
      }
    }
  })
})

describe('splitQuotas', () => {
  it('always sums to M', () => {
    for (const total of [0, 1, 2048, 6144, 24 * K, 48 * K, 12_345]) {
      const quotas = splitQuotas(total)
      expect(quotas.profile + quotas.recent + quotas.distant + quotas.ongoing).toBe(total)
    }
  })
})
