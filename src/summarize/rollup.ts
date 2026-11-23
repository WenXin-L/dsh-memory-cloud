import type { Clock, LlmClient, LlmCompletion, Millis, RollupPeriod, SummaryProvenance, TokenEstimator } from '../contracts.ts'
import { SUMMARIZE_PURPOSE } from '../contracts.ts'
import { CallLedger, SummarizeError, resolveRoute, throwIfAborted } from './llm-call.ts'
import type { CallRequest, RouteSource, SummarizerRoute } from './llm-call.ts'
import { extractJsonObject } from './parse.ts'
import {
  ROLLUP_PROMPT_VERSION,
  ROLLUP_SYSTEM_PROMPT,
  renderRollupItems,
  rollupRetryInstruction,
  rollupUserPrompt,
} from './prompt.ts'
import type { RollupRetryIssue } from './prompt.ts'
import { completeSentences, resolveTimeZone, stripThink, tidyBlock, truncateToTokens } from './text.ts'

export interface RollupItem {
  /** When the entry happened (episode start), shown as a date. */
  readonly at?: Millis
  /** One episode gist or summary, or an earlier rollup text. */
  readonly text: string
}

export interface RollupRequest {
  readonly period: RollupPeriod
  /** Entries in chronological order. */
  readonly items: readonly RollupItem[]
  readonly targetTokens: number
  readonly timeZone?: string
  /** Per-call route override. */
  readonly route?: SummarizerRoute
}

export interface RollupOutcome {
  readonly text: string
  /** Estimated tokens of `text`. */
  readonly tokens: number
  readonly provenance: SummaryProvenance
  readonly usage?: LlmCompletion['usage']
}

export interface RollupSummarizer {
  rollup(request: RollupRequest, signal?: AbortSignal): Promise<RollupOutcome>
}

export interface RollupSummarizerOptions {
  readonly llm: LlmClient
  readonly estimator: TokenEstimator
  readonly clock: Clock
  readonly route: RouteSource
  /** Defaults to {@link ROLLUP_PROMPT_VERSION}. */
  readonly promptVersion?: string
  /** Rendered-entries estimate above which entries are rolled up in batches first (default 24 576). */
  readonly maxInputTokens?: number
  /** Upper bound for one call's `maxTokens` (default 4096). */
  readonly maxOutputTokens?: number
  readonly purpose?: string
  readonly timeZone?: string
}

/** Strip a leading reasoning block, fences, JSON wrappers, and a leading label from a plain-text answer. */
export function cleanRollupText(raw: string): string {
  let text = stripThink(raw)
  const fenced = /^```[A-Za-z]*[ \t]*\n([\s\S]*?)\n?```$/.exec(text.trim())
  if (fenced?.[1] !== undefined) text = fenced[1]
  if (text.trim().startsWith('{')) {
    const object = extractJsonObject(text)
    const value = object === undefined
      ? undefined
      : ['text', 'rollup', 'summary', 'gist', '总结', '时期总结'].map(key => object[key]).find(item => typeof item === 'string')
    if (typeof value === 'string') text = value
  }
  return tidyBlock(text.replace(/^\s*(?:时期总结|总结|summary|rollup)\s*[:：]\s*/i, ''))
}

/**
 * Merge many gists or summaries of one week/month/year into a single period
 * gist under `targetTokens`. One retry covers empty, cut-off (`max-tokens`),
 * or over-length output; a complete answer is preferred, a cut-off one is
 * kept only up to its last sentence end, and remaining overflow is cut at a
 * sentence boundary. Entry lists above the input cap are rolled up in batches
 * first.
 */
