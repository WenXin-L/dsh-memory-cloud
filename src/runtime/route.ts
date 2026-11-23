import type { SummaryRoute } from '../contracts.ts'
import type { ModelInfoLike } from './budget.ts'

const AVAILABILITY_TTL_MS = 10 * 60_000

export interface BackgroundRouteDeps {
  /** The volatile `summarizer.*` config. */
  readonly configured: () => { readonly provider: string; readonly model: string; readonly reasoningEffort: string }
  readonly defaultRoute: () => { readonly provider: string; readonly model: string } | undefined
  readonly resolveModelInfo: (provider: string, model: string) => Promise<ModelInfoLike>
  readonly onFallback: (configured: SummaryRoute, fallback: SummaryRoute, reason: string) => void
  readonly now: () => number
}

/**
 * Route for background summaries, read per job: the configured
 * `summarizer.provider/model` (an empty provider means the default model's
 * provider, an empty model the default model), falling back to the default
 * model when the configured one cannot be resolved for that provider.
 * `onFallback` fires once per unresolvable route.
 */
export function createBackgroundRoute(deps: BackgroundRouteDeps): () => Promise<SummaryRoute> {
  const availability = new Map<string, { readonly ok: boolean; readonly reason: string; readonly at: number }>()
  const reported = new Set<string>()

  const check = async (provider: string, model: string): Promise<{ ok: boolean; reason: string }> => {
    const key = `${provider}/${model}`
    const cached = availability.get(key)
    if (cached !== undefined && deps.now() - cached.at < AVAILABILITY_TTL_MS) return cached
    let result: { ok: boolean; reason: string }
    try {
      const info = await deps.resolveModelInfo(provider, model)
      result = info.id === undefined || info.id === model
        ? { ok: true, reason: '' }
        : { ok: false, reason: `provider "${provider}" resolved "${model}" to "${info.id}"` }
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    availability.set(key, { ...result, at: deps.now() })
    return result
  }

  return async () => {
    const configured = deps.configured()
    const fallback = safeDefault(deps.defaultRoute)
    const effort = configured.reasoningEffort.trim()
    const withEffort = (route: { provider: string; model: string }): SummaryRoute => ({ ...route, ...effort.length > 0 ? { reasoningEffort: effort } : {} })
    const provider = configured.provider.trim() || fallback?.provider || ''
    const model = configured.model.trim() || (provider === fallback?.provider ? fallback.model : '')
    const route = withEffort({ provider, model })
    if (fallback === undefined || (provider === fallback.provider && model === fallback.model)) return route
    const { ok, reason } = provider.length > 0 && model.length > 0
      ? await check(provider, model)
      : { ok: false, reason: 'no model configured for this provider' }
    if (ok) return route
    const replacement = withEffort(fallback)
    const key = `${provider}/${model}`
    if (!reported.has(key)) {
      reported.add(key)
      deps.onFallback(route, replacement, reason)
    }
    return replacement
  }
}

function safeDefault(read: () => { readonly provider: string; readonly model: string } | undefined): { provider: string; model: string } | undefined {
  try {
    const route = read()
    return route !== undefined && route.provider.length > 0 && route.model.length > 0 ? { provider: route.provider, model: route.model } : undefined
  } catch {
    return undefined
  }
}
