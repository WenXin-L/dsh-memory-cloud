import type {
  CheckpointComposer,
  CheckpointRequest,
  Clock,
  EpisodeId,
  EpisodeMeta,
  MemoryPacker,
  MemoryStore,
  PackCandidate,
  ScopeId,
  SummarizeOutcome,
  Summarizer,
  TokenEstimator,
} from '../contracts.ts'
import type { PackSourceLoader } from './sources.ts'

const CACHE_TTL_MS = 30 * 60_000
const MAX_CACHED_PER_SESSION = 4

/** A region the engine already summarized, waiting for capture's compaction seal. */
export interface ComposedRegion {
  readonly sessionId: string
  readonly scope: ScopeId
  /** The open episode the region belonged to when it was summarized. */
  readonly episode: EpisodeId
  readonly regionSeqs: readonly number[]
  readonly outcome: SummarizeOutcome
  readonly at: number
}

export interface CheckpointComposerDeps {
  readonly store: Pick<MemoryStore, 'readIndex' | 'writeSnapshot'>
  readonly sources: PackSourceLoader
  readonly packer: MemoryPacker
  readonly summarizer: Summarizer
  readonly estimator: TokenEstimator
  readonly clock: Clock
  /** Persist the session's buffered capture so its open episode exists in the store. */
  readonly flushSession: (sessionId: string) => Promise<void>
  readonly halfLifeDays: () => number
  readonly log: (record: Record<string, unknown>) => Promise<void>
  /** Privacy guard (`canReadScope`); a scope the session may not read rejects so the engine uses the host summary. */
  readonly mayRead?: (sessionId: string, scope: ScopeId) => boolean
  /** Whether a session-log seq is a synthetic message (memory block, checkpoint), which never bounds a region. */
  readonly syntheticSeq?: (sessionId: string, seq: number) => boolean
}

export interface MemoryCheckpointComposer extends CheckpointComposer {
  /**
   * Remove and return the composition for a compaction seal of `sessionId`:
   * the newest cached region whose first and last real (non-synthetic) seqs
   * are those of `shadowedSeqs`. Compositions without a recorded region are
   * never cached.
   */
  takeComposed(sessionId: string, shadowedSeqs: readonly number[] | undefined): ComposedRegion | undefined
  forget(sessionId: string): void
}

/**
 * Engine-mode checkpoint (design §3.1 A): summarize the replayed region on the
 * conversation route, cache the result for the compaction seal, and pack a
 * `checkpoint` block from the scope's other episodes plus the fresh summary,
 * within the engine's shrink-guard `maxChars`. Every failure rejects so the
 * engine falls back to `super.summarize()`.
 */
