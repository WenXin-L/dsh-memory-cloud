import { describe, expect, it } from 'vitest'
import type { GenerateOptions, LlmRequestPurpose, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { LlmCompletionRequest } from '../../src/contracts.ts'
import { SUMMARIZE_PURPOSE } from '../../src/contracts.ts'
import { createDshLlmClient } from '../../src/summarize/index.ts'
import type { DshLlmLike, DshReplay } from '../../src/summarize/index.ts'

const purpose: LlmRequestPurpose = 'memory-cloud-summarize'

const OK_STREAM: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 'REASONING' },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: '你好' },
  { type: 'text-delta', index: 1, text: '，世界' },
  { type: 'tool-call-delta', index: 2, id: 'call-1' as never, name: 'memory_save', argumentsDelta: '{"gist":' },
  { type: 'tool-call-delta', index: 2, id: 'call-1' as never, argumentsDelta: '"x"}' },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, reasoningTokens: 3 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

function fakeLlm(chunks: StreamChunk[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>), info?: Partial<LlmResolvedModelInfo> | Error) {
  const seen: GenerateOptions[] = []
  const llm: DshLlmLike = {
    stream(options) {
      seen.push(options)
      if (typeof chunks === 'function') return chunks(options)
      return (async function* () {
        yield* chunks
      })()
    },
    ...(info === undefined
      ? {}
      : {
        async resolveModelInfo(provider: string, model: string) {
          if (info instanceof Error) throw info
          return { provider, id: model, name: model, ...info }
        },
      }),
  }
  return { llm, seen }
}

function base(overrides: Partial<LlmCompletionRequest> = {}): LlmCompletionRequest {
  return {
    provider: 'deepseek',
    model: 'deepseek-flash',
    messages: [{ role: 'user', text: 'summarize please' }],
    maxTokens: 2048,
    purpose: SUMMARIZE_PURPOSE,
    ...overrides,
  }
}

function waitForAbort(options: GenerateOptions): AsyncIterable<StreamChunk> {
  return (async function* () {
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted === true) resolve()
      options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
  })()
}

