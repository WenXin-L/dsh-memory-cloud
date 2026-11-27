import { LEVEL_PRESETS } from '../contracts.ts'

/** Above this context pressure every output cap is halved. */
export const PRESSURE_HALVE = 0.6
/** Above this pressure raw reads are refused and the summary is returned instead. */
export const PRESSURE_NO_RAW = 0.75
/** Above this pressure recall is refused outright. */
export const PRESSURE_REFUSE = 0.9

export type RecallPolicy =
  | { readonly kind: 'refuse'; readonly pressure: number; readonly message: string }
  | { readonly kind: 'allow'; readonly pressure: number; readonly capTokens: number; readonly allowRaw: boolean }

export type RecallAllowance = Extract<RecallPolicy, { kind: 'allow' }>

export function percent(pressure: number): number {
  return Math.round(pressure * 100)
}

/** Output ceiling for one recall call given the agent's context pressure (0..1) and the level's recall limit. */
export function recallPolicy(pressure: number, recallLimitTokens: number): RecallPolicy {
  const clamped = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0
  if (clamped > PRESSURE_REFUSE) {
    return {
      kind: 'refuse',
      pressure: clamped,
      message: `上下文已用 ${percent(clamped)}%，回忆查询已暂停。先用现有信息继续，等上下文压缩后再查。`,
    }
  }
  const limit = Number.isFinite(recallLimitTokens) && recallLimitTokens > 0
    ? Math.floor(recallLimitTokens)
    : LEVEL_PRESETS[3].recallLimitTokens
  const capTokens = Math.max(1, clamped > PRESSURE_HALVE ? Math.floor(limit / 2) : limit)
  return { kind: 'allow', pressure: clamped, capTokens, allowRaw: clamped <= PRESSURE_NO_RAW }
}