export function createRollupSummarizer(options: RollupSummarizerOptions): RollupSummarizer {
  const { llm, estimator, clock } = options
  const promptVersion = options.promptVersion ?? ROLLUP_PROMPT_VERSION
  const maxInputTokens = Math.max(512, options.maxInputTokens ?? 24_576)
  const maxOutputTokens = Math.max(256, options.maxOutputTokens ?? 4096)
  const purpose = options.purpose ?? SUMMARIZE_PURPOSE

  return {
    async rollup(request, signal) {
      throwIfAborted(signal)
      const items = request.items.filter(item => item.text.trim().length > 0)
      if (items.length === 0) throw new SummarizeError('empty-input', `rollup ${request.period.key} has no entries`)
      const route = request.route ?? resolveRoute(options.route)
      const ledger = new CallLedger(llm, route, purpose, undefined, signal)
      const timeZone = resolveTimeZone(request.timeZone ?? options.timeZone)
      const target = request.targetTokens
      const outputTokens = Math.min(maxOutputTokens, Math.max(512, target * 3 + 1024))

      const once = async (group: readonly RollupItem[]): Promise<string> => {
        const messages: CallRequest['messages'] = [{ role: 'user', text: rollupUserPrompt(request.period, group, target, estimator, timeZone) }]
        const call = async (list: CallRequest['messages']): Promise<{ readonly text: string; readonly cut: boolean }> => {
          const completion = await ledger.complete({ system: ROLLUP_SYSTEM_PROMPT, messages: list, maxTokens: outputTokens })
          return { text: cleanRollupText(completion.text), cut: completion.finish === 'max-tokens' }
        }
        const first = await call(messages)
        const firstTokens = estimator.estimate(first.text)
        if (first.text.length > 0 && !first.cut && firstTokens <= target) return first.text
        const issue: RollupRetryIssue = first.text.length === 0
          ? { kind: 'empty' }
          : first.cut ? { kind: 'truncated' } : { kind: 'too-long', tokens: firstTokens }
        const answers = [first]
        try {
          answers.unshift(await call([
            ...messages,
            { role: 'assistant', text: first.text.length > 0 ? first.text : '(empty)' },
            { role: 'user', text: rollupRetryInstruction(issue, target, estimator) },
          ]))
        } catch (error) {
          if (first.text.length === 0 || (error instanceof SummarizeError && error.code === 'aborted')) throw error
        }
        const usable = answers.filter(answer => answer.text.length > 0)
        const candidate = usable.find(answer => !answer.cut)?.text
          ?? usable.map(answer => completeSentences(answer.text)).find(text => text.length > 0)
          ?? ''
        const fitted = truncateToTokens(candidate, target, estimator)
        if (fitted.length === 0) {
          throw new SummarizeError('parse', usable.length === 0
            ? `rollup ${request.period.key} produced no usable text`
            : `rollup ${request.period.key} was cut off by the output limit before a complete sentence`)
        }
        return fitted
      }

      const batches = (group: readonly RollupItem[]): RollupItem[][] => {
        const out: RollupItem[][] = []
        let current: RollupItem[] = []
        let tokens = 0
        for (const item of group) {
          const cost = estimator.estimate(renderRollupItems([item], timeZone)) + 1
          if (current.length >= 2 && tokens + cost > maxInputTokens) {
            out.push(current)
            current = []
            tokens = 0
          }
          current.push(item)
          tokens += cost
        }
        const last = out.at(-1)
        if (current.length === 1 && last !== undefined) last.push(...current)
        else if (current.length > 0) out.push(current)
        return out
      }

      let level: readonly RollupItem[] = items
      for (let groups = batches(level); groups.length > 1; groups = batches(level)) {
        const next: RollupItem[] = []
        for (const group of groups) {
          const at = group[0]?.at
          next.push({ ...(at === undefined ? {} : { at }), text: await once(group) })
        }
        level = next
      }
      const text = await once(level)
      return {
        text,
        tokens: estimator.estimate(text),
        provenance: { provider: ledger.provider, model: ledger.model, promptVersion, summarizedAt: clock.now() },
        ...(ledger.usage === undefined ? {} : { usage: ledger.usage }),
      }
    },
  }
}
