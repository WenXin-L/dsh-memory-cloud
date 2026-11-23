import type { EpisodeMeta, MemoryStore, PackCandidate, PackInput, RollupEntry, ScopeId } from '../contracts.ts'
import type { FileMemoryStore } from '../store/index.ts'

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
 * Packer input for one scope: every visible episode with whatever tier texts
 * exist (kept while a `/memory rebuild` re-summarizes them) plus the promises
 * and dates of its `summary.md` frontmatter, every rollup, and `profile.md`.
 * Tier texts are cached by summary time, so repeated packs read only the index.
 */
export function createPackSourceLoader(
  store: Pick<MemoryStore, 'readIndex' | 'readTier' | 'readRollup' | 'readProfile'> & Pick<FileMemoryStore, 'readTierDocument'>,
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
      for (const entry of index.rollups) {
        const text = await store.readRollup(scope, entry.id)
        if (text !== undefined && text.trim().length > 0) rollups.push({ entry, text })
      }
      const profile = await store.readProfile(scope)
      return { candidates, rollups, ...profile === undefined || profile.trim().length === 0 ? {} : { profile } }
    },
  }
}
