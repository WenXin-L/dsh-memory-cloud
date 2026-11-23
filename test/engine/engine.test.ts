import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { ModelCompactPolicyConfig, ResolvedConfig, ResolvedTargetPolicy } from '@deepseek-ai/dsh-compaction-basic'
import { resolveCompactSpec, resolveTargetPolicy } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import { createTokenEstimator, resolveBudget } from '../../src/pack/index.ts'
import type { ResolvedBudget, ScopeDecision, ScopeId } from '../../src/contracts.ts'
import { ComposeTimeoutError, MemoryCompactionEngine, type MemoryEngineConfig } from '../../src/engine/engine.ts'
import EngineEntry from '../../src/engine/entry.ts'
import { MEMORY_SHARE } from '../../src/runtime/budget.ts'
import {
  DEFAULT_COMPOSE_TIMEOUT_MS,
  DEFAULT_ENGINE_HEADROOM_TOKENS,
  estimateMessageTokens,
  fitsShrinkGuard,
  maxCheckpointChars,
  measureRegion,
  MEMORY_CLOUD_SERVICE,
  MIN_CHECKPOINT_CHARS,
  priceConversation,
  RETAIN_CEILING_SHARE,
  thresholdConfigFor,
  type EngineBudgetHints,
  type EngineCheckpointRequest,
  type EngineFallback,
  type EngineHost,
} from '../../src/engine/index.ts'

const K = 1024
const WINDOW = 128 * K

type Summarize = (input: SummarizationInput, agent: Agent, signal?: AbortSignal) => Promise<SummaryResult>

const DEFAULT_RESULT: SummaryResult = { summary: [{ type: 'text', text: 'default summary' }], provider: 'fake', model: 'fake-1' }
const OWNER: ScopeDecision = { scope: OWNER_SCOPE, capture: true, private: true, reason: 'owner session' }
const TOOLS: ToolSchema[] = [{ name: 'memory_read', description: 'Read memory', parameters: { type: 'object', properties: {} } }]

function levelBudget(overrides: Partial<ResolvedBudget> = {}): ResolvedBudget {
  return {
    level: 3,
    thresholdTokens: 112 * K,
    thresholdRatio: 0.875,
    retainTokens: 24 * K,
    memoryBudgetTokens: 24 * K,
    quotas: { profile: 2334, recent: 12838, distant: 8176, ongoing: 1228 },
    recentSummaryCount: 6,
    recentSummaryTokens: 800,
    gistTokens: 50,
    recallLimitTokens: 8 * K,
    ...overrides,
  }
}

interface HostOptions {
  readonly enabled?: (agent?: Agent) => boolean
  readonly scope?: () => ScopeDecision
  readonly budget?: () => Promise<ResolvedBudget>
  readonly compose?: (request: EngineCheckpointRequest, signal?: AbortSignal) => Promise<string>
  readonly notify?: (reason: EngineFallback) => void
}

function fakeHost(options: HostOptions = {}) {
  const fallbacks: EngineFallback[] = []
  const requests: EngineCheckpointRequest[] = []
  const hints: (EngineBudgetHints | undefined)[] = []
  const host: EngineHost = {
    async budgetFor(_agent, hint) {
      hints.push(hint)
      return options.budget === undefined ? levelBudget() : options.budget()
    },
    composer: {
      async compose(request, signal) {
        requests.push(request as EngineCheckpointRequest)
        return options.compose === undefined ? 'MEMORY CHECKPOINT' : options.compose(request as EngineCheckpointRequest, signal)
      },
    },
    scopeFor: () => options.scope?.() ?? OWNER,
    isEnabled: agent => options.enabled?.(agent) ?? true,
    notifyFallback(reason) {
      fallbacks.push(reason)
      options.notify?.(reason)
    },
  }
  return { host, fallbacks, requests, hints }
}

interface SetupOptions {
  readonly host?: EngineHost
  readonly contextWindow?: number | null
  readonly config?: MemoryEngineConfig
  readonly meter?: object
}

function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  const contextWindow = options.contextWindow === undefined ? WINDOW : options.contextWindow
  const resolveModelInfo = vi.fn(async (provider: string, model: string) => ({
    provider,
    id: model,
    name: model,
    ...contextWindow === null ? {} : { context: { contextWindow } },
  }))
  ctx.provide('llm', { resolveModelInfo })
  ctx.provide('tokenMeter', options.meter ?? {})
  ctx.provide('sessions', {})
  if (options.host !== undefined) ctx.provide(MEMORY_CLOUD_SERVICE, options.host)
  const engine = new MemoryCompactionEngine(ctx, { auto: false, ...options.config })
  return { ctx, engine, resolveModelInfo }
}

