import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { createTokenEstimator } from '../../src/pack/index.ts'
import { contextPressure } from '../../src/runtime/pressure.ts'
import type { PressureMeter } from '../../src/runtime/pressure.ts'

const K = 1024
const estimator = createTokenEstimator()
const session = { deriveMessages: () => [] } as unknown as Session

function pressureWith(meter: PressureMeter): number {
  return contextPressure(session, { meter: () => meter, estimator, knownWindow: () => undefined })
}

describe('contextPressure', () => {
  it('follows a compaction through the measured total instead of the last logged prompt size', () => {
    const afterCompaction: PressureMeter = {
      contextPressure: () => ({ pressureTokens: 100 * K, contextWindow: 128 * K }),
      measure: () => ({ totalTokens: 20 * K, baseline: { kind: 'usage' } }),
    }
    expect(pressureWith(afterCompaction)).toBeCloseTo(20 / 128)
  })

  it('uses the logged prompt size only when the meter cannot measure', () => {
    expect(pressureWith({
      contextPressure: () => ({ pressureTokens: 64 * K, contextWindow: 128 * K }),
      measure: () => { throw new Error('no state') },
    })).toBeCloseTo(0.5)
  })

  it('takes the heuristic total without a usage baseline', () => {
    expect(pressureWith({
      contextPressure: () => ({ contextWindow: 128 * K }),
      measure: () => ({ totalTokens: 32 * K, baseline: { kind: 'estimated' } }),
    })).toBeCloseTo(0.25)
  })
})
