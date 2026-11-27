import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createAssistantMessage, createSystemMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { CreateSessionOptions, Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/src/estimate.ts'
import ToolsService from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Config } from '../../src/config.ts'
import type { CompactionMode, CompressionLevel, EpisodeSummaryResult } from '../../src/contracts.ts'
import { SUMMARIZE_PURPOSE } from '../../src/contracts.ts'
import { MemoryCompactionEngine } from '../../src/engine/engine.ts'
import { startMemoryCloud } from '../../src/runtime/runtime.ts'
import type { MemoryCloudRuntime } from '../../src/runtime/runtime.ts'

export const PROVIDER = 'fake'
export const MODEL = 'fake-1'
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

export type Reply = string | Error
export type Responder = (options: GenerateOptions, index: number) => Reply

/** Scripted provider registered on the real `LlmRuntime`; only `fake-1` resolves. */
export class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  constructor(private readonly responder: Responder, private readonly contextWindow: number, private readonly lookup?: Promise<unknown>) {
    super()
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.lookup
    if (model !== MODEL) throw new Error(`unknown model ${model}`)
    return { provider, id: model, name: model, context: { contextWindow: this.contextWindow }, defaultMaxTokens: 1024 }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.calls.length
    this.calls.push(options)
    const reply = this.responder(options, index)
    if (reply instanceof Error) throw reply
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  callsFor(purpose: string | undefined): GenerateOptions[] {
    return this.calls.filter(call => call.purpose === purpose)
  }
}

export function summaryReply(overrides: Partial<EpisodeSummaryResult> = {}): string {
  return JSON.stringify({
    gist: '用户和助手聊了周末去杭州看西湖的计划。',
    summary: '## 发生了什么\n用户说 2026-11-28 周六要和小林去杭州西湖，想吃楼外楼的醋鱼。\n## 约定\n助手答应周五提醒带伞。',
    ongoing: ['周五提醒用户带伞'],
    importance: 7,
    keywords: ['杭州', '西湖'],
    people: ['小林'],
    dates: [{ date: '2026-11-28', what: '去杭州西湖' }],
    promises: [{ what: '周五提醒带伞', who: '助手', due: '2026-11-27' }],
    ...overrides,
  })
}

/**
 * Token meter fake over the 4-chars/token heuristic of the real one; pressure
 * is set per session. A set `pressureTokens` stands for the provider usage of
 * a request made just now, so `measure()` reports it as its usage baseline.
 */
export function createMeter() {
  const pressure = new Map<string, { pressureTokens?: number; contextWindow?: number }>()
  const service = {
    measure(session: Session) {
      const nodes = session.surface.nodes.map((seq) => {
        const event = session.eventAt(seq)
        const message = event === undefined ? null : session.deriveEventMessage(event)
        const tokens = message === null ? 0 : estimateMessage(message)
        return { seq, tokens, heuristicTokens: tokens }
      })
      const total = nodes.reduce((sum, node) => sum + node.tokens, 0)
      const usage = pressure.get(session.id)?.pressureTokens
      const baseline = usage === undefined ? { kind: 'estimated', tokens: total } : { kind: 'usage', tokens: usage }
      return { logRevision: 0, baseline, surfaceDeltaTokens: 0, totalTokens: baseline.tokens, surfaceTokens: total, nodes }
    },
    estimateMessage(message: Message) {
      return estimateMessage(message)
    },
    contextPressure(session: Session) {
      return pressure.get(session.id) ?? {}
    },
  }
  return { service, pressure }
}

export interface HarnessOptions {
  /** `memory`: our engine owns host compaction; `basic`: stock compaction-basic; `none`: no compaction service. */
  readonly engine?: 'memory' | 'basic' | 'none'
  readonly mode?: CompactionMode
  readonly level?: CompressionLevel
  readonly contextWindow?: number
  readonly responder?: Responder
  readonly root?: string
  /** Idle consolidation quiet delay; defaults to 0 so tests do not wait. */
  readonly idleQuietMs?: number
  /** Model lookups (`resolveModelInfo`) wait for this before answering. */
  readonly modelLookup?: Promise<unknown>
}

export interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly config: Config
  readonly adapter: ScriptedAdapter
  readonly meter: ReturnType<typeof createMeter>
  readonly runtime: MemoryCloudRuntime
  readonly compaction?: BasicCompactionEngine
  conversation(id: string, meta?: CreateSessionOptions['meta']): Promise<Conversation>
  setVolatile(path: 'level' | 'compactionMode', value: unknown): void
  tool<T>(name: string, args: Record<string, unknown>, agent: Agent): Promise<T>
  command(agent: Agent, line: string): Promise<{ kind: string; text?: string }>
  preStep(agent: Agent, messages: readonly UserMessage[], turn?: number): Promise<PreStepDecision>
  /** Wait for capture writes and background jobs. */
  settle(): Promise<void>
  /** Unload the plugin and start it again on the same context, store and config, like an upgrade or a `storageRoot` edit. */
  reload(): Promise<void>
  dispose(): Promise<void>
}

export class Conversation {
  turn = 0

  constructor(readonly session: Session, readonly agent: Agent) {}

