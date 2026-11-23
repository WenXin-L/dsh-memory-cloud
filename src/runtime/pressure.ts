import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenEstimator } from '../contracts.ts'
import { measureRegion } from '../engine/index.ts'

/** The `ctx.tokenMeter` methods used here. */
export interface PressureMeter {
  contextPressure(session: Session): { readonly pressureTokens?: number; readonly contextWindow?: number }
  measure(session: Session): { readonly totalTokens: number }
}

export interface PressureDeps {
  readonly meter: () => PressureMeter | undefined
  readonly estimator: TokenEstimator
  /** Context window of the session's route when the meter has not seen a request yet. */
  readonly knownWindow: () => number | undefined
}

const ROLE_OVERHEAD = 4

/**
 * Context pressure 0..1: the provider-reported prompt size over the window
 * when usage is logged, else the larger of DSH's 4-chars/token estimate and
 * our CJK-aware estimate of the visible surface (the DSH heuristic undercounts
 * Chinese about 2.4×).
 */
export function contextPressure(session: Session, deps: PressureDeps): number {
  const meter = deps.meter()
  let window: number | undefined
  try {
    const reported = meter?.contextPressure(session)
    if (reported?.contextWindow !== undefined && reported.contextWindow > 0) {
      if (reported.pressureTokens !== undefined) return clamp(reported.pressureTokens / reported.contextWindow)
      window = reported.contextWindow
    }
  } catch {}
  window ??= deps.knownWindow()
  if (window === undefined || window <= 0) return 0
  let heuristic = 0
  try {
    heuristic = meter?.measure(session).totalTokens ?? 0
  } catch {}
  return clamp(Math.max(heuristic, surfaceTokens(session, deps.estimator)) / window)
}

/** CJK-aware estimate of the visible surface: every derived message's text, tool calls, and results. */
export function surfaceTokens(session: Session, estimator: TokenEstimator): number {
  let tokens = 0
  try {
    for (const message of session.deriveMessages()) {
      tokens += ROLE_OVERHEAD
      for (const block of message.content as readonly { readonly type: string }[]) {
        const text = blockText(block)
        if (text.length > 0) tokens += estimator.estimate(text)
      }
    }
  } catch {}
  return tokens
}

/** Heuristic size of what an idle `compactNow` would replace (everything after the system head). */
export function compactableTokens(session: Session): number {
  try {
    return measureRegion(session.deriveMessages()).tokens
  } catch {
    return 0
  }
}

function blockText(block: { readonly type: string }): string {
  const value = block as { readonly text?: unknown; readonly name?: unknown; readonly arguments?: unknown; readonly content?: unknown }
  if (typeof value.text === 'string') return value.text
  if (block.type === 'tool-call') return `${typeof value.name === 'string' ? value.name : ''} ${typeof value.arguments === 'string' ? value.arguments : ''}`
  return ''
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}