export function createCheckpointComposer(deps: CheckpointComposerDeps): MemoryCheckpointComposer {
  const { store, clock } = deps
  const cache = new Map<string, ComposedRegion[]>()

  const isSynthetic = (sessionId: string, seq: number): boolean => {
    try {
      return deps.syntheticSeq?.(sessionId, seq) === true
    } catch {
      return false
    }
  }

  const realBounds = (sessionId: string, seqs: readonly number[]): { first: number; last: number } | undefined => {
    let first: number | undefined
    let last: number | undefined
    for (const seq of seqs) {
      if (!Number.isSafeInteger(seq) || isSynthetic(sessionId, seq)) continue
      if (first === undefined || seq < first) first = seq
      if (last === undefined || seq > last) last = seq
    }
    return first === undefined || last === undefined ? undefined : { first, last }
  }

  const remember = (entry: ComposedRegion): void => {
    const now = clock.now()
    const kept = (cache.get(entry.sessionId) ?? []).filter(item => now - item.at < CACHE_TTL_MS)
    cache.set(entry.sessionId, [...kept, entry].slice(-MAX_CACHED_PER_SESSION))
  }

  return {
    async compose(request: CheckpointRequest, signal?: AbortSignal): Promise<string> {
      const { sessionId, scope } = request
      if (deps.mayRead?.(sessionId, scope) === false) throw new Error(`session ${sessionId} may not read memory scope ${scope}`)
      await deps.flushSession(sessionId)
      signal?.throwIfAborted()
      const open = latestOpen(await store.readIndex(scope), sessionId)
      if (open === undefined) throw new Error(`no open episode for session ${sessionId} in scope ${scope}`)

      const outcome = await deps.summarizer.summarize({
        episode: { id: open.id, sessionId, startedAt: open.startedAt, endedAt: request.now },
        transcript: '',
        targets: { summaryTokens: request.budget.recentSummaryTokens, gistTokens: request.budget.gistTokens },
        now: request.now,
        replay: request.replay,
        ...request.route === undefined ? {} : { route: { provider: request.route.provider, model: request.route.model } },
      }, signal)
      if (request.regionSeqs !== undefined && request.regionSeqs.length > 0) {
        remember({ sessionId, scope, episode: open.id, regionSeqs: [...request.regionSeqs], outcome, at: clock.now() })
      }
      await deps.log({
        kind: 'checkpoint-summary',
        ok: true,
        scope,
        sessionId,
        episode: open.id,
        provider: outcome.provenance.provider,
        model: outcome.provenance.model,
        ...outcome.usage === undefined ? {} : { usage: outcome.usage },
      })

      const sources = await deps.sources.load(scope, { excludeOpenOf: sessionId })
      const fresh: PackCandidate = {
        meta: {
          ...open,
          status: 'summarized',
          endedAt: request.now,
          importance: outcome.result.importance,
          keywords: outcome.result.keywords,
          tokens: { raw: open.tokens.raw, summary: deps.estimator.estimate(outcome.result.summary), gist: deps.estimator.estimate(outcome.result.gist) },
          summarizer: outcome.provenance,
        },
        summary: outcome.result.summary,
        gist: outcome.result.gist,
        promises: outcome.result.promises,
        dates: outcome.result.dates,
      }
      const packed = deps.packer.pack({
        candidates: [...sources.candidates, fresh],
        rollups: sources.rollups,
        ...sources.profile === undefined ? {} : { profile: sources.profile },
        ongoing: outcome.result.ongoing,
        budget: request.budget,
        mode: 'checkpoint',
        halfLifeDays: deps.halfLifeDays(),
        now: request.now,
        maxChars: request.maxChars,
      })
      if (packed.text.trim().length === 0) throw new Error(`no memory block fits ${request.maxChars} characters`)
      signal?.throwIfAborted()
      await store.writeSnapshot(scope, { sessionId, n: snapshotNumber(request.regionSeqs) }, packed.text)
      return packed.text
    },

    takeComposed(sessionId, shadowedSeqs) {
      const entries = cache.get(sessionId)
      if (entries === undefined) return undefined
      const shadowed = shadowedSeqs === undefined ? undefined : realBounds(sessionId, shadowedSeqs)
      if (shadowed === undefined) return undefined
      const now = clock.now()
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index] as ComposedRegion
        if (now - entry.at >= CACHE_TTL_MS) continue
        const region = realBounds(sessionId, entry.regionSeqs)
        if (region?.first !== shadowed.first || region.last !== shadowed.last) continue
        entries.splice(index, 1)
        if (entries.length === 0) cache.delete(sessionId)
        return entry
      }
      return undefined
    },

    forget(sessionId) {
      cache.delete(sessionId)
    },
  }
}

function latestOpen(index: { readonly episodes: readonly EpisodeMeta[] }, sessionId: string): EpisodeMeta | undefined {
  let latest: EpisodeMeta | undefined
  for (const meta of index.episodes) {
    if (meta.sessionId !== sessionId || meta.status !== 'open') continue
    if (latest === undefined || meta.seqRange.first > latest.seqRange.first) latest = meta
  }
  return latest
}

function snapshotNumber(seqs: readonly number[] | undefined): number {
  let max = 0
  for (const seq of seqs ?? []) if (Number.isSafeInteger(seq) && seq > max) max = seq
  return max
}
