import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig, ModelCompactPolicyConfig, ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import z from '@deepseek-ai/schemastery'
import type { CheckpointComposer, ModelCapacity, ResolvedBudget, ScopeDecision } from '../contracts.ts'
import { createTokenEstimator } from '../pack/estimator.ts'
import { DEFAULT_ENGINE_HEADROOM_TOKENS, meterRetainTokens, thresholdConfigFor, type SurfaceTokens, type ThresholdConfig } from './budget.ts'
import {
  DEFAULT_COMPOSE_TIMEOUT_MS,
  isEngineHost,
  MEMORY_CLOUD_SERVICE,
  MEMORY_ENGINE_BRAND,
  type EngineCheckpointRequest,
  type EngineFallbackKind,
  type EngineHost,
} from './host.ts'
import { fitsShrinkGuard, maxCheckpointChars, measureRegion, MIN_CHECKPOINT_CHARS, priceConversation } from './shrink.ts'

/** Engine row config: compaction-basic's keys plus our own, which are stripped before `super()`. */
export interface MemoryEngineConfig extends BasicCompactionConfig {
  composeTimeoutMs?: number
}

const OWN_KEYS = ['composeTimeoutMs'] as const satisfies readonly (keyof MemoryEngineConfig)[]

const ROUTINE_FALLBACKS: ReadonlySet<EngineFallbackKind> = new Set(['subagent', 'no-capture', 'region-too-small'])

export class ComposeTimeoutError extends Error {
  override readonly name = 'ComposeTimeoutError'

  constructor(readonly timeoutMs: number) {
    super(`checkpoint composition timed out after ${timeoutMs} ms`)
  }
}

/**
 * compaction-basic with memory checkpoints (design §3.1 A). Selection,
 * locking, tool pairing, commit, and overflow recovery stay with the host
 * implementation; this class only adds the level thresholds as one
 * `modelPolicies` entry per routed model (with the retained tail rescaled to
 * the token meter's heuristic pricing, see {@link meterRetainTokens}) and
 * replaces the summary text when
 * the `memoryCloud` service can compose one that DSH will accept. Every other
 * path is `super.summarize()`.
 */
export class MemoryCompactionEngine extends BasicCompactionEngine {
  static override Config: z<MemoryEngineConfig> = z.intersect([
    BasicCompactionEngine.Config,
    z.object({
      composeTimeoutMs: z.natural().min(1000).default(DEFAULT_COMPOSE_TIMEOUT_MS)
        .description('Time allowed for composing a memory checkpoint before falling back to the default summary.'),
    }),
  ])

  declare config: ResolvedConfig

  readonly [MEMORY_ENGINE_BRAND] = true

  /** Config as resolved from the row; its top-level fields always apply, and it is the whole config while no model is mapped. */
  readonly baseConfig: ResolvedConfig
  readonly composeTimeoutMs: number
  readonly headroomTokens: number
  private readonly explicitMaxTokens: number | undefined
  /** Real-token estimate without the packing safety margin, to rescale the level retain for compaction-basic. */
  private readonly estimator = createTokenEstimator({ safetyMargin: 1 })
  /** Mapped level thresholds keyed by routed `provider/model`; see {@link applyPolicy}. */
  private readonly mappedPolicies = new Map<string, ModelCompactPolicyConfig>()