  route(): void {
    this.session.append('request/header', { reason: 'initial', header: { config: { provider: PROVIDER, model: MODEL, maxTokens: 1024 } } } as never)
    this.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('You are a warm companion.') }, { surfaceOp: 'append' })
  }

  exchange(user: string, assistant: string): void {
    this.turn += 1
    this.session.append('turn/start', { turn: this.turn })
    this.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    this.session.append('assistant/message', {
      turn: this.turn,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: assistant }], source: { provider: PROVIDER, model: MODEL } }),
      stream: [],
    } as never, { surfaceOp: 'append' })
    this.session.append('turn/end', { turn: this.turn, reason: { kind: 'completed' } })
  }

  /** Text of every visible user message with the given source kind. */
  visible(kind: string): string[] {
    const texts: string[] = []
    for (const seq of this.session.surface.nodes) {
      const event = this.session.eventAt(seq)
      if (event?.type !== 'user/message') continue
      const data = event.data as unknown as { readonly source?: { readonly kind?: string }; readonly content?: readonly { readonly type: string; readonly text?: string }[] }
      if (data.source?.kind !== kind) continue
      texts.push((data.content ?? []).map(block => block.text ?? '').join(''))
    }
    return texts
  }
}

export function longText(seed: string, chars: number): string {
  let text = ''
  for (let index = 0; text.length < chars; index++) text += `${seed}（第 ${index} 句）今天的天气不错，我们聊聊周末的安排和最近读的书。`
  return text
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'mcb-int-'))
  const contextWindow = options.contextWindow ?? 128 * 1024
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsService)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LlmRuntime)
  const responder: Responder = options.responder ?? ((call) => call.purpose === SUMMARIZE_PURPOSE ? summaryReply() : 'DSH default checkpoint summary.')
  const adapter = new ScriptedAdapter(responder, contextWindow, options.modelLookup)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const meter = createMeter()
  ctx.provide('tokenMeter', meter.service)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: PROVIDER, model: MODEL }) })
  const agents = new Map<string, Agent>()
  ctx.provide('agents', { get: (id: string) => agents.get(id), list: () => [...agents.values()] })

  const config = Config({ storageRoot: root, level: options.level ?? 3, compactionMode: options.mode ?? 'auto' })
  const setVolatile = (path: 'level' | 'compactionMode', value: unknown): void => {
    ;(config[path] as unknown as Record<symbol, (value: unknown) => void>)[VOLATILE_WRITE]?.(value)
    ctx.emit('loader/volatile-update', [[path]] as never)
  }
  ctx.provide('settings', {
    async update(_ns: string, patch: Record<string, unknown>) {
      for (const [key, value] of Object.entries(patch)) setVolatile(key as 'level' | 'compactionMode', value)
    },
  })

  let compaction: BasicCompactionEngine | undefined
  if (options.engine === 'memory' || options.engine === undefined) {
    await ctx.plugin(MemoryCompactionEngine, { auto: false, headroomTokens: 1024 })
    compaction = ctx.get('compaction') as BasicCompactionEngine
  } else if (options.engine === 'basic') {
    await ctx.plugin(BasicCompactionEngine, { auto: false })
    compaction = ctx.get('compaction') as BasicCompactionEngine
  }

  const start = async (): Promise<{ fiber: Fiber; runtime: MemoryCloudRuntime }> => {
    let runtime: MemoryCloudRuntime | undefined
    const fiber = await ctx.plugin({
      name: 'memory-cloud-under-test',
      inject: ['sessions', 'llm', 'tokenMeter', 'systemPrompt', 'tools', 'commands'],
      apply: (sub: Context) => {
        runtime = startMemoryCloud(sub, config, { idleQuietMs: options.idleQuietMs ?? 0 })
      },
    })
    if (runtime === undefined) throw new Error('runtime did not start')
    return { fiber, runtime }
  }
  let current = await start()

  const harness: Harness = {
    ctx,
    root,
    config,
    adapter,
    meter,
    get runtime() {
      return current.runtime
    },
    ...compaction === undefined ? {} : { compaction },
    async conversation(id, meta) {
      const session = ctx.sessions.create(SessionId(id), meta === undefined ? {} : { meta })
      const agent = {
        session,
        options: { provider: PROVIDER, model: MODEL },
        ctx,
        status: 'idle',
        runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
        whenIdle: async () => {},
      } as unknown as Agent
      agents.set(session.id, agent)
      await ctx.serial('agent/created', { agent, source: 'startup' })
      return new Conversation(session, agent)
    },
    setVolatile,
    async tool<T>(name: string, args: Record<string, unknown>, agent: Agent): Promise<T> {
      const definition = ctx.tools.definitions().find(item => item.name === name)
      if (definition === undefined) throw new Error(`tool ${name} is not registered`)
      return await definition.execute(args, { agent, signal: new AbortController().signal } as unknown as ToolRunContext) as T
    },
    async command(agent, line) {
      const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
      if (execution === undefined) throw new Error(`command ${line} did not resolve`)
      return execution.result
    },
    async preStep(agent, messages, turn = 1) {
      const signal = new AbortController().signal
      return ctx.waterfall('agent/pre-step', { agent, messages: [...messages], turn, step: 1, signal, modelSelection: { provider: PROVIDER, model: MODEL } } as never, async () => ({ kind: 'enter', messages: [...messages] }) as PreStepDecision) as Promise<PreStepDecision>
    },
    async settle() {
      const started = current.runtime
      await started.capture.flush()
      for (let round = 0; round < 5; round++) {
        await started.runner.drain(5000)
        await started.capture.settle()
      }
    },
    async reload() {
      await current.fiber.dispose()
      current = await start()
    },
    async dispose() {
      await current.fiber.dispose()
      if (options.root === undefined) await rm(root, { recursive: true, force: true })
    },
  }
  return harness
}

export function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
