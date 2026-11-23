import { describe, expect, it } from 'vitest'
import { DEFAULT_ENGINE_HEADROOM_TOKENS, meterRetainTokens, RETAIN_CEILING_SHARE, thresholdConfigFor } from '../../src/engine/index.ts'
import type { SurfaceTokens } from '../../src/engine/index.ts'
import type { CompressionLevel } from '../../src/pack/index.ts'
import { resolveBudget } from '../../src/pack/index.ts'

const K = 1024

/** compaction-basic `resolveCompactSpec` (config.ts:153-217), reduced to the checks the mapping must survive. */
function dshSpec(config: { thresholdRatio: number; headroomTokens: number; retainTokens: number }, window: number, reserved: number) {
  const messageBudget = window - reserved
  const pressureBudget = messageBudget - config.headroomTokens
  if (messageBudget <= 0 || pressureBudget <= 0) throw new Error('no pressure budget')
  if (!(config.thresholdRatio > 0 && config.thresholdRatio <= 1)) throw new Error('ratio out of range')
  const thresholdTokens = Math.floor(Math.min(window * config.thresholdRatio, pressureBudget))
  if (config.retainTokens >= thresholdTokens) throw new Error('retain >= threshold')
  return { thresholdTokens, retainTokens: config.retainTokens }
}

describe('thresholdConfigFor', () => {
  it('maps the level-3 budget on a 128K window to the same absolute threshold', () => {
    const capacity = { contextWindow: 128 * K, reservedOutputTokens: 8 * K }
    const mapped = thresholdConfigFor({ thresholdTokens: 112 * K, retainTokens: 24 * K }, capacity, { headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS })
    expect(mapped).toEqual({
      thresholdRatio: 0.875,
      headroomTokens: 8 * K,
      retainTokens: 24 * K,
      maxTokens: 8 * K,
      thresholdTokens: 112 * K,
    })
    expect(dshSpec(mapped!, capacity.contextWindow, capacity.reservedOutputTokens)).toEqual({ thresholdTokens: 112 * K, retainTokens: 24 * K })
  })

  it('caps the threshold at W − O − headroom like compaction-basic', () => {
    const mapped = thresholdConfigFor({ thresholdTokens: 128 * K, retainTokens: 24 * K }, { contextWindow: 64 * K, reservedOutputTokens: 8 * K }, { headroomTokens: 8 * K })
    expect(mapped?.thresholdRatio).toBe(1)
    expect(mapped?.thresholdTokens).toBe(48 * K)
    expect(mapped?.retainTokens).toBe(24 * K)
  })

  it('clamps an oversized retained tail below the effective threshold', () => {
    const mapped = thresholdConfigFor({ thresholdTokens: 100_000, retainTokens: 150_000 }, { contextWindow: 128 * K, reservedOutputTokens: 0 }, { headroomTokens: 8 * K })
    expect(mapped?.thresholdTokens).toBe(100_000)
    expect(mapped?.retainTokens).toBe(Math.ceil(100_000 * RETAIN_CEILING_SHARE) - 1)
  })

  it('shrinks headroom on small windows so a pressure budget remains', () => {
    const mapped = thresholdConfigFor({ thresholdTokens: 32 * K, retainTokens: 6 * K }, { contextWindow: 8 * K, reservedOutputTokens: 4 * K }, { headroomTokens: 8 * K })
    expect(mapped).toMatchObject({ headroomTokens: 2 * K, thresholdTokens: 2 * K, maxTokens: 2 * K })
    expect(mapped!.retainTokens).toBeLessThan(mapped!.thresholdTokens)
  })

  it('keeps an explicit summary cap', () => {
    const mapped = thresholdConfigFor({ thresholdTokens: 32 * K, retainTokens: 6 * K }, { contextWindow: 128 * K, reservedOutputTokens: 0 }, { headroomTokens: 4 * K, maxTokens: 12_000 })
    expect(mapped?.maxTokens).toBe(12_000)
    expect(mapped?.headroomTokens).toBe(4 * K)
  })

  it('returns undefined when the model leaves no usable budget', () => {
    const budget = { thresholdTokens: 32 * K, retainTokens: 6 * K }
    expect(thresholdConfigFor(budget, { contextWindow: 0, reservedOutputTokens: 0 }, { headroomTokens: 0 })).toBeUndefined()
    expect(thresholdConfigFor(budget, { contextWindow: 4096, reservedOutputTokens: 4096 }, { headroomTokens: 0 })).toBeUndefined()
    expect(thresholdConfigFor(budget, { contextWindow: 1.5, reservedOutputTokens: 0 }, { headroomTokens: 0 })).toBeUndefined()
    expect(thresholdConfigFor(budget, { contextWindow: 8192, reservedOutputTokens: -1 }, { headroomTokens: 0 })).toBeUndefined()
  })

  it('always yields a config compaction-basic accepts, reproducing its threshold', () => {
    const windows = [4096, 20_000, 64 * K, 128 * K, 1_000_000]
    const reserves = [0, 1000, 8 * K, 32 * K]
    const thresholds = [1, 4 * K, 32 * K, 128 * K, 2_000_000]
    const retains = [0, 6 * K, 48 * K, 10_000_000]
    for (const contextWindow of windows) {
      for (const reservedOutputTokens of reserves) {
        for (const thresholdTokens of thresholds) {
          for (const retainTokens of retains) {
            const mapped = thresholdConfigFor({ thresholdTokens, retainTokens }, { contextWindow, reservedOutputTokens }, { headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS })
            if (contextWindow - reservedOutputTokens < 4) {
              expect(mapped).toBeUndefined()
              continue
            }
            if (mapped === undefined) continue
            expect(Number.isInteger(mapped.headroomTokens) && mapped.headroomTokens >= 0).toBe(true)
            expect(Number.isInteger(mapped.maxTokens) && mapped.maxTokens > 0).toBe(true)
            expect(dshSpec(mapped, contextWindow, reservedOutputTokens).thresholdTokens).toBe(mapped.thresholdTokens)
            expect(mapped.thresholdTokens).toBeLessThanOrEqual(Math.max(1, Math.min(thresholdTokens, contextWindow)))
          }
        }
      }
    }
  })
})