  constructor(ctx: Context, config: MemoryEngineConfig = {}) {
    super(ctx, basicConfig(config))
    this.baseConfig = this.config
    this.composeTimeoutMs = positiveInteger(config.composeTimeoutMs) ?? DEFAULT_COMPOSE_TIMEOUT_MS
    this.headroomTokens = nonNegativeInteger(config.headroomTokens) ?? DEFAULT_ENGINE_HEADROOM_TOKENS
    this.explicitMaxTokens = positiveInteger(config.maxTokens)
  }

  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    const mapped = await this.policyFor(agent, signal)
    const target = routedTarget(agent)
    if (target !== undefined) this.applyPolicy(target, mapped)
    return super.compactIfNeeded(agent, trigger, signal)
  }

  protected override async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    const host = this.memoryHost()
    if (host === undefined || !hostEnabled(host, agent)) return this.defaultSummary(input, agent, signal)
    const handBack = (kind: EngineFallbackKind, detail?: string, error?: unknown): Promise<SummaryResult> => {
      this.reportFallback(host, agent, kind, 'summarize', detail, error)
      return this.defaultSummary(input, agent, signal)
    }

    if (isSubagent(agent)) return handBack('subagent')
    let scope: ScopeDecision
    try {
      scope = host.scopeFor(agent)
    } catch (error: unknown) {
      return handBack('scope-error', undefined, error)
    }
    if (!scope.capture) return handBack('no-capture', scope.reason)

    const region = measureRegion(input.messages)
    const maxChars = maxCheckpointChars(region.tokens)
    if (maxChars < MIN_CHECKPOINT_CHARS) return handBack('region-too-small', `${region.tokens} region tokens allow ${maxChars} chars`)

    let budget: ResolvedBudget
    try {
      const capacity = await this.capacityFor(agent, signal)
      budget = await host.budgetFor(agent, { headroomTokens: this.headroomTokens, ...capacity === undefined ? {} : { capacity } })
    } catch (error: unknown) {
      signal?.throwIfAborted()
      return handBack('budget-error', undefined, error)
    }

    const route = conversationRoute(agent)
    const toolHistory = toolHistoryOf(agent)
    const request: EngineCheckpointRequest = {
      sessionId: agent.session.id,
      scope: scope.scope,
      ...optionalSeqs(regionSeqsOf(agent, region.messages)),
      regionChars: region.chars,
      maxChars,
      replay: {
        messages: input.messages,
        ...input.tools === undefined ? {} : { tools: input.tools },
        ...toolHistory === undefined ? {} : { toolHistory },
      },
      ...route === undefined ? {} : { route },
      budget,
      now: Date.now(),
    }
    let text: string
    try {
      text = await composeWithin(host.composer, request, this.composeTimeoutMs, signal)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      return error instanceof ComposeTimeoutError
        ? handBack('compose-timeout', error.message, error)
        : handBack('compose-error', undefined, error)
    }
    if (typeof text !== 'string' || text.trim().length === 0) return handBack('empty')
    if (!fitsShrinkGuard(text, region.tokens)) {
      return handBack('shrink-guard', `${text.length} chars exceed the ${maxChars}-char cap for ${region.tokens} region tokens`)
    }
    return { summary: [{ type: 'text', text }], ...summaryTarget(agent) }
  }

  /** compaction-basic's own summary, used for every hand-back. */
  private defaultSummary(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    signal?.throwIfAborted()
    return super.summarize(input, agent, signal)
  }

  /** The level thresholds for the agent's routed model, `undefined` when the row config should apply unchanged. */
  private async policyFor(agent: Agent, signal: AbortSignal): Promise<ThresholdConfig | undefined> {
    const host = this.memoryHost()
    if (host === undefined || !hostEnabled(host, agent) || isSubagent(agent)) return undefined
    try {
      const capacity = await this.capacityFor(agent, signal)
      if (capacity === undefined) return undefined
      const budget = await host.budgetFor(agent, { headroomTokens: this.headroomTokens, capacity })
      const mapped = thresholdConfigFor(budget, capacity, {
        headroomTokens: this.headroomTokens,
        ...this.explicitMaxTokens === undefined ? {} : { maxTokens: this.explicitMaxTokens },
      })
      if (mapped === undefined) return undefined
      const retainTokens = meterRetainTokens(mapped.retainTokens, {
        thresholdTokens: mapped.thresholdTokens,
        memoryBudgetTokens: budget.memoryBudgetTokens,
        ...this.surfaceFacts(agent),
      })
      return { ...mapped, retainTokens }
    } catch (error: unknown) {
      if (!signal.aborted) this.reportFallback(host, agent, 'budget-error', 'threshold', undefined, error)
      return undefined
    }
  }

  /**
   * Record (or drop) the mapped policy of one routed model. The live config
   * keeps the row's top-level fields and carries one `modelPolicies` entry per
   * mapped model, so compaction-basic's model-switch check and the
   * `super.summarize()` fallback resolve the policy of the model they price
   * rather than whichever agent compacted last.
   */
  private applyPolicy(target: RouteTarget, mapped: ThresholdConfig | undefined): void {
    const key = routeKey(target)
    if (mapped === undefined) {
      if (!this.mappedPolicies.delete(key)) return
    } else {
      this.mappedPolicies.set(key, {
        provider: target.provider,
        model: target.model,
        thresholdRatio: mapped.thresholdRatio,
        headroomTokens: mapped.headroomTokens,
        retainTokens: mapped.retainTokens,
        maxTokens: mapped.maxTokens,
      })
    }
    this.config = this.mappedPolicies.size === 0
      ? this.baseConfig
      : { ...this.baseConfig, modelPolicies: mergePolicies(this.baseConfig.modelPolicies, this.mappedPolicies) }
  }

  /** The live surface under both pricings plus the meter's usage-anchored total, each omitted when unreadable. */
  private surfaceFacts(agent: Agent): { surface?: SurfaceTokens; measuredTokens?: number } {
    const facts: { surface?: SurfaceTokens; measuredTokens?: number } = {}
    try {
      facts.surface = priceConversation(agent.session.deriveMessages(), text => this.estimator.estimate(text))
    } catch {}
    try {
      const meter = this.ctx.tokenMeter as Partial<Pick<typeof this.ctx.tokenMeter, 'measure'>> | undefined
      const header = agent.session.requestHeader()
      const total = typeof meter?.measure === 'function' ? meter.measure(agent.session, header).totalTokens : undefined
      if (typeof total === 'number' && Number.isFinite(total)) facts.measuredTokens = total
    } catch {}
    return facts
  }

  private async capacityFor(agent: Agent, signal?: AbortSignal): Promise<ModelCapacity | undefined> {
    const header = agent.session.requestHeader()
    if (header === undefined || header.config.provider.length === 0 || header.config.model.length === 0) return undefined
    const info = await this.ctx.llm.resolveModelInfo(header.config.provider, header.config.model, signal)
    const contextWindow = info.context?.contextWindow
    if (contextWindow === undefined) return undefined
    return { contextWindow, reservedOutputTokens: header.config.maxTokens ?? info.defaultMaxTokens ?? 0 }
  }

  private memoryHost(): EngineHost | undefined {
    try {
      const host: unknown = this.ctx.get(MEMORY_CLOUD_SERVICE)
      return isEngineHost(host) ? host : undefined
    } catch {
      return undefined
    }
  }

  private reportFallback(host: EngineHost, agent: Agent, kind: EngineFallbackKind, stage: 'threshold' | 'summarize', detail?: string, error?: unknown): void {
    const sessionId = agent.session.id
    const message = error === undefined ? detail : errorMessage(error)
    try {
      if (ROUTINE_FALLBACKS.has(kind)) this.ctx.logger.debug('%s fallback (%s) for %s%s', stage, kind, sessionId, message === undefined ? '' : `: ${message}`)
      else this.ctx.logger.warn('%s fallback (%s) for %s%s', stage, kind, sessionId, message === undefined ? '' : `: ${message}`)
    } catch {}
    try {
      host.notifyFallback({
        kind,
        stage,
        sessionId,
        ...detail === undefined ? {} : { detail },
        ...error === undefined ? {} : { error },
      })
    } catch {}
  }
}

