import type { EpisodeId, EpisodeMeta, MemoryIndex, MemoryStore, Millis, ScopeId, TokenEstimator } from '../contracts.ts'
import { isEmptyEpisode } from '../runtime/sources.ts'
import type { FileMemoryStore, TierDocument } from '../store/index.ts'
import { isConversationRecord, rawRecordText } from './raw.ts'
import { missingGist } from './render.ts'
import { extractQueryDates, isCjk, isoDatesIn, localDate, normalize, queryTerms, tokenize, truncateToTokens } from './text.ts'
import type { Tokens } from './text.ts'

export interface MemorySearchOptions {
  /** Estimated tokens of raw text one `includeRaw` query may scan. */
  readonly rawScanTokens?: number
  /** Most recent candidate episodes one `includeRaw` query may scan. */
  readonly rawScanEpisodes?: number
  /** Raw records fetched per `readRaw` call while scanning. */
  readonly rawPageSize?: number
  /** Ceiling for the gist text returned with each hit. */
  readonly hitGistTokens?: number
  /** Parallel tier reads while (re)building a scope index. */
  readonly readConcurrency?: number
  readonly defaultLimit?: number
  readonly maxLimit?: number
}

export interface MemorySearchDeps {
  readonly store: Pick<MemoryStore, 'readIndex' | 'readRaw'> & Pick<FileMemoryStore, 'readTierDocument'>
  readonly estimator: TokenEstimator
  readonly options?: MemorySearchOptions
}

export interface MemorySearchQuery {
  readonly scope: ScopeId
  /** Free text in any language; an empty query lists the filtered episodes newest first. */
  readonly query: string
  /** Inclusive lower bound on the episode's time span. */
  readonly from?: Millis
  /** Inclusive upper bound on the episode's time span. */
  readonly to?: Millis
  readonly limit?: number
  /** Also scan the conversation records of raw transcripts, bounded by {@link MemorySearchOptions.rawScanTokens}. */
  readonly includeRaw?: boolean
}

export interface MemorySearchHit {
  readonly id: EpisodeId
  /** Local start date `YYYY-MM-DD`. */
  readonly date: string
  readonly gist: string
  readonly score: number
}

export interface MemorySearchResult {
  /** Number of matching episodes, independent of `limit`. */
  readonly total: number
  readonly hits: readonly MemorySearchHit[]
  /** Raw scanning stopped at its bound, so raw-only matches in unscanned episodes are not counted. */
  readonly rawPartial?: true
}

export interface MemorySearch {
  search(query: MemorySearchQuery, signal?: AbortSignal): Promise<MemorySearchResult>
  /** Drop cached indexes; the next search rebuilds them. */
  invalidate(scope?: ScopeId): void
}

const DEFAULTS = {
  rawScanTokens: 200_000,
  rawScanEpisodes: 50,
  rawPageSize: 200,
  hitGistTokens: 120,
  readConcurrency: 8,
  defaultLimit: 8,
  maxLimit: 50,
} satisfies Required<MemorySearchOptions>

const K1 = 1.2
const B = 0.75
const WEIGHTS = { keyword: 3, person: 3, gist: 1.5, summary: 1 } as const
const RAW_WEIGHT = 0.5
const BONUS = { keyword: 2, person: 2, date: 1.5, phrase: 1 } as const
const MAX_KEYWORD_BONUSES = 2
const PINNED_FACTOR = 1.1
const MIN_SHOULD_MATCH = 0.3
const RAW_RECORD_CHARS = 8000
const SNIPPET_BEFORE = 40
const SNIPPET_AFTER = 100

interface Phrase {
  readonly text: string
  readonly terms: readonly string[]
  readonly cjk: boolean
}

interface Doc {
  readonly signature: string
  readonly meta: EpisodeMeta
  readonly gist?: string
  readonly summary?: string
  readonly keywords: readonly Phrase[]
  readonly people: readonly Phrase[]
  readonly factDates: readonly string[]
  readonly tf: ReadonlyMap<string, number>
  readonly length: number
  readonly text: string
}

interface ScopeCache {
  readonly updatedAt: Millis
  readonly docs: ReadonlyMap<EpisodeId, Doc>
}

interface RawScan {
  readonly tf: ReadonlyMap<EpisodeId, ReadonlyMap<string, number>>
  readonly length: ReadonlyMap<EpisodeId, number>
  readonly snippets: ReadonlyMap<EpisodeId, string>
  readonly partial: boolean
}

