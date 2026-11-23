import { describe, expect, it } from 'vitest'
import { retentionScore } from '../../src/pack/index.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 23, 12)

const meta = (patch: Partial<Parameters<typeof retentionScore>[0]> = {}) => ({
  startedAt: NOW - 10 * DAY,
  strength: 1,
  importance: 10,
  ...patch,
})

describe('retentionScore', () => {
  it('is 0.5 + I/20 for a fresh episode', () => {
    expect(retentionScore(meta({ startedAt: NOW }), NOW, 14)).toBeCloseTo(1)
    expect(retentionScore(meta({ startedAt: NOW, importance: 1 }), NOW, 14)).toBeCloseTo(0.55)
  })

  it('halves every h·S days', () => {
    expect(retentionScore(meta({ startedAt: NOW - 14 * DAY }), NOW, 14)).toBeCloseTo(0.5)
    expect(retentionScore(meta({ startedAt: NOW - 28 * DAY }), NOW, 14)).toBeCloseTo(0.25)
    expect(retentionScore(meta({ startedAt: NOW - 28 * DAY, strength: 2 }), NOW, 14)).toBeCloseTo(0.5)
  })

  it('measures Δt from lastRecalledAt, then endedAt, then startedAt', () => {
    const started = NOW - 28 * DAY
    expect(retentionScore(meta({ startedAt: started, endedAt: NOW - 14 * DAY }), NOW, 14)).toBeCloseTo(0.5)
    expect(retentionScore(meta({ startedAt: started, endedAt: NOW - 14 * DAY, lastRecalledAt: NOW }), NOW, 14)).toBeCloseTo(1)
  })

  it('ranks importance and recency', () => {
    const recentLow = retentionScore(meta({ startedAt: NOW - DAY, importance: 2 }), NOW, 14)
    const oldHigh = retentionScore(meta({ startedAt: NOW - 60 * DAY, importance: 10 }), NOW, 14)
    const recentHigh = retentionScore(meta({ startedAt: NOW - DAY, importance: 9 }), NOW, 14)
    expect(recentHigh).toBeGreaterThan(recentLow)
    expect(recentLow).toBeGreaterThan(oldHigh)
  })

  it('stays finite on degenerate input', () => {
    expect(retentionScore(meta({ startedAt: NOW + DAY }), NOW, 14)).toBeCloseTo(1)
    expect(Number.isFinite(retentionScore(meta({ strength: 0, importance: Number.NaN }), NOW, 0))).toBe(true)
    expect(retentionScore(meta({ importance: 99, startedAt: NOW }), NOW, 14)).toBeCloseTo(1)
  })
})