/**
 * A context for an engine with automatic listeners. `priced` records the policy
 * the tracked engine's live config resolves for each metered header, so its
 * last entry is the one compaction-basic's model-switch check priced.
 */
function switchContext(windows: Record<string, number>, totalTokens: number) {
  const ctx = new Context()
  const priced: ResolvedTargetPolicy[] = []
  let engine: MemoryCompactionEngine | undefined
  ctx.provide('llm', { resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model, context: { contextWindow: windows[model]! } }) })
  ctx.provide('tokenMeter', {
    measure: (_session: Session, header?: { readonly config: { readonly provider: string; readonly model: string } }) => {
      if (engine !== undefined && header !== undefined) priced.push(resolveTargetPolicy(engine.config, header.config))
      return { totalTokens, surfaceTokens: totalTokens, baseline: 'estimated', nodes: [] }
    },
  })
  ctx.provide('sessions', {})
  const track = (value: MemoryCompactionEngine): MemoryCompactionEngine => {
    engine = value
    return value
  }
  return { ctx, priced, track }
}

interface ConversationOptions {
  readonly id?: string
  readonly subagent?: boolean
  readonly turns?: number
  readonly size?: number
  readonly routed?: boolean
}

function conversation(options: ConversationOptions = {}) {
  const id = SessionId(options.id ?? 'sess-1')
  const session = Session.create(id, undefined, options.subagent === true
    ? { version: 4, id, createdAt: 1, isSeeded: false, origin: 'subagent', parentSession: SessionId('parent'), delegationDepth: 1 }
    : undefined)
  if (options.routed !== false) {
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'fake', model: 'fake-1', maxTokens: 4096 }, tools: TOOLS } })
  }
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('You are a companion.') }, { surfaceOp: 'append' })
  const size = options.size ?? 400
  for (let turn = 0; turn < (options.turns ?? 4); turn++) {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `question ${turn} ${'q'.repeat(size)}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: turn + 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: `answer ${turn} ${'a'.repeat(size)}` }], source: { provider: 'fake', model: 'fake-1' } }),
      stream: [],
    }, { surfaceOp: 'append' })
  }
  const agent = { session, options: {} } as unknown as Agent
  const input: SummarizationInput = { tools: TOOLS, messages: session.deriveMessages() }
  return { session, agent, input }
}

function summarize(engine: MemoryCompactionEngine, input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
  return (engine as unknown as { summarize: Summarize }).summarize(input, agent, signal)
}

function spyDefaultSummary() {
  return vi.spyOn(BasicCompactionEngine.prototype as unknown as { summarize: Summarize }, 'summarize').mockResolvedValue(DEFAULT_RESULT)
}

function captureSuperConfig() {
  const seen: ResolvedConfig[] = []
  vi.spyOn(BasicCompactionEngine.prototype, 'compactIfNeeded').mockImplementation(async function (this: BasicCompactionEngine) {
    seen.push(this.config)
    return null
  })
  return seen
}

const live = () => new AbortController().signal
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('construction', () => {
  it('default-exports the engine and strips its own keys before compaction-basic validates', () => {
    expect(EngineEntry).toBe(MemoryCompactionEngine)
    const { engine } = setup({ config: { composeTimeoutMs: 5000, retainTokens: 1000 } })
    expect(engine.composeTimeoutMs).toBe(5000)
    expect(engine.headroomTokens).toBe(DEFAULT_ENGINE_HEADROOM_TOKENS)
    expect(engine.config).toBe(engine.baseConfig)
    expect(engine.baseConfig).toMatchObject({ thresholdRatio: 0.8, headroomTokens: 65_536, retainTokens: 1000, auto: false })
  })

  it('loads through Cordis with the intersected Config schema and automatic listeners', async () => {
    const ctx = new Context()
    ctx.provide('llm', { resolveModelInfo: async () => ({}) })
    ctx.provide('tokenMeter', {})
    ctx.provide('sessions', {})
    await ctx.plugin(MemoryCompactionEngine, { headroomTokens: 4096 })
    const engine = ctx.get('compaction') as MemoryCompactionEngine
    expect(engine).toBeInstanceOf(MemoryCompactionEngine)
    expect(engine.composeTimeoutMs).toBe(DEFAULT_COMPOSE_TIMEOUT_MS)
    expect(engine.headroomTokens).toBe(4096)
    expect(engine.baseConfig).toMatchObject({ headroomTokens: 4096, maxTokens: 4096, auto: true })
    expect(() => MemoryCompactionEngine.Config({ composeTimeoutMs: 10 })).toThrow()
  })
})

describe('summarize', () => {
  it('returns the composed checkpoint as a template result built from the replayed region', async () => {
    const defaults = spyDefaultSummary()
    const { host, requests, hints, fallbacks } = fakeHost()
    const { engine } = setup({ host })
    const { session, agent, input } = conversation()

    const result = await summarize(engine, input, agent)

    expect(result).toEqual({ summary: [{ type: 'text', text: 'MEMORY CHECKPOINT' }], provider: 'fake', model: 'fake-1' })
    expect(Object.keys(result)).not.toContain('rawOutput')
    expect(Object.keys(result)).not.toContain('llmStreamCall')
    expect(defaults).not.toHaveBeenCalled()
    expect(fallbacks).toEqual([])

    const region = measureRegion(input.messages)
    const request = requests[0]!
    expect(request).toMatchObject({
      sessionId: 'sess-1',
      scope: OWNER_SCOPE,
      regionSeqs: session.surface.nodes.slice(1),
      regionChars: region.chars,
      maxChars: maxCheckpointChars(region.tokens),
      budget: levelBudget(),
    })
    expect(request.replay.messages).toBe(input.messages)
    expect(request.replay.tools).toBe(TOOLS)
    expect(typeof request.now).toBe('number')
    expect(hints[0]).toEqual({ headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS, capacity: { contextWindow: WINDOW, reservedOutputTokens: 4096 } })
  })

  it('passes the scope the host decided', async () => {
    spyDefaultSummary()
    const group = { scope: 'qq-group-42' as ScopeId, capture: true, private: false, reason: 'rule' }
    const { host, requests } = fakeHost({ scope: () => group })
    const { engine } = setup({ host })
    const { agent, input } = conversation()
    await summarize(engine, input, agent)
    expect(requests[0]?.scope).toBe('qq-group-42')
  })

  it('accepts text at exactly the cap and rejects anything longer', async () => {
    const defaults = spyDefaultSummary()
    const { agent, input } = conversation()
    const exact = fakeHost({ compose: async request => 'm'.repeat(request.maxChars) })
    const accepted = await summarize(setup({ host: exact.host }).engine, input, agent)
    const text = (accepted.summary[0] as { text: string }).text
    expect(text.length).toBe(exact.requests[0]!.maxChars)
    expect(fitsShrinkGuard(text, measureRegion(input.messages).tokens)).toBe(true)
    expect(defaults).not.toHaveBeenCalled()

    const over = fakeHost({ compose: async request => 'm'.repeat(request.maxChars + 1) })
    await expect(summarize(setup({ host: over.host }).engine, input, agent)).resolves.toBe(DEFAULT_RESULT)
    expect(over.fallbacks.map(reason => reason.kind)).toEqual(['shrink-guard'])
    expect(defaults).toHaveBeenCalledTimes(1)
  })

  it('uses the default summary without notifying when the memory service is missing or disabled', async () => {
    const defaults = spyDefaultSummary()
    const { agent, input } = conversation()
    const signal = live()
    await expect(summarize(setup().engine, input, agent, signal)).resolves.toBe(DEFAULT_RESULT)
    expect(defaults).toHaveBeenLastCalledWith(input, agent, signal)

    const disabled = fakeHost({ enabled: () => false })
    await expect(summarize(setup({ host: disabled.host }).engine, input, agent)).resolves.toBe(DEFAULT_RESULT)
    const throwing = fakeHost({ enabled: () => { throw new Error('boom') } })
    await expect(summarize(setup({ host: throwing.host }).engine, input, agent)).resolves.toBe(DEFAULT_RESULT)

    const notAHost = setup()
    notAHost.ctx.provide(MEMORY_CLOUD_SERVICE, { budgetFor: () => undefined })
    await expect(summarize(notAHost.engine, input, agent)).resolves.toBe(DEFAULT_RESULT)

    expect(defaults).toHaveBeenCalledTimes(4)
    expect([...disabled.requests, ...throwing.requests]).toEqual([])
    expect([...disabled.fallbacks, ...throwing.fallbacks]).toEqual([])
  })

  it.each([
    ['subagent', {}, { subagent: true }],
    ['no-capture', { scope: () => ({ ...OWNER, capture: false, reason: 'capture off' }) }, {}],
    ['scope-error', { scope: () => { throw new Error('no rule') } }, {}],
    ['budget-error', { budget: () => Promise.reject(new Error('no model info')) }, {}],
    ['region-too-small', {}, { turns: 1, size: 10 }],
  ] satisfies [string, HostOptions, ConversationOptions][])('hands back on %s before composing', async (kind, hostOptions, conversationOptions) => {
    const defaults = spyDefaultSummary()
    const { host, fallbacks, requests } = fakeHost(hostOptions)
    const { engine } = setup({ host })
    const { agent, input } = conversation(conversationOptions)
    await expect(summarize(engine, input, agent)).resolves.toBe(DEFAULT_RESULT)
    expect(defaults).toHaveBeenCalledTimes(1)
    expect(requests).toEqual([])
    expect(fallbacks).toMatchObject([{ kind, stage: 'summarize', sessionId: 'sess-1' }])
    if (kind === 'no-capture') expect(fallbacks[0]?.detail).toBe('capture off')
    if (kind === 'region-too-small') expect(maxCheckpointChars(measureRegion(input.messages).tokens)).toBeLessThan(MIN_CHECKPOINT_CHARS)
  })

  it.each([
    ['compose-error', () => Promise.reject(new Error('llm failed'))],
    ['compose-error', () => { throw new Error('sync failure') }],
    ['empty', async () => '   \n'],
    ['empty', async () => undefined as unknown as string],
  ] satisfies [string, HostOptions['compose']][])('hands back on %s after composing', async (kind, compose) => {
    const defaults = spyDefaultSummary()
    const { host, fallbacks, requests } = fakeHost({ compose })
    const { engine } = setup({ host })
    const { agent, input } = conversation()
    await expect(summarize(engine, input, agent)).resolves.toBe(DEFAULT_RESULT)
    expect(defaults).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(1)
    expect(fallbacks.map(reason => reason.kind)).toEqual([kind])
  })

  it('times out a stuck composer, aborts its signal, and swallows its late settlement', async () => {
    const defaults = spyDefaultSummary()
    const seen: AbortSignal[] = []
    const { host, fallbacks } = fakeHost({
      compose: (_request, signal) => {
        if (signal !== undefined) seen.push(signal)
        return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late failure')), 40))
      },
    })
    const { engine } = setup({ host, config: { composeTimeoutMs: 10 } })
    const { agent, input } = conversation()
    await expect(summarize(engine, input, agent)).resolves.toBe(DEFAULT_RESULT)
    expect(defaults).toHaveBeenCalledTimes(1)
    expect(fallbacks).toMatchObject([{ kind: 'compose-timeout' }])
    expect(fallbacks[0]?.error).toBeInstanceOf(ComposeTimeoutError)
    expect(seen[0]?.aborted).toBe(true)
    expect(seen[0]?.reason).toBeInstanceOf(ComposeTimeoutError)
    await sleep(60)
  })

  it('propagates caller cancellation instead of falling back', async () => {
    const defaults = spyDefaultSummary()
    const controller = new AbortController()
    const { host, fallbacks } = fakeHost({
      compose: () => {
        setTimeout(() => controller.abort(new Error('user cancelled')), 5)
        return new Promise(() => {})
      },
    })
    const { engine } = setup({ host })
    const { agent, input } = conversation()
    await expect(summarize(engine, input, agent, controller.signal)).rejects.toThrow('user cancelled')
    expect(defaults).not.toHaveBeenCalled()
    expect(fallbacks).toEqual([])
  })

  it('still falls back when the host notification throws', async () => {
    spyDefaultSummary()
    const { host } = fakeHost({ compose: () => Promise.reject(new Error('x')), notify: () => { throw new Error('listener bug') } })
    const { engine } = setup({ host })
    const { agent, input } = conversation()
    await expect(summarize(engine, input, agent)).resolves.toBe(DEFAULT_RESULT)
  })

  it('gives the default summary of an agent it cannot map the row policy, and every other hand-back the live mappings', async () => {
    const configs: ResolvedConfig[] = []
    vi.spyOn(BasicCompactionEngine.prototype as unknown as { summarize: Summarize }, 'summarize').mockImplementation(async function (this: BasicCompactionEngine) {
      configs.push(this.config)
      return DEFAULT_RESULT
    })
    vi.spyOn(BasicCompactionEngine.prototype, 'compactIfNeeded').mockResolvedValue(null)
    const { host, fallbacks } = fakeHost({ compose: () => Promise.reject(new Error('llm failed')) })
    const { engine } = setup({ host })
    const owner = conversation({ id: 'owner' })
    await engine.compactIfNeeded(owner.agent, 'pressure', live())
    const mapped = engine.config
    expect(mapped).not.toBe(engine.baseConfig)

    const sub = conversation({ id: 'sub', subagent: true })
    await expect(summarize(engine, sub.input, sub.agent)).resolves.toBe(DEFAULT_RESULT)
    await expect(summarize(engine, owner.input, owner.agent)).resolves.toBe(DEFAULT_RESULT)

    expect(configs).toHaveLength(2)
    expect(configs[0]).toBe(engine.baseConfig)
    expect(configs[1]).toBe(mapped)
    expect(engine.config).toBe(mapped)
    expect(fallbacks.map(reason => reason.kind)).toEqual(['subagent', 'compose-error'])
  })

  it('omits regionSeqs when the region does not match the live surface', async () => {
    spyDefaultSummary()
    const { host, requests } = fakeHost()
    const { engine } = setup({ host })
    const { agent, input } = conversation()
    const foreign = conversation().input.messages
    await summarize(engine, { ...input, messages: [...input.messages.slice(0, 3), ...foreign.slice(3)] }, agent)
    expect(requests[0]).not.toHaveProperty('regionSeqs')
  })
})

describe('compactIfNeeded', () => {
  it('adds the level thresholds as the routed model\'s policy before delegating', async () => {
    const seen = captureSuperConfig()
    const budget = levelBudget({ thresholdTokens: 64 * K, retainTokens: 12 * K })
    const { host, hints } = fakeHost({ budget: async () => budget })
    const { engine } = setup({ host })
    const { agent } = conversation()

    await engine.compactIfNeeded(agent, 'pressure', live())

    const expected = thresholdConfigFor(budget, { contextWindow: WINDOW, reservedOutputTokens: 4096 }, { headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS })!
    const surface = priceConversation(agent.session.deriveMessages(), createTokenEstimator({ safetyMargin: 1 }).estimate)
    expect(surface.meterTokens).toBeLessThan(surface.realTokens)
    const policy = resolveTargetPolicy(seen[0]!, { provider: 'fake', model: 'fake-1' })
    expect(policy).toMatchObject({
      thresholdRatio: 0.5,
      headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS,
      retainTokens: Math.floor(12 * K * surface.meterTokens / surface.realTokens),
      maxTokens: DEFAULT_ENGINE_HEADROOM_TOKENS,
      compactionRetries: 1,
    })
    expect(policy).not.toHaveProperty('retainRatio')
    expect(expected.thresholdRatio).toBe(policy.thresholdRatio)
    expect(seen[0]).toMatchObject({ thresholdRatio: 0.8, headroomTokens: 65_536, retainRatio: 0.16, auto: false })
    expect(engine.baseConfig).toMatchObject({ thresholdRatio: 0.8, headroomTokens: 65_536, retainRatio: 0.16 })
    expect(hints[0]).toEqual({ headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS, capacity: { contextWindow: WINDOW, reservedOutputTokens: 4096 } })
  })

  it('honours explicit row headroom and summary cap', async () => {
    const seen = captureSuperConfig()
    const { host, hints } = fakeHost()
    const { engine } = setup({ host, config: { headroomTokens: 4096, maxTokens: 12_000 } })
    await engine.compactIfNeeded(conversation().agent, 'context-overflow', live())
    expect(resolveTargetPolicy(seen[0]!, { provider: 'fake', model: 'fake-1' })).toMatchObject({ headroomTokens: 4096, maxTokens: 12_000 })
    expect(hints[0]?.headroomTokens).toBe(4096)
  })

  it('restores the row config whenever the memory side opts out', async () => {
    const seen = captureSuperConfig()
    let enabled = true
    const { host } = fakeHost({ enabled: () => enabled })
    const { engine } = setup({ host })
    const { agent } = conversation()
    await engine.compactIfNeeded(agent, 'pressure', live())
    expect(seen[0]).not.toBe(engine.baseConfig)
    enabled = false
    await engine.compactIfNeeded(agent, 'pressure', live())
    expect(seen[1]).toBe(engine.baseConfig)
    enabled = true
    await engine.compactIfNeeded(conversation({ subagent: true }).agent, 'pressure', live())
    expect(seen[2]).toBe(engine.baseConfig)
    const bare = setup().engine
    await bare.compactIfNeeded(agent, 'pressure', live())
    expect(seen[3]).toBe(bare.baseConfig)
  })

  it('keeps the row config when the model or budget is unknown', async () => {
    const seen = captureSuperConfig()
    const failing = fakeHost({ budget: () => Promise.reject(new Error('resolver down')) })
    const failingEngine = setup({ host: failing.host }).engine
    await failingEngine.compactIfNeeded(conversation().agent, 'pressure', live())
    expect(seen[0]).toBe(failingEngine.baseConfig)
    expect(failing.fallbacks).toMatchObject([{ kind: 'budget-error', stage: 'threshold', sessionId: 'sess-1' }])

    const windowless = fakeHost()
    const windowlessEngine = setup({ host: windowless.host, contextWindow: null }).engine
    await windowlessEngine.compactIfNeeded(conversation().agent, 'pressure', live())
    expect(seen[1]).toBe(windowlessEngine.baseConfig)
    expect(windowless.hints).toEqual([])

    const unrouted = fakeHost()
    const unroutedSetup = setup({ host: unrouted.host })
    await unroutedSetup.engine.compactIfNeeded(conversation({ routed: false }).agent, 'pressure', live())
    expect(seen[2]).toBe(unroutedSetup.engine.baseConfig)
    expect(unroutedSetup.resolveModelInfo).not.toHaveBeenCalled()
  })

  it('lets compaction-basic select a range when CJK text makes usage far exceed the heuristic surface', async () => {
    const budget = resolveBudget({ level: 5, capacity: { contextWindow: 32 * K, reservedOutputTokens: 2000 }, headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS, memoryShare: MEMORY_SHARE })
    expect(budget).toMatchObject({ thresholdTokens: 22_576, retainTokens: 4922, memoryBudgetTokens: 5644 })
    const { host } = fakeHost({ budget: async () => budget })
    let compacted = false
    const nodesOf = (session: Session) => session.surface.nodes.map((seq) => {
      const event = session.eventAt(seq)
      const message = event === undefined ? null : session.deriveEventMessage(event)
      return { seq, tokens: message === null ? 0 : estimateMessageTokens(message), heuristicTokens: 0 }
    })
    const meter = {
      measure: (session: Session) => ({
        totalTokens: compacted ? 12_000 : 26_000,
        surfaceTokens: 0,
        baseline: { kind: 'usage', tokens: 26_000 },
        nodes: nodesOf(session),
      }),
    }
    const { engine } = setup({ host, meter, contextWindow: 32 * K })
    const id = SessionId('sess-cjk')
    const session = Session.create(id)
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'fake', model: 'fake-1', maxTokens: 2000 }, tools: TOOLS } })
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('你是一个陪伴型助手。') }, { surfaceOp: 'append' })
    for (let turn = 0; turn < 8; turn++) {
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `第${turn}轮：${'今天我们继续聊天'.repeat(40)}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('assistant/message', {
        turn: 1,
        step: turn + 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: '好的，我记住了。'.repeat(200) }], source: { provider: 'fake', model: 'fake-1' } }),
        stream: [],
      }, { surfaceOp: 'append' })
    }
    const heuristicSurface = nodesOf(session).reduce((sum, node) => sum + node.tokens, 0)
    expect(heuristicSurface).toBeLessThan(budget.retainTokens)
    const regions: [number, number][] = []
    vi.spyOn(BasicCompactionEngine.prototype, 'compactRegion').mockImplementation(async (start, end) => {
      regions.push([start, end])
      compacted = true
      return { shadowedSeqs: [], shadowedRange: { start, end }, shadowedTokenCount: 0 } as unknown as Awaited<ReturnType<BasicCompactionEngine['compactRegion']>>
    })

    await engine.compactIfNeeded({ session, options: {} } as unknown as Agent, 'pressure', live())

    expect(regions).toHaveLength(1)
    expect(resolveTargetPolicy(engine.config, { provider: 'fake', model: 'fake-1' }).retainTokens).toBeLessThan(heuristicSurface)
  })

  it.each([
    ['the default row', {}],
    ['an explicit row headroom', { headroomTokens: 4096 }],
  ] satisfies [string, MemoryEngineConfig][])('maps thresholds per routed model, so a switch to a smaller model uses its own policy and is not refused (%s)', async (_label, config) => {
    const { ctx, priced, track } = switchContext({ 'fake-1': WINDOW, 'small-1': 32 * K }, 1000)
    const budget = levelBudget({ thresholdTokens: 112 * K, retainTokens: 100 * K, memoryBudgetTokens: 0 })
    const { host } = fakeHost({ budget: async () => budget })
    ctx.provide(MEMORY_CLOUD_SERVICE, host)
    const engine = track(new MemoryCompactionEngine(ctx, config))
    const headroom = engine.headroomTokens
    const { session, agent } = conversation()
    const big = { provider: 'fake', model: 'fake-1' }
    const small = { provider: 'fake', model: 'small-1' }

    await engine.compactIfNeeded(agent, 'pressure', live())
    const bigPolicy = resolveTargetPolicy(engine.config, big)
    expect(bigPolicy.retainTokens).toBeGreaterThan(32 * K)
    expect(engine.config).toMatchObject({ thresholdRatio: engine.baseConfig.thresholdRatio, headroomTokens: engine.baseConfig.headroomTokens, retainRatio: 0.16 })
    expect(resolveTargetPolicy(engine.config, small)).toEqual(resolveTargetPolicy(engine.baseConfig, small))

    const header = session.requestHeader()!
    const next = { ...header.config, model: 'small-1' }
    const switched = await ctx.waterfall('agent/request', { agent, turn: 2, step: 1, signal: live() } as never, async () => next as never)
    expect(switched).toEqual(next)
    const smallMapped = thresholdConfigFor(budget, { contextWindow: 32 * K, reservedOutputTokens: 4096 }, { headroomTokens: headroom })!
    expect(priced.at(-1)).toMatchObject({ target: small, thresholdRatio: smallMapped.thresholdRatio, headroomTokens: headroom })
    expect(resolveCompactSpec(priced.at(-1)!, 32 * K, 4096).thresholdTokens).toBe(smallMapped.thresholdTokens)

    session.append('request/header', { reason: 'model-switch', header: { config: { ...next, maxTokens: 4096 }, tools: TOOLS } } as never)
    await engine.compactIfNeeded(agent, 'pressure', live())
    const smallPolicy = resolveTargetPolicy(engine.config, small)
    expect(smallPolicy).toMatchObject({ thresholdRatio: smallMapped.thresholdRatio, headroomTokens: headroom })
    expect(smallPolicy.retainTokens).toBeLessThan(smallMapped.thresholdTokens)
    expect(resolveTargetPolicy(engine.config, big)).toEqual(bigPolicy)
  })

  it('prices a switch to an unmapped model of the same size at the level threshold, not the row default', async () => {
    const { ctx, priced, track } = switchContext({ 'fake-1': WINDOW, 'fake-2': WINDOW }, 70 * K)
    const budget = levelBudget()
    const { host } = fakeHost({ budget: async () => budget })
    ctx.provide(MEMORY_CLOUD_SERVICE, host)
    const engine = track(new MemoryCompactionEngine(ctx))
    const compacted = vi.spyOn(BasicCompactionEngine.prototype, 'compactRegion')
    const { session, agent } = conversation()
    const next = { ...session.requestHeader()!.config, model: 'fake-2' }

    const rowDefault = resolveCompactSpec(resolveTargetPolicy(engine.baseConfig, { provider: 'fake', model: 'fake-2' }), WINDOW, 4096).thresholdTokens
    expect(rowDefault).toBeLessThan(70 * K)
    await expect(ctx.waterfall('agent/request', { agent, turn: 2, step: 1, signal: live() } as never, async () => next as never)).resolves.toEqual(next)

    const mapped = thresholdConfigFor(budget, { contextWindow: WINDOW, reservedOutputTokens: 4096 }, { headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS })!
    expect(mapped.thresholdTokens).toBeGreaterThan(70 * K)
    expect(resolveCompactSpec(priced.at(-1)!, WINDOW, 4096).thresholdTokens).toBe(mapped.thresholdTokens)
    expect(compacted).not.toHaveBeenCalled()
  })

  it('leaves a switch alone for agents it cannot map', async () => {
    const { ctx, priced, track } = switchContext({ 'fake-1': WINDOW, 'small-1': 32 * K }, 1000)
    const { host } = fakeHost({ enabled: () => false })
    ctx.provide(MEMORY_CLOUD_SERVICE, host)
    const engine = track(new MemoryCompactionEngine(ctx, { headroomTokens: 4096 }))
    const { session, agent } = conversation()
    const next = { ...session.requestHeader()!.config, model: 'small-1' }
    await expect(ctx.waterfall('agent/request', { agent, turn: 2, step: 1, signal: live() } as never, async () => next as never)).resolves.toEqual(next)
    expect(priced.at(-1)).toEqual(resolveTargetPolicy(engine.baseConfig, { provider: 'fake', model: 'small-1' }))
    expect(engine.config).toBe(engine.baseConfig)
  })

  it('keeps a mapping that an unmappable agent does not own, and prices that agent\'s own call with the row policy', async () => {
    const seen = captureSuperConfig()
    const assist = new Set<string>()
    const { host } = fakeHost({ enabled: agent => agent === undefined || !assist.has(agent.session.id) })
    const { engine } = setup({ host })
    const owner = conversation({ id: 'owner' }).agent
    const target = { provider: 'fake', model: 'fake-1' }

    await engine.compactIfNeeded(owner, 'pressure', live())
    const mapped = resolveTargetPolicy(engine.config, target)
    expect(mapped).not.toEqual(resolveTargetPolicy(engine.baseConfig, target))

    assist.add('assist')
    await engine.compactIfNeeded(conversation({ id: 'sub', subagent: true }).agent, 'pressure', live())
    await engine.compactIfNeeded(conversation({ id: 'assist' }).agent, 'pressure', live())
    expect(seen.slice(1)).toEqual([engine.baseConfig, engine.baseConfig])
    expect(resolveTargetPolicy(engine.config, target)).toEqual(mapped)

    assist.add('owner')
    await engine.compactIfNeeded(owner, 'pressure', live())
    expect(seen[3]).toBe(engine.baseConfig)
    expect(engine.config).toBe(engine.baseConfig)
  })

  it('keeps the mapping when one of its owners opts out', async () => {
    captureSuperConfig()
    const assist = new Set<string>()
    const { host } = fakeHost({ enabled: agent => agent === undefined || !assist.has(agent.session.id) })
    const { engine } = setup({ host })
    const first = conversation({ id: 'first' }).agent
    await engine.compactIfNeeded(first, 'pressure', live())
    await engine.compactIfNeeded(conversation({ id: 'second' }).agent, 'pressure', live())
    const mapped = engine.config
    assist.add('first')
    await engine.compactIfNeeded(first, 'pressure', live())
    expect(engine.config).toEqual(mapped)
  })

  it.each([
    ['a model-specific threshold ratio', { thresholdRatio: 0.15 }, { retainRatio: 0.1 }, 19_660],
    ['a model-specific headroom', { headroomTokens: 100_000 }, {}, WINDOW - 4096 - 100_000],
  ] satisfies [string, Partial<ModelCompactPolicyConfig>, MemoryEngineConfig, number][])('keeps the mapped retain below the threshold the row\'s %s yields', async (_label, row, top, threshold) => {
    const meter = { measure: () => ({ totalTokens: 0, surfaceTokens: 0, baseline: 'estimated', nodes: [] }) }
    const { host } = fakeHost({ budget: async () => levelBudget({ retainTokens: 100 * K }) })
    const { engine } = setup({ host, meter, config: { ...top, modelPolicies: [{ provider: 'fake', model: 'fake-1', ...row }] } })

    await expect(engine.compactIfNeeded(conversation().agent, 'pressure', live())).resolves.toBeNull()

    const spec = resolveCompactSpec(resolveTargetPolicy(engine.config, { provider: 'fake', model: 'fake-1' }), WINDOW, 4096)
    expect(spec.thresholdTokens).toBe(threshold)
    expect(spec.retainTokens).toBe(Math.ceil(threshold * RETAIN_CEILING_SHARE) - 1)
  })

  it('merges the row\'s own model policies over the mapped values, field by field', async () => {
    const seen = captureSuperConfig()
    const { host } = fakeHost()
    const { engine } = setup({ host, config: { modelPolicies: [{ provider: 'fake', model: 'fake-1', thresholdRatio: 0.7, retainRatio: 0.1 }, { provider: 'other', model: 'x' }] } })
    await engine.compactIfNeeded(conversation().agent, 'pressure', live())
    expect(seen[0]?.modelPolicies).toHaveLength(2)
    const policy = resolveTargetPolicy(seen[0]!, { provider: 'fake', model: 'fake-1' })
    expect(policy).toMatchObject({ thresholdRatio: 0.7, retainRatio: 0.1, headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS })
    expect(policy).not.toHaveProperty('retainTokens')
    expect(resolveTargetPolicy(seen[0]!, { provider: 'other', model: 'x' })).toEqual(resolveTargetPolicy(engine.baseConfig, { provider: 'other', model: 'x' }))
  })

  it('makes the real compaction-basic pressure check fire at exactly the mapped threshold', async () => {
    let total = 0
    const probe = { selected: false }
    const meter = {
      measure: () => ({
        totalTokens: total,
        surfaceTokens: total,
        baseline: 'estimated',
        get nodes() {
          probe.selected = true
          return []
        },
      }),
    }
    const budget = levelBudget({ thresholdTokens: 64 * K, retainTokens: 500_000 })
    let enabled = true
    const { host } = fakeHost({ budget: async () => budget, enabled: () => enabled })
    const { engine } = setup({ host, meter })
    const { agent } = conversation()
    const crossesAt = async (tokens: number): Promise<boolean> => {
      total = tokens
      probe.selected = false
      await expect(engine.compactIfNeeded(agent, 'pressure', live())).resolves.toBeNull()
      return probe.selected
    }

    const mapped = thresholdConfigFor(budget, { contextWindow: WINDOW, reservedOutputTokens: 4096 }, { headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS })!
    expect(mapped.thresholdTokens).toBe(64 * K)
    expect(await crossesAt(64 * K - 1)).toBe(false)
    expect(await crossesAt(64 * K)).toBe(true)

    enabled = false
    const hostDefault = Math.floor(Math.min(WINDOW * 0.8, WINDOW - 4096 - 65_536))
    expect(await crossesAt(hostDefault - 1)).toBe(false)
    expect(await crossesAt(hostDefault)).toBe(true)
  })
})
