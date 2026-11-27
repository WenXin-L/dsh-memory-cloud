import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionMode, EffectiveMode } from '../contracts.ts'
import type { CoexistenceReport } from '../scope/index.ts'

export interface ModeDecision {
  readonly mode: EffectiveMode
  readonly configured: CompactionMode
  /** Whether this agent's compaction service is our memory engine. */
  readonly engineActive: boolean
  readonly reason: string
}

export interface ModeResolverDeps {
  readonly configured: () => CompactionMode
  /** The agent's compaction service; a decision cached for another service object is recomputed. */
  readonly compactionService: (agent: Agent) => unknown
  /** Whether that service is our memory engine. */
  readonly engineOwns: (service: unknown) => boolean
  readonly coexistence: () => CoexistenceReport
}

export interface ModeResolver {
  /**
   * Cached per agent; computed on first use and again whenever the agent's
   * compaction service is a different object (a preset rebind before the
   * first turn emits no new `agent/created`).
   */
  modeFor(agent: Agent): ModeDecision
  /** Recompute and cache (on `agent/created` and `agent-preset/selected`). */
  refresh(agent: Agent): ModeDecision
  /** Forget every cached decision (settings changed). */
  invalidate(): void
}

const TAKEOVER_HINT = '要让记忆云接管压缩，请运行 /memory takeover。'

/**
 * Effective mode per agent (design §3.1): `off` and `assist` are literal;
 * `engine` falls back to assist unless our engine is the agent's compaction
 * service; `auto` picks engine only when our engine owns compaction and no
 * other compaction plugin is loaded.
 */
export function decideMode(configured: CompactionMode, engineActive: boolean, coexistence: CoexistenceReport): ModeDecision {
  const base = { configured, engineActive }
  switch (configured) {
    case 'off':
      return { ...base, mode: 'off', reason: '已选 off。记忆块留在会话外，记忆云也不接管压缩。' }
    case 'assist':
      return { ...base, mode: 'assist', reason: '已选 assist。宿主负责压缩，记忆云在压缩后把记忆块放回来。' }
    case 'engine':
      return engineActive
        ? { ...base, mode: 'engine', reason: '已选 engine。这个会话的压缩由记忆云接手。' }
        : { ...base, mode: 'assist', reason: `已选 engine。这个会话仍在使用宿主引擎，记忆云已退回辅助模式。${TAKEOVER_HINT}` }
    case 'auto': {
      const others = coexistence.compactionPlugins.map(plugin => plugin.id)
      if (!engineActive) return { ...base, mode: 'assist', reason: `auto 已选辅助模式。宿主引擎负责这个会话的压缩。${TAKEOVER_HINT}` }
      if (others.length > 0) return { ...base, mode: 'assist', reason: `auto 已选辅助模式。还发现了这些压缩插件：${others.join('、')}。` }
      return { ...base, mode: 'engine', reason: 'auto 已选引擎模式。记忆云已接手这个会话的压缩，也未检测到其他已知压缩插件。' }
    }
  }
}

export function createModeResolver(deps: ModeResolverDeps): ModeResolver {
  let cache = new WeakMap<Agent, { readonly decision: ModeDecision; readonly service: unknown }>()

  const serviceOf = (agent: Agent): unknown => {
    try {
      return deps.compactionService(agent)
    } catch {
      return undefined
    }
  }

  const compute = (service: unknown): ModeDecision => {
    let engineActive = false
    try {
      engineActive = deps.engineOwns(service)
    } catch {}
    let coexistence: CoexistenceReport
    try {
      coexistence = deps.coexistence()
    } catch {
      coexistence = { memoryPlugins: [], compactionPlugins: [], bridgePlugins: [], recommendation: 'engine', toolConflicts: [], warnings: { zh: [], en: [] } }
    }
    let configured: CompactionMode
    try {
      configured = deps.configured()
    } catch {
      configured = 'auto'
    }
    return decideMode(configured, engineActive, coexistence)
  }

  const refresh = (agent: Agent, service: unknown): ModeDecision => {
    const decision = compute(service)
    cache.set(agent, { decision, service })
    return decision
  }

  return {
    modeFor(agent) {
      const service = serviceOf(agent)
      const cached = cache.get(agent)
      return cached !== undefined && cached.service === service ? cached.decision : refresh(agent, service)
    },
    refresh(agent) {
      return refresh(agent, serviceOf(agent))
    },
    invalidate() {
      cache = new WeakMap()
    },
  }
}
