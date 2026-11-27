import { BlockAssembler, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmRequestPurpose,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  RequestMessage,
  StreamChunk,
  TokenUsage,
  ToolHistory,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { LlmClient, LlmCompletion, LlmCompletionRequest, LlmFinish } from '../contracts.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'memory-cloud-summarize': true
  }
}

/** The part of `ctx.llm` (`LlmRuntime`) the adapter uses. */
export interface DshLlmLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

export interface DshRoute {
  readonly provider: string
  readonly model: string
}

export interface DshLlmClientOptions {
  /** Per-call deadline; 0 disables it (default 180 000 ms). A timeout finishes as `error`. */
  readonly timeoutMs?: number
  /**
   * Route filling an empty request provider/model, e.g.
   * `() => ctx.agentDefaultModel.currentSelection()` or the agent's routed request header.
   */
  readonly defaultRoute?: () => DshRoute | undefined
  /**
   * Drop a `reasoningEffort` the resolved model does not list (default true),
   * instead of letting DSH fail the call with `UNSUPPORTED_REASONING_EFFORT`.
   */
  readonly validateReasoningEffort?: boolean
}

/** Engine-mode replay as handed over by the compaction seam, including the optional `toolHistory`. */
export type DshReplay = NonNullable<LlmCompletionRequest['replay']>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mapFinish(reason: FinishReason): { finish: LlmFinish; error?: string } {
  switch (reason.kind) {
    case 'stop':
    case 'tool-calls':
    case 'max-tokens':
      return { finish: reason.kind }
    case 'error':
    case 'aborted':
      return { finish: reason.kind, error: `${reason.failure.code}: ${reason.failure.message}` }
    default:
      return { finish: 'error', error: `模型返回了未知的结束原因 / Unexpected model finish reason "${String((reason as { kind: unknown }).kind)}"` }
  }
}

function mapUsage(usage: TokenUsage): NonNullable<LlmCompletion['usage']> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
  }
}

function textBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/**
 * `LlmClient` over `ctx.llm.stream()` + `BlockAssembler`. Replay messages and
 * tools go first, request tools are appended, text messages follow as
 * request-only user inputs (assistant turns become model-attributed
 * messages). Reasoning blocks are dropped from `text`; adapter failures,
 * thrown stream errors, cancellation, and the timeout resolve to `error` or
 * `aborted` completions instead of rejecting.
 */
export function createDshLlmClient(ctx: { readonly llm: DshLlmLike }, options: DshLlmClientOptions = {}): LlmClient {
  const timeoutMs = options.timeoutMs ?? 180_000
  const timeoutMessage = `摘要请求超时 / Summary request timed out after ${timeoutMs} ms`

  const effortFor = async (provider: string, model: string, effort: string | undefined, signal: AbortSignal): Promise<ReasoningEffortId | undefined> => {
    if (effort === undefined || effort.length === 0) return undefined
    const id = effort as ReasoningEffortId
    if (options.validateReasoningEffort === false || ctx.llm.resolveModelInfo === undefined) return id
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model, signal)
      if (info.reasoning === undefined) return undefined
      return info.reasoning.efforts.some(item => item.id === effort) ? id : undefined
    } catch {
      return id
    }
  }

  return {
    async complete(request, signal) {
      let fallback: DshRoute | undefined
      try {
        fallback = request.provider.length > 0 && request.model.length > 0 ? undefined : options.defaultRoute?.()
      } catch {}
      const provider = request.provider.length > 0 ? request.provider : fallback?.provider ?? ''
      const model = request.model.length > 0 ? request.model : fallback?.model ?? ''
      const failed = (finish: 'error' | 'aborted', error: string): LlmCompletion => ({ text: '', toolCalls: [], finish, error, provider, model })
      if (provider.length === 0 || model.length === 0) return failed('error', '生成摘要需要提供方和模型。请检查模型设置。 / Summarization requires a provider and a model. Check the model settings.')
      if (signal?.aborted === true) return failed('aborted', '摘要请求在发出前已取消。 / The summary request was canceled before it started.')

      const controller = new AbortController()
      const onAbort = (): void => controller.abort(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      let timedOut = false
      const timer = timeoutMs > 0 && Number.isFinite(timeoutMs)
        ? setTimeout(() => {
          timedOut = true
          controller.abort(new Error(timeoutMessage))
        }, timeoutMs)
        : undefined
      try {
        const replay = request.replay
        const tools = [...(replay?.tools ?? []) as ToolSchema[], ...(request.tools ?? []).map(tool => ({ ...tool }))]
        const messages: RequestMessage[] = [
          ...(replay?.messages ?? []) as RequestMessage[],
          ...request.messages.map((message): RequestMessage => message.role === 'user'
            ? { role: 'user', content: [{ type: 'text', text: message.text }] }
            : createAssistantMessage({ content: [{ type: 'text', text: message.text }], source: { provider, model } })),
        ]
        const reasoningEffort = await effortFor(provider, model, request.reasoningEffort, controller.signal)
        const generate: GenerateOptions = {
          provider,
          model,
          messages,
          ...(request.system === undefined ? {} : { system: request.system }),
          ...(tools.length === 0 ? {} : { tools }),
          ...(replay?.toolHistory === undefined ? {} : { toolHistory: replay.toolHistory as ToolHistory }),
          maxTokens: request.maxTokens,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          purpose: request.purpose as LlmRequestPurpose,
          ...(request.sessionId === undefined || request.sessionId.length === 0
            ? {}
            : { sessionId: request.sessionId as NonNullable<GenerateOptions['sessionId']> }),
          signal: controller.signal,
        }
        const assembler = new BlockAssembler()
        for await (const chunk of ctx.llm.stream(generate)) assembler.push(chunk)
        const mapped = mapFinish(assembler.finish)
        const blocks = assembler.blocks()
        const timeoutError = timedOut ? { finish: 'error' as const, error: timeoutMessage } : undefined
        const outcome = mapped.finish === 'aborted' && timeoutError !== undefined ? timeoutError : mapped
        return {
          text: textBlocks(blocks),
          toolCalls: blocks.flatMap(block => (block.type === 'tool-call' ? [{ name: block.name, arguments: block.arguments }] : [])),
          finish: outcome.finish,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
          ...(assembler.usage === undefined ? {} : { usage: mapUsage(assembler.usage) }),
          provider,
          model,
        }
      } catch (error) {
        if (timedOut) return failed('error', timeoutMessage)
        return failed(controller.signal.aborted ? 'aborted' : 'error', errorText(error))
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
