import type { LlmClient, LlmCompletion, LlmCompletionRequest, SummaryRoute } from '../contracts.ts'

export type SummarizeErrorCode = 'empty-input' | 'llm-error' | 'aborted' | 'parse'

/**
 * Failure of one summarization or rollup job. `empty-input` is permanent (no
 * conversation content to summarize); `llm-error` and `parse` are worth a
 * later retry; `aborted` means the caller cancelled.
 */
export class SummarizeError extends Error {
  readonly code: SummarizeErrorCode

  constructor(code: SummarizeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SummarizeError'
    this.code = code
  }
}

/** Model route for summarizer calls; empty provider/model inherit the conversation route inside the `LlmClient`. */
export type SummarizerRoute = SummaryRoute

/** A fixed route, or a getter read once per job (for volatile config). */
export type RouteSource = SummarizerRoute | (() => SummarizerRoute)

export function resolveRoute(source: RouteSource): SummarizerRoute {
  return typeof source === 'function' ? source() : source
}

export type CompletionUsage = NonNullable<LlmCompletion['usage']>

export function addUsage(total: CompletionUsage | undefined, next: CompletionUsage | undefined): CompletionUsage | undefined {
  if (next === undefined) return total
  if (total === undefined) return next
  const cacheRead = (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0)
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...(total.cacheReadTokens !== undefined || next.cacheReadTokens !== undefined ? { cacheReadTokens: cacheRead } : {}),
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new SummarizeError('aborted', 'summarization aborted', { cause: signal.reason })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type CallRequest = Omit<LlmCompletionRequest, 'provider' | 'model' | 'purpose' | 'reasoningEffort' | 'sessionId'>

/** Runs the model calls of one job, accumulating usage and the route that answered. */
export class CallLedger {
  usage: CompletionUsage | undefined
  provider: string
  model: string
  readonly #llm: LlmClient
  readonly #route: SummarizerRoute
  readonly #purpose: string
  readonly #sessionId: string | undefined
  readonly #signal: AbortSignal | undefined

  constructor(llm: LlmClient, route: SummarizerRoute, purpose: string, sessionId: string | undefined, signal: AbortSignal | undefined) {
    this.#llm = llm
    this.#route = route
    this.#purpose = purpose
    this.#sessionId = sessionId
    this.#signal = signal
    this.provider = route.provider
    this.model = route.model
  }

  /** One call; `error`/`aborted` finishes and thrown client errors become {@link SummarizeError}. */
  async complete(request: CallRequest): Promise<LlmCompletion> {
    throwIfAborted(this.#signal)
    const effort = this.#route.reasoningEffort
    const full: LlmCompletionRequest = {
      ...request,
      provider: this.#route.provider,
      model: this.#route.model,
      purpose: this.#purpose,
      ...(effort !== undefined && effort.length > 0 ? { reasoningEffort: effort } : {}),
      ...(this.#sessionId !== undefined && this.#sessionId.length > 0 ? { sessionId: this.#sessionId } : {}),
    }
    let completion: LlmCompletion
    try {
      completion = await this.#llm.complete(full, this.#signal)
    } catch (error) {
      if (this.#signal?.aborted === true) throw new SummarizeError('aborted', 'summarization aborted', { cause: error })
      throw new SummarizeError('llm-error', `summarizer model call failed: ${message(error)}`, { cause: error })
    }
    this.usage = addUsage(this.usage, completion.usage)
    if (completion.provider.length > 0) this.provider = completion.provider
    if (completion.model.length > 0) this.model = completion.model
    if (completion.finish === 'aborted') throw new SummarizeError('aborted', completion.error ?? 'summarizer model call aborted')
    if (completion.finish === 'error') throw new SummarizeError('llm-error', `summarizer model call failed: ${completion.error ?? 'unknown error'}`)
    return completion
  }
}
