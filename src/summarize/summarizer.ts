import type {
  Clock,
  EpisodeSummaryResult,
  LlmClient,
  LlmCompletion,
  SummarizeOutcome,
  SummarizeRequest,
  Summarizer,
  TokenEstimator,
} from '../contracts.ts'
import { SUMMARIZE_PURPOSE } from '../contracts.ts'
import { CallLedger, SummarizeError, resolveRoute, throwIfAborted } from './llm-call.ts'
import type { CallRequest, RouteSource } from './llm-call.ts'
import { LIST_LIMITS, answerText, dedupeBy, parseSummaryOutput } from './parse.ts'
import {
  EPISODE_SYSTEM_PROMPT,
  MEMORY_SAVE_TOOL,
  SUMMARY_PROMPT_VERSION,
  episodeUserPrompt,
  mergeUserPrompt,
  renderPart,
  replayInstruction,
  retryInstruction,
} from './prompt.ts'
import type { OutputMode, PartInfo, PromptContext, RetryIssue } from './prompt.ts'
import { oneLine, resolveTimeZone, truncateToTokens } from './text.ts'
import { chunkTranscript } from './transcript.ts'

export interface SummarizerOptions {
  readonly llm: LlmClient
  readonly estimator: TokenEstimator
  readonly clock: Clock
  /** Background summary route (config `summarizer.*`); a getter is read once per job. */
  readonly route: RouteSource
  /** Recorded in provenance; defaults to {@link SUMMARY_PROMPT_VERSION}. */
  readonly promptVersion?: string
  /** Transcript estimate above which a job is map-reduced over record-boundary chunks (default 24 576). */
  readonly maxInputTokens?: number
  /** Upper bound for one call's `maxTokens` (default 8192). */
  readonly maxOutputTokens?: number
  /** Send `episode.sessionId` with each call (default false, so session-log upload plugins see nothing). */
  readonly includeSessionId?: boolean
  /** Defaults to {@link SUMMARIZE_PURPOSE}. */
  readonly purpose?: string
  /** Used when a request carries no `timeZone`; defaults to the host zone. */
  readonly timeZone?: string
}

/** {@link SummarizeRequest}, whose optional `route` overrides the configured route for one call. */
export type EpisodeSummarizeRequest = SummarizeRequest

export type EpisodeSummarizer = Summarizer

interface CallSpec {
  readonly system?: string
  readonly messages: CallRequest['messages']
  readonly mode: OutputMode
  readonly replay?: SummarizeRequest['replay']
}

type Assessment =
  | { readonly ok: EpisodeSummaryResult }
  | { readonly issue: RetryIssue; readonly parsed?: EpisodeSummaryResult }

/**
 * Companion-oriented episode summarizer. Transcript mode sends a byte-stable
 * system prompt plus the transcript and reads the `memory_save` tool call;
 * engine mode (`request.replay`) replays the conversation and appends the
 * instruction as the final user message, asking for JSON in text so the
 * replayed tool list stays identical. One stricter retry covers unparseable,
 * truncated, or over-length output; remaining overflow is cut at a sentence
 * boundary. Long transcripts are summarized per chunk and merged.
 */