function signatureOf(meta: EpisodeMeta): string {
  return [
    meta.status,
    meta.tokens.gist ?? '',
    meta.tokens.summary ?? '',
    meta.summarizer?.summarizedAt ?? '',
    meta.keywords.join('\u0001'),
  ].join('|')
}

function phrases(values: readonly string[]): Phrase[] {
  const texts = [...new Set(values.map(value => normalize(value).trim()).filter(value => value !== ''))]
  return texts.map(text => ({ text, terms: [...new Set(tokenize(text).terms)], cjk: [...text].some(isCjk) }))
}

function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** `YYYY-MM-DD` of each dated fact in a tier file's `dates: [{date, what}]`. */
function factDatesOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((fact: unknown) => {
    const date: unknown = typeof fact === 'object' && fact !== null ? (fact as { readonly date?: unknown }).date : undefined
    return typeof date === 'string' ? isoDatesIn(date) : []
  })
}

function matchesQuery(phrase: Phrase, queryNorm: string, terms: ReadonlySet<string>): boolean {
  if (phrase.cjk && [...phrase.text].length >= 2 && queryNorm.includes(phrase.text)) return true
  if (phrase.terms.length === 0) return false
  const overlap = phrase.terms.filter(term => terms.has(term)).length
  return overlap > 0 && overlap * 2 >= phrase.terms.length
}

function inRange(meta: EpisodeMeta, from: Millis | undefined, to: Millis | undefined): boolean {
  const end = meta.endedAt ?? meta.startedAt
  return (from === undefined || end >= from) && (to === undefined || meta.startedAt <= to)
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

async function forEachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!
      await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}

function snippetAround(text: string, terms: readonly string[]): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    const index = lower.indexOf(term)
    if (index >= 0 && (at < 0 || index < at)) at = index
  }
  if (at < 0) at = 0
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const end = Math.min(text.length, at + SNIPPET_AFTER)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function bm25(tf: number, idf: number, length: number, averageLength: number): number {
  if (tf <= 0) return 0
  const norm = averageLength > 0 ? length / averageLength : 1
  return idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * norm))
}