/** Strip engine-only keys so compaction-basic's strict key validation accepts the rest. */
export function basicConfig(config: MemoryEngineConfig): BasicCompactionConfig {
  const basic: Record<string, unknown> = { ...config }
  for (const key of OWN_KEYS) delete basic[key]
  return basic as BasicCompactionConfig
}

/**
 * Run the composer under a timeout and the caller's signal. The composer gets
 * a signal aborted on either; a composer that ignores it is abandoned and its
 * late settlement is swallowed.
 */
export async function composeWithin(composer: CheckpointComposer, request: EngineCheckpointRequest, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ComposeTimeoutError(timeoutMs)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
    if (signal !== undefined) {
      onAbort = () => {
        controller.abort(signal.reason)
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  const composed = Promise.resolve().then(() => composer.compose(request, controller.signal))
  composed.catch(() => {})
  try {
    return await Promise.race([composed, stopped])
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Session-log seqs of the replayed region, matched by message identity against
 * the live surface. `undefined` unless every region message is accounted for.
 */
export function regionSeqsOf(agent: Agent, messages: readonly { readonly id: string }[]): number[] | undefined {
  if (messages.length === 0) return undefined
  try {
    const session = agent.session
    const wanted = new Set(messages.map(message => message.id))
    const seqs: number[] = []
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq)
      const message = event === undefined ? null : session.deriveEventMessage(event)
      if (message !== null && wanted.has(message.id)) seqs.push(seq)
    }
    return seqs.length === wanted.size ? seqs : undefined
  } catch {
    return undefined
  }
}

function optionalSeqs(seqs: number[] | undefined): { regionSeqs?: readonly number[] } {
  return seqs === undefined ? {} : { regionSeqs: seqs }
}

type RouteTarget = { readonly provider: string; readonly model: string }

function routeKey(target: RouteTarget): string {
  return `${target.provider}\u0000${target.model}`
}

/** The model the latest durable request header routed to, as compaction-basic prices pressure. */
function routedTarget(agent: Agent): RouteTarget | undefined {
  try {
    const config = agent.session.requestHeader()?.config
    return config !== undefined && config.provider.length > 0 && config.model.length > 0 ? { provider: config.provider, model: config.model } : undefined
  } catch {
    return undefined
  }
}

/**
 * The row's own `modelPolicies` keep precedence field by field over a mapped
 * entry for the same model (a row retention form replaces the mapped
 * `retainTokens`), exactly as they took precedence over the mapped top-level
 * fields before; models only we mapped are appended.
 */
function mergePolicies(
  rows: readonly Readonly<ModelCompactPolicyConfig>[],
  mapped: ReadonlyMap<string, ModelCompactPolicyConfig>,
): ModelCompactPolicyConfig[] {
  const merged: ModelCompactPolicyConfig[] = []
  const used = new Set<string>()
  for (const row of rows) {
    const key = routeKey(row)
    const own = mapped.get(key)
    if (own === undefined) {
      merged.push({ ...row })
      continue
    }
    used.add(key)
    const ownsRetention = row.retainRatio !== undefined || row.retainTokens !== undefined
    const { retainTokens: _retain, ...withoutRetention } = own
    merged.push({ ...ownsRetention ? withoutRetention : own, ...definedFields(row) })
  }
  for (const [key, own] of mapped) if (!used.has(key)) merged.push({ ...own })
  return merged
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>
}

/** The session's latest routed model, else the agent's configured one, like compaction-basic's own summarizer. */
export function conversationRoute(agent: Agent): { provider: string; model: string } | undefined {
  const routed = agent.session.requestHeader()?.config
  if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model }
  }
  const { provider, model } = agent.options
  if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) return { provider, model }
  return undefined
}

function summaryTarget(agent: Agent): { provider: string; model: string } {
  return conversationRoute(agent) ?? { provider: 'memory-cloud', model: 'checkpoint' }
}

function toolHistoryOf(agent: Agent): unknown {
  try {
    return agent.session.toolHistory()
  } catch {
    return undefined
  }
}

function isSubagent(agent: Agent): boolean {
  return agent.session.header.origin === 'subagent'
}

function hostEnabled(host: EngineHost, agent: Agent): boolean {
  try {
    return host.isEnabled(agent) === true
  } catch {
    return false
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
