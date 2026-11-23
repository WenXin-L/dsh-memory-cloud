import { describe, expect, it } from 'vitest'
import { CALIBRATION_BOUNDS, countTextChars, createTokenEstimator } from '../../src/pack/index.ts'

describe('countTextChars', () => {
  it('classifies Han, kana, hangul and full-width punctuation as CJK', () => {
    expect(countTextChars('你好')).toEqual({ cjk: 2, other: 0 })
    expect(countTextChars('ひらがなカタカナー')).toEqual({ cjk: 9, other: 0 })
    expect(countTextChars('안녕하세요')).toEqual({ cjk: 5, other: 0 })
    expect(countTextChars('，。！？「」（）：；　')).toEqual({ cjk: 11, other: 0 })
    expect(countTextChars('hi, 世界!')).toEqual({ cjk: 2, other: 5 })
  })

  it('counts astral code points once', () => {
    expect(countTextChars('𠀀')).toEqual({ cjk: 1, other: 0 })
    expect(countTextChars('😀')).toEqual({ cjk: 0, other: 1 })
  })
})

describe('createTokenEstimator', () => {
  const estimator = createTokenEstimator()

  it('prices text as ceil((0.6 CJK + 0.3 other) × 1.15)', () => {
    expect(estimator.estimate('')).toBe(0)
    expect(estimator.estimate('a')).toBe(1)
    expect(estimator.estimate('abcd')).toBe(2)
    expect(estimator.estimate('x'.repeat(200))).toBe(69)
    expect(estimator.estimate('你好')).toBe(2)
    expect(estimator.estimate('字'.repeat(100))).toBe(69)
    expect(estimator.estimate('今天天气很好，we went out.')).toBe(Math.ceil((0.6 * 7 + 0.3 * 12) * 1.15))
  })

  it('is subadditive, so per-line sums bound the whole', () => {
    const parts = ['第一行：去海边。', 'second line with ascii', '混合 mixed 内容 123']
    const whole = estimator.estimate(parts.join('\n'))
    const sum = parts.reduce((total, part) => total + estimator.estimate(`${part}\n`), 0)
    expect(whole).toBeLessThanOrEqual(sum)
  })

  it('accepts custom weights', () => {
    const custom = createTokenEstimator({ cjkWeight: 1, otherWeight: 0.25, safetyMargin: 1 })
    expect(custom.estimate('字字')).toBe(2)
    expect(custom.estimate('abcd')).toBe(1)
  })

  it('calibrates towards provider usage within [0.5, 2]', () => {
    const calibrated = createTokenEstimator({ smoothing: 1 })
    expect(calibrated.calibration).toBe(1)
    const before = calibrated.estimate('x'.repeat(200))
    calibrated.calibrate(before, before * 1.5)
    expect(calibrated.calibration).toBeCloseTo(1.5)
    expect(calibrated.estimate('x'.repeat(200))).toBe(Math.ceil(69 * 1.5))

    calibrated.calibrate(10, 1000)
    expect(calibrated.calibration).toBe(CALIBRATION_BOUNDS.max)
    calibrated.calibrate(1000, 1)
    expect(calibrated.calibration).toBe(CALIBRATION_BOUNDS.min)
  })

  it('smooths calibration samples and ignores invalid ones', () => {
    const calibrated = createTokenEstimator({ smoothing: 0.5 })
    calibrated.calibrate(100, 200)
    expect(calibrated.calibration).toBeCloseTo(1.5)
    for (const [estimated, actual] of [[0, 10], [10, 0], [Number.NaN, 5], [5, Number.POSITIVE_INFINITY], [-1, 3]] as const) {
      calibrated.calibrate(estimated, actual)
    }
    expect(calibrated.calibration).toBeCloseTo(1.5)
  })

  it('clamps an initial calibration factor', () => {
    expect(createTokenEstimator({ calibration: 9 }).calibration).toBe(2)
    expect(createTokenEstimator({ calibration: 0.1 }).calibration).toBe(0.5)
    expect(createTokenEstimator({ calibration: Number.NaN }).calibration).toBe(1)
  })
})
