import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenEstimator } from '../contracts.ts'
import { measureRegion } from '../engine/index.ts'

/** The `ctx.tokenMeter` methods used here. */
export interface PressureMeter {
  contextPressure(session: Session): { readonly pressureTokens?: number; readonly contextWindow?: number }
  measure(session: Session): { readonly totalTokens: number; readonly baseline?: { readonly kind: string } }
}

export interface PressureDeps {
  readonly meter: () => PressureMeter | undefined
  readonly estimator: TokenEstimator
  /** Context window of the session's route when the meter has not seen a request yet. */
  readonly knownWindow: () => number | undefined
}

const ROLE_OVERHEAD = 4

/**
 * Context pressure 0..1 over the reported (else known) window. With a usage
 * baseline, the meter's `measure()` total: the last provider-reported prompt
 * plus the heuristic change of the surface since, so it follows a compaction,
 * which the logged `pressureTokens` does not see until the next request.
 * Without one, the larger of that heuristic total and our CJK-aware estimate
 * of the visible surface (the DSH heuristic undercounts Chinese about 2.4×).
 * `pressureTokens` is only used when the meter cannot measure.
 */
export function contextPressure(session: Session, deps: PressureDeps): number {
  const meter = deps.meter()
  let window: number | undefined
  let reported: number | undefined
  try {
    const pressure = meter?.contextPressure(session)
    if (pressure?.contextWindow !== undefined && pressure.contextWindow > 0) {
      window = pressure.contextWindow
      reported = pressure.pressureTokens
    }
  } catch {}
  window ??= deps.knownWindow()
  if (window === undefined || window <= 0) return 0
  let measured: { readonly totalTokens: number; readonly baseline?: { readonly kind: string } } | undefined
  try {
    measured = meter?.measure(session)
  } catch {}
  if (measured?.baseline?.kind === 'usage') return clamp(measured.totalTokens / window)
  if (measured === undefined && reported !== undefined) return clamp(reported / window)
  return clamp(Math.max(measured?.totalTokens ?? 0, surfaceTokens(session, deps.estimator)) / window)
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
