import type { EpisodeMeta, MemoryStore, PackCandidate, PackInput, RollupEntry, RollupPeriod, ScopeId } from '../contracts.ts'
import { OWNER_SCOPE } from '../contracts.ts'
import type { FileMemoryStore } from '../store/index.ts'
import { parentPeriod, periodId } from '../summarize/jobs/periods.ts'

/** `lastError` prefix of episodes with no conversation content; never retried, never packed. */
export const EMPTY_EPISODE_ERROR = 'empty-input'

const MAX_CACHED_TIERS = 4096

export interface PackSources {
  readonly candidates: readonly PackCandidate[]
  readonly rollups: PackInput['rollups']
  readonly profile?: string
}

export interface PackSourceOptions {
  /** Leave out this session's `open` episodes: their text is still in the live context. */
  readonly excludeOpenOf?: string
}

export interface PackSourceLoader {
  load(scope: ScopeId, options?: PackSourceOptions): Promise<PackSources>
}

export function isEmptyEpisode(meta: Pick<EpisodeMeta, 'status' | 'lastError'>): boolean {
  return meta.status === 'failed' && meta.lastError?.startsWith(EMPTY_EPISODE_ERROR) === true
}

type TierTexts = Pick<PackCandidate, 'summary' | 'gist' | 'promises' | 'dates'>

/**
 * Periods whose rollup text may carry a hidden episode: every rollup that
 * lists one, and every coarser period above it, since a month rollup is
 * written from its week rollups' text and lists only the members visible
 * when it was built.
 */
export function leakingRollupPeriods(index: { readonly episodes: readonly EpisodeMeta[]; readonly rollups: readonly RollupEntry[] }): ReadonlySet<string> {
  const hidden = new Set<string>(index.episodes.filter(meta => meta.hidden).map(meta => meta.id))
  const leaking = new Set<string>()
  if (hidden.size === 0) return leaking
  for (const entry of index.rollups) {
    if (!entry.episodeIds.some(id => hidden.has(id))) continue
    for (let period: RollupPeriod | undefined = entry.period; period !== undefined; period = parentPeriod(period)) leaking.add(periodId(period))
  }
  return leaking
}

/**
 * Packer input for one scope: every visible episode with whatever tier texts
 * exist (kept while a `/memory rebuild` re-summarizes them) plus the promises
 * and dates of its `summary.md` frontmatter, every rollup that cannot carry a
 * hidden episode ({@link leakingRollupPeriods}; the visible members of a
 * dropped rollup are packed as their own gists), and the scope's profile.
 * Tier texts are cached by summary time. Each fresh pack reads the current profile.
 */
export function createPackSourceLoader(
  store: Pick<MemoryStore, 'readIndex' | 'readTier' | 'readRollup' | 'readProfile'> & Pick<FileMemoryStore, 'readTierDocument'>,
  readOwnerNotes?: () => Promise<readonly string[]>,
): PackSourceLoader {
  const tiers = new Map<string, TierTexts>()

  const tierTexts = async (scope: ScopeId, meta: EpisodeMeta): Promise<TierTexts> => {
    if (meta.tokens.summary === undefined && meta.tokens.gist === undefined) return {}
    const key = `${scope}/${meta.id}@${meta.summarizer?.summarizedAt ?? 0}`
    const cached = tiers.get(key)
    if (cached !== undefined) return cached
    const [document, gist] = await Promise.all([store.readTierDocument(scope, meta.id, 'summary'), store.readTier(scope, meta.id, 'gist')])
    const summary = document?.body
    const promises = document?.frontmatter?.promises
    const dates = document?.frontmatter?.dates
    const texts: TierTexts = {
      ...summary === undefined ? {} : { summary },
      ...gist === undefined ? {} : { gist },
      ...promises === undefined || promises.length === 0 ? {} : { promises },
      ...dates === undefined || dates.length === 0 ? {} : { dates },
    }
    if (tiers.size >= MAX_CACHED_TIERS) tiers.clear()
    tiers.set(key, texts)
    return texts
  }

  return {
    async load(scope, options = {}) {
      const index = await store.readIndex(scope)
      const candidates: PackCandidate[] = []
      for (const meta of index.episodes) {
        if (meta.hidden || isEmptyEpisode(meta)) continue
        if (meta.status === 'open' && meta.sessionId === options.excludeOpenOf) continue
        candidates.push({ meta, ...await tierTexts(scope, meta) })
      }
      const rollups: { entry: RollupEntry; text: string }[] = []
      const leaking = leakingRollupPeriods(index)
      for (const entry of index.rollups) {
        if (leaking.has(periodId(entry.period))) continue
        const text = await store.readRollup(scope, entry.id)
        if (text !== undefined && text.trim().length > 0) rollups.push({ entry, text })
      }
      const manual = await store.readProfile(scope)
      const notes = scope === OWNER_SCOPE && readOwnerNotes ? await readOwnerNotes() : []
      // Keep the user's hand-written lines first when the profile quota is tight.
      const profile = [manual, ...notes].filter(line => line?.trim()).join('\n')
      return { candidates, rollups, ...profile ? { profile } : {} }
    },
  }
}