export function createSummarizer(options: SummarizerOptions): EpisodeSummarizer {
  const { llm, estimator, clock } = options
  const promptVersion = options.promptVersion ?? SUMMARY_PROMPT_VERSION
  const maxInputTokens = Math.max(512, options.maxInputTokens ?? 24_576)
  const maxOutputTokens = Math.max(512, options.maxOutputTokens ?? 8192)
  const purpose = options.purpose ?? SUMMARIZE_PURPOSE

  return {
    async summarize(request, signal) {
      throwIfAborted(signal)
      const route = request.route ?? resolveRoute(options.route)
      const sessionId = options.includeSessionId === true ? request.episode.sessionId : undefined
      const ledger = new CallLedger(llm, route, purpose, sessionId, signal)
      const { targets } = request
      const ctx: PromptContext = {
        now: request.now,
        timeZone: resolveTimeZone(request.timeZone ?? options.timeZone),
        targets,
        estimator,
        episode: {
          startedAt: request.episode.startedAt,
          ...(request.episode.endedAt === undefined ? {} : { endedAt: request.episode.endedAt }),
        },
      }
      const outputTokens = Math.min(maxOutputTokens, Math.max(1024, (targets.gistTokens + targets.summaryTokens) * 3 + 2048))

      const assess = (completion: LlmCompletion): Assessment => {
        const parsed = parseSummaryOutput(completion)?.result
        const withParsed = parsed === undefined ? {} : { parsed }
        if (completion.finish === 'max-tokens') return { issue: { kind: 'truncated' }, ...withParsed }
        if (parsed === undefined) return { issue: { kind: 'format' } }
        const gistTokens = estimator.estimate(parsed.gist)
        const summaryTokens = estimator.estimate(parsed.summary)
        if (gistTokens > targets.gistTokens || summaryTokens > targets.summaryTokens) {
          return { issue: { kind: 'too-long', gistTokens, summaryTokens }, parsed }
        }
        return { ok: parsed }
      }

      const fit = (result: EpisodeSummaryResult): EpisodeSummaryResult => {
        const gist = truncateToTokens(oneLine(result.gist), targets.gistTokens, estimator)
        const summary = truncateToTokens(result.summary, targets.summaryTokens, estimator)
        if (gist.length === 0 || summary.length === 0) {
          throw new SummarizeError('parse', `一行总结或摘要的 token 上限太低，未能保留正文。 / The token limit is too small to retain the gist or summary (gist ${targets.gistTokens}, summary ${targets.summaryTokens}).`)
        }
        return { ...result, gist, summary }
      }

      const structured = async (spec: CallSpec): Promise<EpisodeSummaryResult> => {
        const call = (messages: CallRequest['messages']): Promise<LlmCompletion> => ledger.complete({
          ...(spec.system === undefined ? {} : { system: spec.system }),
          messages,
          ...(spec.mode === 'tool' ? { tools: [MEMORY_SAVE_TOOL] } : {}),
          ...(spec.replay === undefined ? {} : { replay: spec.replay }),
          maxTokens: outputTokens,
        })
        const first = await call(spec.messages)
        const firstAssessment = assess(first)
        if ('ok' in firstAssessment) return firstAssessment.ok
        let retried: EpisodeSummaryResult | undefined
        try {
          const second = await call([
            ...spec.messages,
            { role: 'assistant', text: answerText(first) },
            { role: 'user', text: retryInstruction(firstAssessment.issue, ctx, spec.mode) },
          ])
          const secondAssessment = assess(second)
          retried = 'ok' in secondAssessment ? secondAssessment.ok : secondAssessment.parsed
        } catch (error) {
          if (firstAssessment.parsed === undefined || (error instanceof SummarizeError && error.code === 'aborted')) throw error
        }
        const candidate = retried ?? firstAssessment.parsed
        if (candidate === undefined) throw new SummarizeError('parse', '已重试一次，仍未能解析出一行总结和摘要。 / Could not parse the gist and summary after one retry.')
        return fit(candidate)
      }

      const episodeSpec = (transcript: string, part?: PartInfo): CallSpec => ({
        system: EPISODE_SYSTEM_PROMPT,
        messages: [{ role: 'user', text: episodeUserPrompt(ctx, transcript, part) }],
        mode: 'tool',
      })

      const merge = async (parts: readonly EpisodeSummaryResult[]): Promise<EpisodeSummaryResult> => {
        const merged = await structured({
          system: EPISODE_SYSTEM_PROMPT,
          messages: [{ role: 'user', text: mergeUserPrompt(ctx, parts) }],
          mode: 'tool',
        })
        return backfill(merged, parts)
      }

      const batch = (parts: readonly EpisodeSummaryResult[]): EpisodeSummaryResult[][] => {
        const batches: EpisodeSummaryResult[][] = []
        let current: EpisodeSummaryResult[] = []
        let tokens = 0
        for (const part of parts) {
          const cost = estimator.estimate(renderPart(part, 0, parts.length)) + 2
          if (current.length >= 2 && tokens + cost > maxInputTokens) {
            batches.push(current)
            current = []
            tokens = 0
          }
          current.push(part)
          tokens += cost
        }
        const last = batches.at(-1)
        if (current.length === 1 && last !== undefined) last.push(...current)
        else if (current.length > 0) batches.push(current)
        return batches
      }

      const reduce = async (parts: readonly EpisodeSummaryResult[]): Promise<EpisodeSummaryResult> => {
        let level = parts
        while (level.length > 1) {
          const batches = batch(level)
          if (batches.length === 1) return merge(level)
          const next: EpisodeSummaryResult[] = []
          for (const group of batches) next.push(await merge(group))
          level = next
        }
        const only = level[0]
        if (only === undefined) throw new SummarizeError('empty-input', 'nothing to merge')
        return only
      }

      const finish = (result: EpisodeSummaryResult): SummarizeOutcome => ({
        result,
        provenance: { provider: ledger.provider, model: ledger.model, promptVersion, summarizedAt: clock.now() },
        ...(ledger.usage === undefined ? {} : { usage: ledger.usage }),
      })

      if (request.replay !== undefined) {
        return finish(await structured({
          messages: [{ role: 'user', text: replayInstruction(ctx) }],
          mode: 'json',
          replay: request.replay,
        }))
      }

      const transcript = request.transcript.trim()
      if (transcript.length === 0) {
        throw new SummarizeError('empty-input', `片段中没有可供总结的对话。 / Episode ${request.episode.id} has no conversation to summarize.`)
      }
      const chunks = estimator.estimate(transcript) <= maxInputTokens
        ? [transcript]
        : chunkTranscript(transcript, maxInputTokens, estimator)
      if (chunks.length <= 1) return finish(await structured(episodeSpec(chunks[0] ?? transcript)))

      const partials: EpisodeSummaryResult[] = []
      for (const [index, chunk] of chunks.entries()) {
        const previousGist = partials.at(-1)?.gist
        partials.push(await structured(episodeSpec(chunk, {
          index,
          count: chunks.length,
          ...(previousGist === undefined ? {} : { previousGist }),
        })))
      }
      return finish(await reduce(partials))
    },
  }
}

function backfill(merged: EpisodeSummaryResult, parts: readonly EpisodeSummaryResult[]): EpisodeSummaryResult {
  const lower = (item: string): string => item.toLowerCase()
  return {
    ...merged,
    importance: Math.max(merged.importance, ...parts.map(part => part.importance)),
    keywords: dedupeBy([...merged.keywords, ...parts.flatMap(part => part.keywords)], lower).slice(0, LIST_LIMITS.keywords),
    people: dedupeBy([...merged.people, ...parts.flatMap(part => part.people)], lower).slice(0, LIST_LIMITS.people),
    ongoing: merged.ongoing.length > 0 ? merged.ongoing : parts.at(-1)?.ongoing ?? [],
    dates: merged.dates.length > 0
      ? merged.dates
      : dedupeBy(parts.flatMap(part => part.dates), fact => `${fact.date}|${fact.what}`).slice(0, LIST_LIMITS.dates),
    promises: merged.promises.length > 0
      ? merged.promises
      : dedupeBy(parts.flatMap(part => part.promises), promise => promise.what).slice(0, LIST_LIMITS.promises),
  }
}
