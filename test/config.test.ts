import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { COMPRESSION_LEVELS, LEVEL_PRESETS } from '../src/contracts.ts'

describe('Config', () => {
  it('applies design defaults to an empty row config', () => {
    const config = Config({})
    expect(config.level.get()).toBe(3)
    expect(config.compactionMode.get()).toBe('auto')
    expect(config.storageRoot).toBeUndefined()
    expect(config.idleMinutes.get()).toBe(30)
    expect(config.halfLifeDays.get()).toBe(14)
    expect(config.summarizer.provider.get()).toBe('')
    expect(config.summarizer.model.get()).toBe('deepseek-flash')
    expect(config.summarizer.reasoningEffort.get()).toBe('off')
    expect(config.overrides.get()).toEqual({})
    expect(config.scopeRules.get()).toEqual([])
  })

  it('rejects an out-of-range level', () => {
    expect(() => Config({ level: 6 as never })).toThrow()
  })
})

describe('LEVEL_PRESETS', () => {
  it('has one row per level with budgets shrinking as the level rises', () => {
    for (const level of COMPRESSION_LEVELS) expect(LEVEL_PRESETS[level].level).toBe(level)
    for (const level of [2, 3, 4] as const) {
      const current = LEVEL_PRESETS[level]
      const next = LEVEL_PRESETS[(level + 1) as 3 | 4 | 5]
      expect(next.memoryBudgetTokens).toBeLessThan(current.memoryBudgetTokens)
      expect(next.recallLimitTokens).toBeLessThan(current.recallLimitTokens)
    }
  })
})
