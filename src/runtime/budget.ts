import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompressionLevel, LevelOverrides, ModelCapacity, ResolvedBudget } from '../contracts.ts'
import { DEFAULT_ENGINE_HEADROOM_TOKENS, type EngineBudgetHints } from '../engine/index.ts'
import { resolveBudget } from '../pack/index.ts'

/** r: share of `W − O − H` the memory block may take (design §3.4). */
export const MEMORY_SHARE = 0.25

/**
 * W assumed when the routed model does not report a context window: small on
 * purpose, so the memory block and recall limits never outgrow a small model.
 * Status reports such a capacity with `known: false`.
 */
export const FALLBACK_CONTEXT_WINDOW = 32 * 1024

const MODEL_INFO_TTL_MS = 10 * 60_000
const FAILED_INFO_TTL_MS = 30_000

export interface ModelInfoLike {
  readonly id?: string
  readonly context?: { readonly contextWindow?: number }
  readonly defaultMaxTokens?: number
}

export interface ModelRoute {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
}

export interface BudgetServiceDeps {
  readonly resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<ModelInfoLike>
  readonly defaultRoute: () => { readonly provider: string; readonly model: string } | undefined
  readonly level: () => CompressionLevel
  readonly overrides: () => LevelOverrides
  readonly now: () => number
}

export interface CapacityReport {
  readonly route?: ModelRoute
  readonly capacity: ModelCapacity
  /** False when the window is {@link FALLBACK_CONTEXT_WINDOW} because the model reported none. */
  readonly known: boolean
}

export interface BudgetService {
  /** The engine's `budgetFor`: hints from the engine win over our own resolution. */
  budgetFor(agent: Agent, hints?: EngineBudgetHints): Promise<ResolvedBudget>
  /** Synchronous budget from cached model facts (fallback window when unknown); refreshes the cache in the background. */
  budgetNow(agent: Agent): ResolvedBudget
  /** Budget for background work without an agent: the default model's capacity. */
  levelBudget(): Promise<ResolvedBudget>
  /**
   * {@link levelBudget} from cached model facts, for synchronous callers;
   * `undefined` until the default model's lookup has completed (it is
   * started) and while there is no default model, so callers never act on a
   * guessed window.
   */
  levelBudgetKnown(): ResolvedBudget | undefined
  capacityFor(agent: Agent, signal?: AbortSignal): Promise<CapacityReport>
  /** Context window of the agent's route if already known. */
  knownWindow(agent: Agent): number | undefined
  routeOf(agent: Agent): ModelRoute | undefined
}

interface CachedInfo {
  readonly contextWindow?: number
  readonly defaultMaxTokens?: number
  readonly at: number
  readonly failed?: true
}

/** Level budgets per agent from the routed request header (or agent/default model) via `resolveModelInfo` (design §3.7). */
export function createBudgetService(deps: BudgetServiceDeps): BudgetService {
  const infos = new Map<string, CachedInfo>()
  const pending = new Map<string, Promise<CachedInfo>>()

  const key = (route: ModelRoute): string => `${route.provider}/${route.model}`

  const fetchInfo = (route: ModelRoute, signal?: AbortSignal): Promise<CachedInfo> => {
    const id = key(route)
    const cached = infos.get(id)
    if (cached !== undefined && deps.now() - cached.at < (cached.failed ? FAILED_INFO_TTL_MS : MODEL_INFO_TTL_MS)) return Promise.resolve(cached)
    let flight = pending.get(id)
    if (flight === undefined) {
      flight = deps.resolveModelInfo(route.provider, route.model, signal)
        .then((info): CachedInfo => ({
          ...positive(info.context?.contextWindow) === undefined ? {} : { contextWindow: positive(info.context?.contextWindow) as number },
          ...positive(info.defaultMaxTokens) === undefined ? {} : { defaultMaxTokens: positive(info.defaultMaxTokens) as number },
          at: deps.now(),
        }))
        .catch((): CachedInfo => ({ at: deps.now(), failed: true }))
        .then((info) => {
          infos.set(id, info)
          return info
        })
        .finally(() => pending.delete(id))
      pending.set(id, flight)
    }
    return flight
  }

  const routeOf = (agent: Agent): ModelRoute | undefined => {
    try {
      const header = agent.session.requestHeader()?.config
      if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
        return { provider: header.provider, model: header.model, ...positive(header.maxTokens) === undefined ? {} : { maxTokens: header.maxTokens as number } }
      }
    } catch {}
    const options = agent.options as { provider?: string; model?: string; maxTokens?: number } | undefined
    if (options?.provider && options.model) {
      return { provider: options.provider, model: options.model, ...positive(options.maxTokens) === undefined ? {} : { maxTokens: options.maxTokens as number } }
    }
    return defaultRoute()
  }

  const defaultRoute = (): ModelRoute | undefined => {
    try {
      const selection = deps.defaultRoute()
      return selection !== undefined && selection.provider.length > 0 && selection.model.length > 0
        ? { provider: selection.provider, model: selection.model }
        : undefined
    } catch {
      return undefined
    }
  }

  const capacityOf = (route: ModelRoute | undefined, info: CachedInfo | undefined): CapacityReport => {
    const window = info?.contextWindow
    return {
      ...route === undefined ? {} : { route },
      capacity: {
        contextWindow: window ?? FALLBACK_CONTEXT_WINDOW,
        reservedOutputTokens: route?.maxTokens ?? info?.defaultMaxTokens ?? 0,
      },
      known: window !== undefined,
    }
  }

  const resolve = (capacity: ModelCapacity, headroomTokens = DEFAULT_ENGINE_HEADROOM_TOKENS): ResolvedBudget => resolveBudget({
    level: deps.level(),
    overrides: deps.overrides(),
    capacity,
    headroomTokens,
    memoryShare: MEMORY_SHARE,
  })

  const capacityFor = async (agent: Agent, signal?: AbortSignal): Promise<CapacityReport> => {
    const route = routeOf(agent)
    return capacityOf(route, route === undefined ? undefined : await fetchInfo(route, signal))
  }

  return {
    async budgetFor(agent, hints) {
      const capacity = hints?.capacity ?? (await capacityFor(agent)).capacity
      return resolve(capacity, hints?.headroomTokens)
    },

    budgetNow(agent) {
      const route = routeOf(agent)
      if (route !== undefined) void fetchInfo(route)
      return resolve(capacityOf(route, route === undefined ? undefined : infos.get(key(route))).capacity)
    },

    async levelBudget() {
      const route = defaultRoute()
      return resolve(capacityOf(route, route === undefined ? undefined : await fetchInfo(route)).capacity)
    },

    levelBudgetKnown() {
      const route = defaultRoute()
      if (route === undefined) return undefined
      void fetchInfo(route)
      const info = infos.get(key(route))
      return info === undefined ? undefined : resolve(capacityOf(route, info).capacity)
    },

    capacityFor,

    knownWindow(agent) {
      const route = routeOf(agent)
      return route === undefined ? undefined : infos.get(key(route))?.contextWindow
    },

    routeOf,
  }
}

/** Config overrides without unset fields, as `LevelOverrides`. */
export function levelOverrides(raw: unknown): LevelOverrides {
  if (typeof raw !== 'object' || raw === null) return {}
  const overrides: Record<string, number> = {}
  for (const [field, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) overrides[field] = value
  }
  return overrides as LevelOverrides
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