export function createMemorySearch(deps: MemorySearchDeps): MemorySearch {
  const { store, estimator } = deps
  const options = { ...DEFAULTS, ...deps.options }
  const caches = new Map<ScopeId, ScopeCache>()
  const pending = new Map<ScopeId, { readonly updatedAt: Millis; readonly token: symbol; readonly promise: Promise<ScopeCache> }>()

  async function readDocument(scope: ScopeId, id: EpisodeId, tier: 'gist' | 'summary'): Promise<TierDocument | undefined> {
    try {
      return await store.readTierDocument(scope, id, tier)
    } catch {
      return undefined
    }
  }

  async function loadDoc(scope: ScopeId, meta: EpisodeMeta, signature: string): Promise<Doc> {
    const hasTiers = meta.status === 'summarized' || meta.tokens.gist !== undefined || meta.tokens.summary !== undefined
    const documents = hasTiers
      ? await Promise.all([readDocument(scope, meta.id, 'gist'), readDocument(scope, meta.id, 'summary')])
      : [undefined, undefined]
    const [gistDocument, summaryDocument] = documents
    const gist = gistDocument?.body.trim() || undefined
    const summary = summaryDocument?.body.trim() || undefined
    const keywords = phrases([...meta.keywords, ...documents.flatMap(document => stringsOf(document?.frontmatter?.keywords ?? document?.fields.keywords))])
    const people = phrases(documents.flatMap(document => stringsOf(document?.frontmatter?.people ?? document?.fields.people)))
    const factDates = [...new Set(documents.flatMap(document => factDatesOf(document?.frontmatter?.dates ?? document?.fields.dates)))]

    const tf = new Map<string, number>()
    let length = 0
    const add = (tokens: Tokens, weight: number): void => {
      for (const term of tokens.terms) tf.set(term, (tf.get(term) ?? 0) + weight)
      for (const char of tokens.chars) tf.set(char, (tf.get(char) ?? 0) + weight)
      length += tokens.terms.length * weight
    }
    for (const keyword of keywords) add(tokenize(keyword.text), WEIGHTS.keyword)
    for (const person of people) add(tokenize(person.text), WEIGHTS.person)
    if (gist !== undefined) add(tokenize(gist), WEIGHTS.gist)
    if (summary !== undefined) add(tokenize(summary), WEIGHTS.summary)

    return {
      signature,
      meta,
      ...gist === undefined ? {} : { gist },
      ...summary === undefined ? {} : { summary },
      keywords,
      people,
      factDates,
      tf,
      length,
      text: normalize(`${gist ?? ''}\n${summary ?? ''}`).replace(/\s+/g, ' '),
    }
  }

  async function build(scope: ScopeId, index: MemoryIndex, previous: ScopeCache | undefined): Promise<ScopeCache> {
    const docs = new Map<EpisodeId, Doc>()
    const metas = index.episodes.filter(meta => meta.scope === scope)
    await forEachLimited(metas, options.readConcurrency, async meta => {
      const signature = signatureOf(meta)
      const old = previous?.docs.get(meta.id)
      docs.set(meta.id, old?.signature === signature ? { ...old, meta } : await loadDoc(scope, meta, signature))
    })
    return { updatedAt: index.updatedAt, docs }
  }

  async function indexFor(scope: ScopeId): Promise<ScopeCache> {
    const index = await store.readIndex(scope)
    const cached = caches.get(scope)
    if (cached?.updatedAt === index.updatedAt) return cached
    const inflight = pending.get(scope)
    if (inflight?.updatedAt === index.updatedAt) return inflight.promise
    const token = Symbol(scope)
    const promise = (async () => {
      try {
        const result = await build(scope, index, cached)
        if (pending.get(scope)?.token === token) caches.set(scope, result)
        return result
      } finally {
        if (pending.get(scope)?.token === token) pending.delete(scope)
      }
    })()
    pending.set(scope, { updatedAt: index.updatedAt, token, promise })
    return promise
  }

  async function scanRaw(scope: ScopeId, candidates: readonly Doc[], terms: readonly string[], signal?: AbortSignal): Promise<RawScan> {
    const wanted = new Set(terms)
    const tf = new Map<EpisodeId, Map<string, number>>()
    const lengths = new Map<EpisodeId, number>()
    const snippets = new Map<EpisodeId, string>()
    const ordered = [...candidates].sort((a, b) => b.meta.startedAt - a.meta.startedAt)
    let partial = ordered.length > options.rawScanEpisodes
    let budget = options.rawScanTokens
    for (const doc of ordered.slice(0, options.rawScanEpisodes)) {
      if (budget <= 0) {
        partial = true
        break
      }
      const counts = new Map<string, number>()
      let length = 0
      let offset = 0
      for (;;) {
        signal?.throwIfAborted()
        let page
        try {
          page = await store.readRaw(scope, doc.meta.id, { offset, limit: options.rawPageSize })
        } catch {
          break
        }
        for (const record of page.records) {
          if (!isConversationRecord(record)) continue
          const text = rawRecordText(record, { maxChars: RAW_RECORD_CHARS, reasoning: false })
          if (text === undefined) continue
          budget -= estimator.estimate(text)
          const tokens = tokenize(text)
          length += tokens.terms.length
          let hit = false
          for (const list of [tokens.terms, tokens.chars]) {
            for (const term of list) {
              if (!wanted.has(term)) continue
              counts.set(term, (counts.get(term) ?? 0) + 1)
              hit = true
            }
          }
          if (hit && !snippets.has(doc.meta.id)) snippets.set(doc.meta.id, snippetAround(text, terms))
        }
        offset += page.records.length
        if (page.records.length === 0 || offset >= page.total) break
        if (budget <= 0) {
          partial = true
          break
        }
      }
      lengths.set(doc.meta.id, length)
      if (counts.size > 0) tf.set(doc.meta.id, counts)
    }
    return { tf, length: lengths, snippets, partial }
  }

  function hitGist(doc: Doc, snippet: string | undefined): string {
    const text = doc.gist ?? doc.summary ?? snippet ?? missingGist(doc.meta.status)
    return truncateToTokens(text.replace(/\s+/g, ' ').trim(), options.hitGistTokens, estimator).text
  }

  async function search(query: MemorySearchQuery, signal?: AbortSignal): Promise<MemorySearchResult> {
    signal?.throwIfAborted()
    const limit = clampInt(query.limit, options.defaultLimit, 1, options.maxLimit)
    const cache = await indexFor(query.scope)
    signal?.throwIfAborted()

    const dates = extractQueryDates(query.query)
    const terms = queryTerms(dates.rest)
    const restNorm = normalize(dates.rest).replace(/\s+/g, ' ').trim()
    const queryNorm = normalize(query.query)
    const termSet = new Set(terms)
    const hasDates = dates.full.length > 0 || dates.monthDay.length > 0
    const browse = terms.length === 0 && !hasDates

    const candidates = [...cache.docs.values()].filter(doc => !doc.meta.hidden && !isEmptyEpisode(doc.meta) && inRange(doc.meta, query.from, query.to))
    const raw = query.includeRaw === true && terms.length > 0 ? await scanRaw(query.scope, candidates, terms, signal) : undefined

    const scored: { readonly doc: Doc; readonly score: number }[] = []
    if (browse) {
      for (const doc of candidates) scored.push({ doc, score: 0 })
    } else {
      const total = candidates.length
      const averageLength = total === 0 ? 0 : candidates.reduce((sum, doc) => sum + doc.length, 0) / total
      const rawLengths = raw === undefined ? [] : [...raw.length.values()].filter(length => length > 0)
      const averageRawLength = rawLengths.length === 0 ? 0 : rawLengths.reduce((sum, length) => sum + length, 0) / rawLengths.length
      const idf = new Map<string, number>()
      for (const term of terms) {
        let df = 0
        for (const doc of candidates) {
          if ((doc.tf.get(term) ?? 0) > 0 || (raw?.tf.get(doc.meta.id)?.get(term) ?? 0) > 0) df++
        }
        idf.set(term, Math.log(1 + (total - df + 0.5) / (df + 0.5)))
      }
      const minimumMatched = Math.max(1, Math.ceil(terms.length * MIN_SHOULD_MATCH))
      const phrase = terms.length > 1 && restNorm.length >= 2 ? restNorm : undefined
      const named = (value: Phrase): boolean => matchesQuery(value, queryNorm, termSet)

      for (const doc of candidates) {
        const rawTf = raw?.tf.get(doc.meta.id)
        const rawLength = raw?.length.get(doc.meta.id) ?? 0
        let matched = 0
        let score = 0
        for (const term of terms) {
          const indexTf = doc.tf.get(term) ?? 0
          const termRawTf = rawTf?.get(term) ?? 0
          if (indexTf <= 0 && termRawTf <= 0) continue
          matched++
          const weight = idf.get(term) ?? 0
          score += bm25(indexTf, weight, doc.length, averageLength)
          score += RAW_WEIGHT * bm25(termRawTf, weight, rawLength, averageRawLength)
        }
        let bonus = 0
        bonus += BONUS.keyword * Math.min(MAX_KEYWORD_BONUSES, doc.keywords.filter(named).length)
        bonus += BONUS.person * Math.min(MAX_KEYWORD_BONUSES, doc.people.filter(named).length)
        if (hasDates) {
          const docDates = new Set([localDate(doc.meta.startedAt), ...doc.factDates])
          if (doc.meta.endedAt !== undefined) docDates.add(localDate(doc.meta.endedAt))
          if ([...docDates].some(date => dates.full.includes(date) || dates.monthDay.includes(date.slice(5)))) bonus += BONUS.date
        }
        if (phrase !== undefined && doc.text.includes(phrase)) bonus += BONUS.phrase
        if (matched < minimumMatched && bonus === 0) continue
        scored.push({ doc, score: (score + bonus) * (doc.meta.pinned ? PINNED_FACTOR : 1) })
      }
    }

    scored.sort((a, b) => b.score - a.score || b.doc.meta.startedAt - a.doc.meta.startedAt)
    const hits = scored.slice(0, limit).map(({ doc, score }) => ({
      id: doc.meta.id,
      date: localDate(doc.meta.startedAt),
      gist: hitGist(doc, raw?.snippets.get(doc.meta.id)),
      score: Math.round(score * 1000) / 1000,
    }))
    return { total: scored.length, hits, ...raw?.partial === true ? { rawPartial: true as const } : {} }
  }

  return {
    search,
    invalidate(scope) {
      if (scope === undefined) {
        caches.clear()
        pending.clear()
      } else {
        caches.delete(scope)
        pending.delete(scope)
      }
    },
  }
}
