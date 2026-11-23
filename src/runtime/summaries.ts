import type {
  Clock,
  EpisodeId,
  EpisodeMeta,
  EpisodeSummaryResult,
  LlmClient,
  MemoryIndex,
  RawEventRecord,
  ResolvedBudget,
  RollupEntry,
  RollupPeriod,
  ScopeId,
  SummarizeOutcome,
  SummaryRoute,
  TokenEstimator,
} from '../contracts.ts'
import type { FileMemoryStore } from '../store/index.ts'
import { appendLog } from '../store/index.ts'
import { createRollupSummarizer, createSummarizer, renderTranscript, resolveTimeZone, SummarizeError } from '../summarize/index.ts'
import type { EpisodeSummarizer, RollupSummarizer } from '../summarize/index.ts'
import { JobDeferredError, parentPeriod, planRollups, rollupMembers } from '../summarize/jobs/index.ts'
import type { RollupPlan } from '../summarize/jobs/index.ts'
import { errorMessage } from './host.ts'
import { EMPTY_EPISODE_ERROR } from './sources.ts'

/** Episodes that ended within this many days stay out of rollups. */
export const KEEP_RECENT_DAYS = 7

const RAW_PAGE_SIZE = 500
const SUMMARIZER_LOG = 'summarizer'

export interface SummaryLogger {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

export interface SummaryServiceDeps {
  readonly store: FileMemoryStore
  readonly llm: LlmClient
  readonly estimator: TokenEstimator
  readonly clock: Clock
  readonly logger: SummaryLogger
  /** Route for background jobs, read per job (volatile config + default-model fallback). */
  readonly backgroundRoute: () => Promise<SummaryRoute>
  /** Budget of the active level for work without an agent. */
  readonly levelBudget: () => Promise<ResolvedBudget>
  /** Attempts after which the job runner stops retrying; empty episodes are marked with it. */
  readonly maxAttempts: number
  /**
   * False while the host's model services are unavailable (DSH shutting down,
   * plugin unloading). Jobs then defer instead of failing, so a shutdown does
   * not burn retry attempts. Defaults to always ready.
   */
  readonly hostReady?: () => boolean
  /** IANA zone of transcripts and of summary and rollup prompts; defaults to the host zone. */
  readonly timeZone?: string
}

export interface SummaryService {
  readonly summarizer: EpisodeSummarizer
  readonly rollups: RollupSummarizer
  /** The job runner's `summarizeEpisode`: a no-op for missing, open, or summarized episodes. */
  summarizeEpisode(scope: ScopeId, episode: EpisodeId, signal: AbortSignal): Promise<void>
  /** The job runner's `buildRollup`: a no-op when the period has no members or already has a rollup. */
  buildRollup(scope: ScopeId, period: RollupPeriod, signal: AbortSignal): Promise<void>
  /** Periods to roll up so the distant tier fits `distantQuotaTokens`. */
  planRollups(index: MemoryIndex, distantQuotaTokens: number, gistTokens: number): readonly RollupPlan[]
  /** Store an already computed summary (engine-mode composition) for a sealed episode. */
  writeOutcome(scope: ScopeId, episode: EpisodeId, outcome: SummarizeOutcome, kind: 'checkpoint' | 'episode'): Promise<EpisodeMeta>
  log(record: Record<string, unknown>): Promise<void>
}

export function createSummaryService(deps: SummaryServiceDeps): SummaryService {
  const { store, estimator, clock, logger } = deps
  const timeZone = resolveTimeZone(deps.timeZone)
  const summarizer = createSummarizer({ llm: deps.llm, estimator, clock, route: () => ({ provider: '', model: '' }), timeZone })
  const rollups = createRollupSummarizer({ llm: deps.llm, estimator, clock, route: () => ({ provider: '', model: '' }), timeZone })

  const log = async (record: Record<string, unknown>): Promise<void> => {
    try {
      await appendLog(store.root, SUMMARIZER_LOG, { at: clock.now(), ...record })
    } catch (error) {
      logger.warn('could not append to logs/%s.jsonl: %s', SUMMARIZER_LOG, errorMessage(error))
    }
  }

  const readAllRaw = async (scope: ScopeId, id: EpisodeId): Promise<RawEventRecord[]> => {
    const records: RawEventRecord[] = []
    for (;;) {
      const page = await store.readRaw(scope, id, { offset: records.length, limit: RAW_PAGE_SIZE })
      records.push(...page.records)
      if (page.records.length === 0 || records.length >= page.total) return records
    }
  }

  const tokensOf = (result: EpisodeSummaryResult) => ({ summary: estimator.estimate(result.summary), gist: estimator.estimate(result.gist) })

  const writeOutcome = async (scope: ScopeId, id: EpisodeId, outcome: SummarizeOutcome, kind: 'checkpoint' | 'episode'): Promise<EpisodeMeta> => {
    const tokens = tokensOf(outcome.result)
    const meta = await store.writeSummary(scope, id, outcome.result, outcome.provenance, tokens)
    await log({
      kind,
      ok: true,
      scope,
      episode: id,
      provider: outcome.provenance.provider,
      model: outcome.provenance.model,
      promptVersion: outcome.provenance.promptVersion,
      tokens,
      importance: outcome.result.importance,
      ...outcome.usage === undefined ? {} : { usage: outcome.usage },
    })
    return meta
  }

  const rollupTarget = (gistTokens: number, replacedTokens: number): number =>
    Math.max(gistTokens * 2, Math.min(gistTokens * 6, Math.ceil(replacedTokens / 3)))

  const hostReady = (): boolean => {
    try {
      return deps.hostReady?.() !== false
    } catch {
      return false
    }
  }

  /** A route the summarizer can call, else a deferral: no model is known yet or the host is going away. */
  const readyRoute = async (): Promise<SummaryRoute> => {
    if (!hostReady()) throw new JobDeferredError('the host model services are unavailable (DSH is shutting down or the plugin is unloading)')
    const route = await deps.backgroundRoute()
    if (route.provider.length === 0 || route.model.length === 0) {
      throw new JobDeferredError('no summarizer model route is available yet (no summarizer.provider/model and no default model)')
    }
    return route
  }

  /** A failure seen while the host went away is a deferral, not an attempt. */
  const deferIfHostGone = (error: unknown): unknown =>
    hostReady() || error instanceof JobDeferredError
      ? error
      : new JobDeferredError(`deferred while the host model services are unavailable: ${errorMessage(error)}`, { cause: error })

  return {
    summarizer,
    rollups,
    writeOutcome,
    log,

    async summarizeEpisode(scope, id, signal) {
      const meta = (await store.readIndex(scope)).episodes.find(episode => episode.id === id)
      if (meta === undefined || meta.status === 'open' || meta.status === 'summarized') return
      const route = await readyRoute()
      const records = await readAllRaw(scope, id)
      signal.throwIfAborted()
      const budget = await deps.levelBudget()
      let outcome: SummarizeOutcome
      try {
        outcome = await summarizer.summarize({
          episode: meta,
          transcript: renderTranscript(records, { timeZone }),
          targets: { summaryTokens: budget.recentSummaryTokens, gistTokens: budget.gistTokens },
          now: clock.now(),
          timeZone,
          route,
        }, signal)
      } catch (error) {
        if (error instanceof SummarizeError && error.code === 'empty-input') {
          await store.updateEpisode(scope, id, { status: 'failed', lastError: `${EMPTY_EPISODE_ERROR}: ${error.message}`, attempts: deps.maxAttempts })
          logger.debug('episode %s has no conversation content; not summarizing it', id)
          await log({ kind: 'episode', ok: false, permanent: true, scope, episode: id, error: error.message })
          return
        }
        const reported = deferIfHostGone(error)
        if (reported instanceof JobDeferredError) throw reported
        await log({ kind: 'episode', ok: false, scope, episode: id, provider: route.provider, model: route.model, error: errorMessage(error) })
        throw error
      }
      await writeOutcome(scope, id, outcome, 'episode')
    },

    async buildRollup(scope, period, signal) {
      const index = await store.readIndex(scope)
      if (index.rollups.some(entry => entry.period.kind === period.kind && entry.period.key === period.key)) return
      const now = clock.now()
      const members = rollupMembers(index, period, { now, keepRecentDays: KEEP_RECENT_DAYS })
      if (members.length === 0) return
      const weekEntries = period.kind === 'month'
        ? index.rollups.filter(entry => entry.period.kind === 'week' && parentPeriod(entry.period)?.key === period.key)
        : []
      const covered = new Set<string>(weekEntries.flatMap(entry => entry.episodeIds))
      const items: { at: number; text: string }[] = []
      for (const entry of weekEntries) {
        const text = await store.readRollup(scope, entry.id)
        if (text !== undefined) items.push({ at: entry.from, text })
      }
      for (const meta of members) {
        if (covered.has(meta.id)) continue
        const text = await store.readTier(scope, meta.id, 'gist') ?? await store.readTier(scope, meta.id, 'summary')
        if (text !== undefined) items.push({ at: meta.startedAt, text })
      }
      if (items.length === 0) return
      items.sort((a, b) => a.at - b.at)
      signal.throwIfAborted()
      const budget = await deps.levelBudget()
      const replaced = members.reduce((sum, meta) => sum + (meta.tokens.gist ?? 0), 0)
      const route = await readyRoute()
      let outcome
      try {
        outcome = await rollups.rollup({ period, items, targetTokens: rollupTarget(budget.gistTokens, replaced), timeZone, route }, signal)
      } catch (error) {
        const reported = deferIfHostGone(error)
        if (reported instanceof JobDeferredError) throw reported
        await log({ kind: 'rollup', ok: false, scope, period, error: errorMessage(error) })
        throw error
      }
      const episodeIds = members.map(meta => meta.id)
      const entry: RollupEntry = {
        id: period.key,
        scope,
        period: { kind: period.kind, key: period.key },
        episodeIds,
        from: Math.min(...members.map(meta => meta.startedAt)),
        to: Math.max(...members.map(meta => meta.endedAt ?? meta.startedAt)),
        tokens: outcome.tokens,
        file: `rollups/${period.key}.md`,
        createdAt: now,
      }
      await store.writeRollup(scope, entry, outcome.text)
      await log({ kind: 'rollup', ok: true, scope, period, episodes: episodeIds.length, tokens: outcome.tokens, provider: outcome.provenance.provider, model: outcome.provenance.model })
    },

    planRollups(index, distantQuotaTokens, gistTokens) {
      return planRollups(index, {
        distantQuotaTokens,
        gistTokensOf: meta => meta.tokens.gist ?? 0,
        now: clock.now(),
        keepRecentDays: KEEP_RECENT_DAYS,
        estimateRollupTokens: (_period, replaced) => rollupTarget(gistTokens, replaced),
      })
    },
  }
}