describe('createDshLlmClient', () => {
  it('assembles text, tool calls, usage, and the finish kind', async () => {
    const { llm, seen } = fakeLlm(OK_STREAM)
    const completion = await createDshLlmClient({ llm }).complete(base({
      system: 'SYSTEM',
      tools: [{ name: 'memory_save', description: 'save', parameters: { type: 'object' } }],
    }))
    expect(completion).toEqual({
      text: '你好，世界',
      toolCalls: [{ name: 'memory_save', arguments: '{"gist":"x"}' }],
      finish: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90 },
      provider: 'deepseek',
      model: 'deepseek-flash',
    })
    const options = seen[0] as GenerateOptions
    expect(options).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash', system: 'SYSTEM', maxTokens: 2048, purpose })
    expect(options.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'summarize please' }] }])
    expect(options.tools).toEqual([{ name: 'memory_save', description: 'save', parameters: { type: 'object' } }])
    expect(options.sessionId).toBeUndefined()
    expect(options.reasoningEffort).toBeUndefined()
    expect(options.toolHistory).toBeUndefined()
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('passes replay messages, tools, and toolHistory through ahead of the request', async () => {
    const { llm, seen } = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }])
    const replayMessages = [{ id: 'sys', role: 'system', content: [], source: { kind: 'system-prompt' } }, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }]
    const replayTools = [{ name: 'fs_read', description: 'read', parameters: {} }]
    const toolHistory = { tools: replayTools, updates: [] }
    const replay: DshReplay = { messages: replayMessages, tools: replayTools, toolHistory }
    await createDshLlmClient({ llm }).complete(base({
      replay,
      messages: [{ role: 'user', text: 'instruction' }, { role: 'assistant', text: 'previous answer' }, { role: 'user', text: 'retry' }],
      sessionId: 'session-1',
    }))
    const options = seen[0] as GenerateOptions
    expect(options.messages.slice(0, 2)).toEqual(replayMessages)
    expect(options.messages[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'instruction' }] })
    expect(options.messages[3]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'previous answer' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } })
    expect(options.messages[4]).toEqual({ role: 'user', content: [{ type: 'text', text: 'retry' }] })
    expect(options.tools).toEqual(replayTools)
    expect(options.toolHistory).toBe(toolHistory)
    expect(options.system).toBeUndefined()
    expect(options.sessionId).toBe('session-1')
  })

  it('fills an empty route from defaultRoute and reports a missing route as an error', async () => {
    const { llm, seen } = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }])
    const client = createDshLlmClient({ llm }, { defaultRoute: () => ({ provider: 'deepseek', model: 'deepseek-pro' }) })
    const completion = await client.complete(base({ provider: '', model: 'deepseek-flash' }))
    expect(seen[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash' })
    expect(completion.provider).toBe('deepseek')
    await client.complete(base({ provider: '', model: '' }))
    expect(seen[1]).toMatchObject({ provider: 'deepseek', model: 'deepseek-pro' })

    const bare = await createDshLlmClient({ llm }).complete(base({ provider: '' }))
    expect(bare.finish).toBe('error')
    expect(bare.error).toMatch(/生成摘要需要提供方和模型。.*Summarization requires a provider and a model\./)
    const throwing = await createDshLlmClient({ llm }, { defaultRoute: () => { throw new Error('no service') } }).complete(base({ model: '' }))
    expect(throwing.finish).toBe('error')
    expect(seen).toHaveLength(2)
  })

  it('maps error, max-tokens, unknown finishes, and thrown streams', async () => {
    const failure = { code: 'RATE_LIMITED', message: 'slow down' }
    const error = await createDshLlmClient(fakeLlm([{ type: 'finish', reason: { kind: 'error', failure } }])).complete(base())
    expect(error).toMatchObject({ finish: 'error', error: 'RATE_LIMITED: slow down' })

    const truncated = await createDshLlmClient(fakeLlm([
      { type: 'text-delta', index: 0, text: '{"gist": "半' },
      { type: 'tool-call-delta', index: 1, id: 'c' as never, name: 'memory_save', argumentsDelta: '{' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])).complete(base())
    expect(truncated).toMatchObject({ finish: 'max-tokens', text: '{"gist": "半', toolCalls: [] })

    const unknown = await createDshLlmClient(fakeLlm([{ type: 'finish', reason: { kind: 'content-filter' } as never }])).complete(base())
    expect(unknown.finish).toBe('error')
    expect(unknown.error).toBe('模型返回了未知的结束原因 / Unexpected model finish reason "content-filter"')

    const thrown = await createDshLlmClient(fakeLlm(() => (async function* (): AsyncIterable<StreamChunk> {
      throw new Error('middleware exploded')
    })())).complete(base())
    expect(thrown).toMatchObject({ finish: 'error', error: 'middleware exploded', text: '', toolCalls: [] })
  })

  it('turns the timeout into an error completion', async () => {
    const { llm } = fakeLlm(waitForAbort)
    const completion = await createDshLlmClient({ llm }, { timeoutMs: 20 }).complete(base())
    expect(completion.finish).toBe('error')
    expect(completion.error).toBe('摘要请求超时 / Summary request timed out after 20 ms')
  })

  it('forwards caller cancellation as an aborted completion', async () => {
    const { llm, seen } = fakeLlm(waitForAbort)
    const controller = new AbortController()
    const pending = createDshLlmClient({ llm }, { timeoutMs: 0 }).complete(base(), controller.signal)
    setTimeout(() => controller.abort(), 10)
    const completion = await pending
    expect(completion.finish).toBe('aborted')
    expect(seen[0]?.signal?.aborted).toBe(true)

    const early = new AbortController()
    early.abort()
    const before = await createDshLlmClient({ llm }).complete(base(), early.signal)
    expect(before).toMatchObject({ finish: 'aborted', error: '摘要请求在发出前已取消。 / The summary request was canceled before it started.' })
    expect(seen).toHaveLength(1)
  })

  it('drops reasoning efforts the resolved model does not support', async () => {
    const supported = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }], { reasoning: { efforts: [{ id: 'high' as never, name: 'High' }] } })
    const client = createDshLlmClient(supported)
    await client.complete(base({ reasoningEffort: 'high' }))
    await client.complete(base({ reasoningEffort: 'off' }))
    expect(supported.seen.map(options => options.reasoningEffort)).toEqual(['high', undefined])

    const none = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }], {})
    await createDshLlmClient(none).complete(base({ reasoningEffort: 'off' }))
    expect(none.seen[0]?.reasoningEffort).toBeUndefined()

    const failing = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }], new Error('lookup failed'))
    await createDshLlmClient(failing).complete(base({ reasoningEffort: 'off' }))
    expect(failing.seen[0]?.reasoningEffort).toBe('off')

    const unchecked = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }], {})
    await createDshLlmClient(unchecked, { validateReasoningEffort: false }).complete(base({ reasoningEffort: 'off' }))
    expect(unchecked.seen[0]?.reasoningEffort).toBe('off')
  })
})