describe('meterRetainTokens', () => {
  const base = { thresholdTokens: 22_576, memoryBudgetTokens: 2048 }

  it('rescales a real-token retain into the meter heuristic compaction-basic sums', () => {
    expect(meterRetainTokens(10_000, { ...base, surface: { meterTokens: 4000, realTokens: 10_000 } })).toBe(4000)
    expect(meterRetainTokens(10_000, { ...base, surface: { meterTokens: 9000, realTokens: 6000 } })).toBe(10_000)
  })

  it('caps retain so checkpoint, tail, and request overhead stay under the ceiling share of the threshold', () => {
    const ceiling = Math.ceil(base.thresholdTokens * RETAIN_CEILING_SHARE) - 1
    const surface = { meterTokens: 6500, realTokens: 16_000 }
    const capped = meterRetainTokens(11_497, { ...base, surface, measuredTokens: 26_000 })
    expect(capped).toBe(Math.floor((ceiling - 2048 - 10_000) * (6500 / 16_000)))
    expect(meterRetainTokens(11_497, { ...base, surface, measuredTokens: 60_000 })).toBe(0)
  })

  it('keeps the retain unchanged when the surface cannot be priced', () => {
    expect(meterRetainTokens(11_497, base)).toBe(11_497)
    expect(meterRetainTokens(11_497, { ...base, surface: { meterTokens: 0, realTokens: 0 } })).toBe(11_497)
  })
})

describe('level budgets through the engine mapping', () => {
  const LEVELS: readonly CompressionLevel[] = [1, 2, 3, 4, 5]
  const surfaces: readonly SurfaceTokens[] = [{ meterTokens: 4000, realTokens: 10_000 }, { meterTokens: 9000, realTokens: 6000 }, { meterTokens: 20_000, realTokens: 20_000 }]
  const overheads = [undefined, 0, 4 * K, 10 * K, 30 * K]

  it('keeps the level ordering, the pack budget, and a config compaction-basic accepts', () => {
    for (const contextWindow of [16 * K, 32 * K, 48 * K, 64 * K, 128 * K, 256 * K, 1024 * K, 1_000_000]) {
      for (const reservedOutputTokens of [0, 2000, 8 * K, 32 * K]) {
        for (const headroomTokens of [DEFAULT_ENGINE_HEADROOM_TOKENS, 4 * K]) {
          if (contextWindow - reservedOutputTokens - headroomTokens <= 0) continue
          const capacity = { contextWindow, reservedOutputTokens }
          const budgets = LEVELS.map(level => resolveBudget({ level, capacity, headroomTokens, memoryShare: 0.25 }))
          const mapped = budgets.map(budget => thresholdConfigFor(budget, capacity, { headroomTokens }))
          const headroomKept = headroomTokens <= Math.floor((contextWindow - reservedOutputTokens) / 2)
          mapped.forEach((config, index) => {
            const label = `W=${contextWindow} O=${reservedOutputTokens} H=${headroomTokens} level ${LEVELS[index]}`
            const budget = budgets[index]!
            expect(config, label).toBeDefined()
            expect(dshSpec(config!, contextWindow, reservedOutputTokens).thresholdTokens, label).toBe(config!.thresholdTokens)
            if (headroomKept) {
              expect(config!.thresholdTokens, label).toBeGreaterThanOrEqual(budget.thresholdTokens - 1)
              expect(config!.retainTokens, label).toBe(budget.retainTokens)
            }
            if (index === 0) return
            expect(config!.thresholdTokens, label).toBeLessThanOrEqual(mapped[index - 1]!.thresholdTokens)
            expect(config!.retainTokens, label).toBeLessThanOrEqual(mapped[index - 1]!.retainTokens)
          })

          for (const surface of surfaces) {
            for (const overhead of overheads) {
              const retains = mapped.map((config, index) => meterRetainTokens(config!.retainTokens, {
                thresholdTokens: config!.thresholdTokens,
                memoryBudgetTokens: budgets[index]!.memoryBudgetTokens,
                surface,
                ...overhead === undefined ? {} : { measuredTokens: surface.realTokens + overhead },
              }))
              retains.forEach((retain, index) => {
                const label = `W=${contextWindow} O=${reservedOutputTokens} H=${headroomTokens} surface=${surface.meterTokens}/${surface.realTokens} overhead=${overhead} level ${LEVELS[index]}`
                const config = mapped[index]!
                expect(retain, label).toBeLessThanOrEqual(config.retainTokens)
                expect(() => dshSpec({ ...config, retainTokens: retain }, contextWindow, reservedOutputTokens), label).not.toThrow()
                if (overhead !== undefined && retain > 0 && surface.meterTokens >= surface.realTokens) {
                  expect(budgets[index]!.memoryBudgetTokens + retain + overhead, label).toBeLessThan(RETAIN_CEILING_SHARE * config.thresholdTokens)
                }
                if (index === 0) return
                if (overhead === undefined) expect(retain, label).toBeLessThanOrEqual(retains[index - 1]!)
                if (surface.meterTokens >= surface.realTokens) {
                  expect(budgets[index]!.memoryBudgetTokens + retain, label).toBeLessThanOrEqual(budgets[index - 1]!.memoryBudgetTokens + retains[index - 1]!)
                }
              })
            }
          }
        }
      }
    }
  })
})
