import type { TokenEstimator, TokenEstimatorOptions } from '../contracts.ts'
import { DEFAULT_TOKEN_ESTIMATOR_OPTIONS } from '../contracts.ts'

/** Han, kana, hangul, CJK symbols/punctuation, and full-width forms. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\u30fc\ufe10-\ufe1f\ufe30-\ufe4f\uff00-\uffef]/u

/** Absorbs float noise so that exact products such as `200 × 0.3 × 1.15` do not round up an extra token. */
const EPSILON = 1e-9

export const CALIBRATION_BOUNDS = { min: 0.5, max: 2 } as const

const DEFAULT_SMOOTHING = 0.25

export interface TextCharCounts {
  readonly cjk: number
  readonly other: number
}

/** Count code points as CJK or other, the two classes the estimator prices. */
export function countTextChars(text: string): TextCharCounts {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK.test(char)) cjk++
    else other++
  }
  return { cjk, other }
}

export interface TokenEstimatorConfig extends Partial<TokenEstimatorOptions> {
  /** Initial multiplicative correction, clamped to {@link CALIBRATION_BOUNDS}. */
  readonly calibration?: number
  /** Weight (0, 1] of each `calibrate()` sample in the moving correction. */
  readonly smoothing?: number
}

export interface CalibratingTokenEstimator extends TokenEstimator {
  /** Current correction factor applied to every estimate. */
  readonly calibration: number
  calibrate(estimated: number, actual: number): void
}

/**
 * `ceil((cjkWeight × CJK + otherWeight × other) × safetyMargin × calibration)`.
 * `calibrate(estimated, actual)` moves the correction towards `actual / estimated`
 * for text this estimator priced; it never leaves [0.5, 2].
 */
export function createTokenEstimator(config: TokenEstimatorConfig = {}): CalibratingTokenEstimator {
  const cjkWeight = positive(config.cjkWeight, DEFAULT_TOKEN_ESTIMATOR_OPTIONS.cjkWeight)
  const otherWeight = positive(config.otherWeight, DEFAULT_TOKEN_ESTIMATOR_OPTIONS.otherWeight)
  const safetyMargin = positive(config.safetyMargin, DEFAULT_TOKEN_ESTIMATOR_OPTIONS.safetyMargin)
  const smoothing = config.smoothing !== undefined && config.smoothing > 0 && config.smoothing <= 1 ? config.smoothing : DEFAULT_SMOOTHING
  let calibration = clampCalibration(config.calibration ?? 1)

  return {
    get calibration() {
      return calibration
    },
    estimate(text: string): number {
      if (text.length === 0) return 0
      const { cjk, other } = countTextChars(text)
      const raw = (cjkWeight * cjk + otherWeight * other) * safetyMargin * calibration
      return Math.max(0, Math.ceil(raw - EPSILON))
    },
    calibrate(estimated: number, actual: number): void {
      if (!Number.isFinite(estimated) || !Number.isFinite(actual) || estimated <= 0 || actual <= 0) return
      const target = calibration * (actual / estimated)
      calibration = clampCalibration(calibration + smoothing * (target - calibration))
    },
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function clampCalibration(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(CALIBRATION_BOUNDS.max, Math.max(CALIBRATION_BOUNDS.min, value))
}
