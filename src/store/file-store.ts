import type { FileHandle } from 'node:fs/promises'
import { open, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  Clock,
  EpisodeId,
  EpisodeMeta,
  EpisodeMetaPatch,
  EpisodeSummaryResult,
  MemoryIndex,
  MemoryStore,
  Millis,
  QueuedJob,
  RawEventRecord,
  RawPage,
  RollupEntry,
  ScopeId,
  SealReason,
  StoreState,
  SummaryProvenance,
  TierTokens,
  TokenEstimator,
} from '../contracts.ts'
import { DEFAULT_TOKEN_ESTIMATOR_OPTIONS } from '../contracts.ts'
import {
  appendLines,
  errorMessage,
  isNotFound,
  listDirectories,
  listFiles,
  pathExists,
  preserveCopy,
  readTextIfExists,
  writeJsonAtomic,
  writeTextAtomic,
} from './files.ts'
import type { Tier, TierDocument } from './frontmatter.ts'
import { parseRollupFile, parseTierFile, renderRollupFile, renderTierFile } from './frontmatter.ts'
import {
  assertEpisodeId,
  assertScopeId,
  createStampFormatter,
  episodeRelativeDir,
  formatEpisodeId,
  isRollupFile,
  isValidScopeId,
  parseEpisodeId,
  safeFileStem,
  sessionTag,
} from './layout.ts'
import { serialize, withPathLock } from './lock.ts'
import {
  describeIndexProblem,
  isEpisodeMeta,
  isFiniteNumber,
  isRawEventRecord,
  isRecord,
  isRollupEntry,
  isStoreState,
  isString,
  isStringArray,
} from './validate.ts'
import type { EpisodeOwner } from './owner.ts'
import { currentOwner, episodeOwner, EpisodeNotOpenError } from './owner.ts'

export interface FileMemoryStoreOptions {
  /** Storage root; created on first write. */
  readonly root: string
  readonly clock: Clock
  /** Estimates tokens of tiers recovered from disk without recorded counts; defaults to the contract formula. */
  readonly estimator?: TokenEstimator
  /** IANA zone for episode ids and `episodes/YYYY/MM/` (default: host zone). */
  readonly timeZone?: string
  /** Cross-process lock wait before a writer fails (default 10 s). */
  readonly lockWaitMs?: number
  /** Non-fatal recoveries (rebuilt index or state, failed `meta.json` mirror). */
  readonly onWarning?: (message: string, error?: unknown) => void
  /** Owner recorded on episodes this store opens (default: this process). */
  readonly owner?: EpisodeOwner
}

export interface FileMemoryStore extends MemoryStore {
  /** `summary.md` / `gist.md` with parsed frontmatter (including people, dates, promises, ongoing). */
  readTierDocument(scope: ScopeId, episode: EpisodeId, tier: Tier): Promise<TierDocument | undefined>
  /** Rebuild `index.json` from the episode and rollup directories, keeping the old file as `index.json.prev-<ts>`. */
  rebuildIndex(scope: ScopeId): Promise<MemoryIndex>
  /**
   * Record this store's owner on an open episode it takes over (capture
   * adopting it after a restart), so other processes no longer see the
   * previous, possibly dead, owner. Returns the current entry, unchanged when
   * the episode is no longer open.
   */
  claimEpisode(scope: ScopeId, episode: EpisodeId): Promise<EpisodeMeta>
}

interface CachedIndex {
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly index: MemoryIndex
}

type IndexRead =
  | { readonly kind: 'ok'; readonly index: MemoryIndex }
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt'; readonly reason: string }

type StateRead =
  | { readonly kind: 'ok'; readonly state: StoreState }
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt'; readonly reason: string }

interface RawCache {
  readonly ino: number
  /** Bytes parsed so far; always just after a newline. */
  readonly offset: number
  readonly records: readonly RawEventRecord[]
  readonly seen: ReadonlySet<number>
}

type StoredEpisodeMeta = EpisodeMeta & { readonly owner?: EpisodeOwner }

type EpisodeUpdate = EpisodeMetaPatch | ((meta: EpisodeMeta) => EpisodeMetaPatch)

interface RecoveredEpisode {
  readonly meta: EpisodeMeta
  /** Built from raw/tier files because `meta.json` was missing or unusable. */
  readonly derived: boolean
  /** Derived without tier frontmatter: its session id is only the tag in its id, and its last seq the highest raw seq. */
  readonly inferred: boolean
}

const INDEX_FILE = 'index.json'
const STATE_FILE = 'state.json'
const META_FILE = 'meta.json'
const RAW_FILE = 'raw.jsonl'
const PROFILE_FILE = 'profile.md'
const TIER_FILES: Readonly<Record<Tier, string>> = { summary: 'summary.md', gist: 'gist.md' }
const DEFAULT_LOCK_WAIT_MS = 10_000
const DEFAULT_IMPORTANCE = 5
const RAW_CACHE_LIMIT = 8
const MAX_SNAPSHOT_VARIANTS = 10_000
const IMMUTABLE_FIELDS: ReadonlySet<string> = new Set(['id', 'scope', 'sessionId', 'dir', 'startedAt'])
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * File-backed {@link MemoryStore} with the design §3.3 layout:
 * `<root>/state.json`, `<root>/logs/`, and `<root>/scopes/<scope>/{index.json,
 * profile.md, episodes/YYYY/MM/<id>/{raw.jsonl,summary.md,gist.md,meta.json},
 * rollups/, snapshots/}`. Each episode's `meta.json` mirrors its index entry so
 * a lost or corrupt index can be rebuilt without losing pins or recall counts.
 */
export function createFileMemoryStore(options: FileMemoryStoreOptions): FileMemoryStore {
  const root = resolve(options.root)
  const { clock } = options
  const estimator = options.estimator ?? createFallbackEstimator()
  const stamp = createStampFormatter(options.timeZone)
  const lockOptions = { waitMs: options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS }
  const statePath = join(root, STATE_FILE)
  const cache = new Map<ScopeId, CachedIndex>()
  const rawCache = new Map<string, RawCache>()
  const reconciled = new Set<ScopeId>()
  const owner = options.owner ?? currentOwner()

  const scopeDir = (scope: ScopeId): string => join(root, 'scopes', scope)
  const indexPath = (scope: ScopeId): string => join(scopeDir(scope), INDEX_FILE)
  const episodeDir = (scope: ScopeId, id: string): string => join(scopeDir(scope), ...episodeRelativeDir(id).split('/'))
  const rawPath = (scope: ScopeId, id: string): string => join(episodeDir(scope, id), RAW_FILE)

  function warn(message: string, error?: unknown): void {
    try {
      options.onWarning?.(message, error)
    } catch (callbackError) {
      void callbackError
    }
  }

  function emptyIndex(scope: ScopeId): MemoryIndex {
    return { version: 1, scope, episodes: [], rollups: [], updatedAt: clock.now() }
  }

  async function readIndexFile(scope: ScopeId): Promise<IndexRead> {
    let handle: FileHandle
    try {
      handle = await open(indexPath(scope), 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      cache.delete(scope)
      return { kind: 'missing' }
    }
    try {
      const info = await handle.stat()
      const cached = cache.get(scope)
      if (cached !== undefined && cached.ino === info.ino && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        return { kind: 'ok', index: cached.index }
      }
      const text = await handle.readFile('utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        return { kind: 'corrupt', reason: `invalid JSON: ${errorMessage(error)}` }
      }
      const problem = describeIndexProblem(parsed, scope)
      if (problem !== undefined) return { kind: 'corrupt', reason: problem }
      const index = parsed as MemoryIndex
      cache.set(scope, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, index })
      return { kind: 'ok', index }
    } finally {
      await handle.close()
    }
  }

  /** Caller holds the scope lock, so no other writer can replace the file between the write and the stat. */
  async function writeIndex(scope: ScopeId, index: MemoryIndex): Promise<MemoryIndex> {
    const file = indexPath(scope)
    const written = JSON.parse(await writeJsonAtomic(file, index, { compact: true })) as MemoryIndex
    try {
      const info = await stat(file)
      cache.set(scope, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, index: written })
    } catch (error) {
      cache.delete(scope)
      void error
    }
    return written
  }

  async function mirrorMeta(scope: ScopeId, meta: EpisodeMeta): Promise<void> {
    try {
      await writeJsonAtomic(join(episodeDir(scope, meta.id), META_FILE), meta)
    } catch (error) {
      warn(`memory store: could not write ${META_FILE} for episode ${meta.id} in scope ${scope}`, error)
    }
  }

  /** Rewrite sidecars for derived entries, keeping any unusable `meta.json` as `meta.json.corrupt-<ts>` first. */
  async function healSidecars(scope: ScopeId, derived: readonly EpisodeMeta[]): Promise<void> {
    for (const meta of derived) {
      try {
        await preserveCopy(join(episodeDir(scope, meta.id), META_FILE), `corrupt-${clock.now()}`)
      } catch (error) {
        warn(`memory store: could not keep the unusable ${META_FILE} of episode ${meta.id} in scope ${scope}`, error)
        continue
      }
      await mirrorMeta(scope, meta)
    }
  }

  async function readSidecar(scope: ScopeId, id: string): Promise<EpisodeMeta | undefined> {
    let parsed: unknown
    try {
      const text = await readTextIfExists(join(episodeDir(scope, id), META_FILE))
      if (text === undefined) return undefined
      parsed = JSON.parse(text)
    } catch (error) {
      void error
      return undefined
    }
    if (!isRecord(parsed)) return undefined
    const candidate = { ...parsed, id, scope, dir: episodeRelativeDir(id) }
    return isEpisodeMeta(candidate, scope) ? candidate : undefined
  }

  async function readTierFile(dir: string, tier: Tier): Promise<TierDocument | undefined> {
    const text = await readTextIfExists(join(dir, TIER_FILES[tier]))
    return text === undefined ? undefined : parseTierFile(text)
  }

  async function directoryTime(dir: string): Promise<Millis> {
    try {
      const info = await stat(dir)
      return info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs
    } catch (error) {
      void error
      return clock.now()
    }
  }

  async function deriveEpisode(scope: ScopeId, id: string): Promise<RecoveredEpisode> {
    const dir = episodeDir(scope, id)
    const parsed = assertEpisodeId(id)
    const records = await readRawRecords(join(dir, RAW_FILE))
    const summary = await readTierFile(dir, 'summary')
    const gist = await readTierFile(dir, 'gist')
    const front = summary?.frontmatter ?? gist?.frontmatter
    const first = front?.seq.first ?? records[0]?.seq ?? 0
    const last = front?.seq.last ?? maxSeq(records) ?? first
    const inRange = records.filter(record => record.seq >= first && record.seq <= last)
    const startedAt = front?.time.start ?? inRange[0]?.time ?? await directoryTime(dir)
    const endedAt = front?.time.end ?? inRange.at(-1)?.time
    const summarized = summary?.frontmatter !== undefined && gist?.frontmatter !== undefined
    const tokens: TierTokens = {
      raw: estimator.estimate(inRange.map(record => JSON.stringify(record)).join('\n')),
      ...summary === undefined ? {} : { summary: summary.frontmatter?.tokens ?? estimator.estimate(summary.body) },
      ...gist === undefined ? {} : { gist: gist.frontmatter?.tokens ?? estimator.estimate(gist.body) },
    }
    const meta: EpisodeMeta = {
      id: id as EpisodeId,
      scope,
      sessionId: front?.sessionId ?? parsed.sessionTag,
      dir: episodeRelativeDir(id),
      seqRange: { first, last },
      startedAt,
      ...endedAt === undefined ? {} : { endedAt },
      status: summarized ? 'summarized' : 'sealed',
      tokens,
      importance: front?.importance ?? DEFAULT_IMPORTANCE,
      strength: 1,
      pinned: false,
      hidden: false,
      keywords: front?.keywords ?? [],
      ...summarized && front !== undefined
        ? { summarizer: { provider: front.provider, model: front.model, promptVersion: front.promptVersion, summarizedAt: front.summarizedAt } }
        : {},
    }
    return { meta, derived: true, inferred: front === undefined }
  }

  async function recoverEpisodes(scope: ScopeId, ids: readonly string[]): Promise<RecoveredEpisode[]> {
    const recovered: RecoveredEpisode[] = []
    for (const id of ids) {
      try {
        const sidecar = await readSidecar(scope, id)
        recovered.push(sidecar === undefined ? await deriveEpisode(scope, id) : { meta: sidecar, derived: false, inferred: false })
      } catch (error) {
        warn(`memory store: could not recover episode ${id} in scope ${scope}`, error)
      }
    }
    return recovered
  }

  /**
   * Complete episodes derived from `raw.jsonl` alone: take the session id that
   * a sibling episode or capture watermark with the same session tag names
   * (when exactly one does), and end each where the next episode of its
   * session starts, as {@link closeSuperseded} does for open sidecars, since a
   * split leaves the retained tail in both files.
   */
  async function settleInferred(scope: ScopeId, recovered: readonly RecoveredEpisode[], known: readonly EpisodeMeta[]): Promise<RecoveredEpisode[]> {
    if (!recovered.some(entry => entry.inferred)) return [...recovered]
    const all = [...known, ...recovered.map(entry => entry.meta)]
    const sessionIds = new Set([...known, ...recovered.filter(entry => !entry.inferred).map(entry => entry.meta)].map(meta => meta.sessionId))
    const state = await readStateFile().catch(() => undefined)
    if (state?.kind === 'ok') for (const sessionId of Object.keys(state.state.lastSeq)) sessionIds.add(sessionId)
    const settled: RecoveredEpisode[] = []
    for (const entry of recovered) {
      settled.push(entry.inferred ? { ...entry, meta: await settleEpisode(scope, entry.meta, all, sessionIds) } : entry)
    }
    return settled
  }

  async function settleEpisode(scope: ScopeId, meta: EpisodeMeta, all: readonly EpisodeMeta[], sessionIds: ReadonlySet<string>): Promise<EpisodeMeta> {
    const tag = episodeTag(meta.id)
    const [only, ...others] = [...sessionIds].filter(sessionId => sessionTag(sessionId) === tag)
    const sessionId = only !== undefined && others.length === 0 ? only : meta.sessionId
    let next: EpisodeMeta | undefined
    for (const other of all) {
      if (episodeTag(other.id) !== tag || episodeNumber(other.id) <= episodeNumber(meta.id)) continue
      if (next === undefined || episodeNumber(other.id) < episodeNumber(next.id)) next = other
    }
    const { first, last } = meta.seqRange
    const cap = next === undefined ? last : Math.min(last, next.seqRange.first - 1)
    if (cap === last || cap < first) return sessionId === meta.sessionId ? meta : { ...meta, sessionId }
    const inRange = (await readRawRecords(rawPath(scope, meta.id))).filter(record => record.seq >= first && record.seq <= cap)
    const endedAt = inRange.at(-1)?.time ?? meta.endedAt
    return {
      ...meta,
      sessionId,
      seqRange: { first, last: cap },
      ...endedAt === undefined ? {} : { endedAt },
      tokens: { ...meta.tokens, raw: estimator.estimate(inRange.map(record => JSON.stringify(record)).join('\n')) },
    }
  }

  async function scanEpisodeIds(scope: ScopeId): Promise<string[]> {
    const base = join(scopeDir(scope), 'episodes')
    const ids: string[] = []
    for (const year of await listDirectories(base)) {
      if (!/^\d{4}$/.test(year)) continue
      for (const month of await listDirectories(join(base, year))) {
        if (!/^\d{2}$/.test(month)) continue
        for (const leaf of await listDirectories(join(base, year, month))) {
          const parsed = parseEpisodeId(leaf)
          if (parsed?.year === year && parsed.month === month) ids.push(leaf)
        }
      }
    }
    return ids.sort((left, right) => episodeNumber(left) - episodeNumber(right))
  }

  async function scanRollups(scope: ScopeId): Promise<RollupEntry[]> {
    const byId = new Map<string, RollupEntry>()
    for (const name of await listFiles(join(scopeDir(scope), 'rollups'))) {
      const file = `rollups/${name}`
      if (!isRollupFile(file)) continue
      try {
        const text = await readTextIfExists(join(scopeDir(scope), 'rollups', name))
        const entry = text === undefined ? undefined : parseRollupFile(text).entry
        if (entry === undefined) continue
        const candidate: RollupEntry = { ...entry, scope, file }
        const previous = byId.get(candidate.id)
        if (isRollupEntry(candidate, scope) && (previous === undefined || previous.createdAt < candidate.createdAt)) {
          byId.set(candidate.id, candidate)
        }
      } catch (error) {
        warn(`memory store: could not read rollup ${file} in scope ${scope}`, error)
      }
    }
    return [...byId.values()].sort((left, right) => left.from - right.from)
  }

  /**
   * An `open` sidecar of an episode whose session already has a later episode
   * was left behind by a seal whose index write never landed (the sidecar is
   * written first). Its records end where the next episode starts.
   */
  async function closeSuperseded(scope: ScopeId, meta: EpisodeMeta, episodes: readonly EpisodeMeta[]): Promise<EpisodeMeta | undefined> {
    if (meta.status !== 'open') return undefined
    let next: EpisodeMeta | undefined
    for (const other of episodes) {
      if (other.sessionId !== meta.sessionId || episodeNumber(other.id) <= episodeNumber(meta.id)) continue
      if (next === undefined || episodeNumber(other.id) < episodeNumber(next.id)) next = other
    }
    if (next === undefined) return undefined
    const first = meta.seqRange.first
    const last = next.seqRange.first - 1
    const inRange = (await readRawRecords(rawPath(scope, meta.id))).filter(record => record.seq >= first && record.seq <= last)
    const { owner: _owner, ...rest } = meta as StoredEpisodeMeta
    return {
      ...rest,
      seqRange: { first, last },
      endedAt: inRange.at(-1)?.time ?? meta.startedAt,
      sealReason: 'idle',
      status: 'sealed',
      tokens: { ...meta.tokens, raw: estimator.estimate(inRange.map(record => JSON.stringify(record)).join('\n')) },
    }
  }

  async function rebuildFromDirs(scope: ScopeId): Promise<{ index: MemoryIndex; derived: EpisodeMeta[]; closed: EpisodeMeta[] }> {
    const recovered = await settleInferred(scope, await recoverEpisodes(scope, await scanEpisodeIds(scope)), [])
    const metas = recovered.map(entry => entry.meta)
    const closed: EpisodeMeta[] = []
    const episodes: EpisodeMeta[] = []
    for (const meta of metas) {
      let replacement: EpisodeMeta | undefined
      try {
        replacement = await closeSuperseded(scope, meta, metas)
      } catch (error) {
        warn(`memory store: could not close superseded open episode ${meta.id} in scope ${scope}`, error)
      }
      if (replacement !== undefined) closed.push(replacement)
      episodes.push(replacement ?? meta)
    }
    const index: MemoryIndex = {
      version: 1,
      scope,
      episodes,
      rollups: await scanRollups(scope),
      updatedAt: clock.now(),
    }
    const closedIds = new Set(closed.map(meta => meta.id))
    return { index, derived: recovered.filter(entry => entry.derived && !closedIds.has(entry.meta.id)).map(entry => entry.meta), closed }
  }

  async function mirrorAll(scope: ScopeId, metas: readonly EpisodeMeta[]): Promise<void> {
    for (const meta of metas) await mirrorMeta(scope, meta)
  }

  async function reconcile(scope: ScopeId, index: MemoryIndex): Promise<MemoryIndex> {
    const knownEpisodes = new Set<string>(index.episodes.map(meta => meta.id))
    const knownRollups = new Set(index.rollups.map(entry => entry.id))
    const missingIds = (await scanEpisodeIds(scope)).filter(id => !knownEpisodes.has(id))
    const missingRollups = (await scanRollups(scope)).filter(entry => !knownRollups.has(entry.id))
    if (missingIds.length === 0 && missingRollups.length === 0) return index
    const recovered = await settleInferred(scope, await recoverEpisodes(scope, missingIds), index.episodes)
    const written = await writeIndex(scope, {
      ...index,
      episodes: [...index.episodes, ...recovered.map(entry => entry.meta)],
      rollups: [...index.rollups, ...missingRollups],
      updatedAt: clock.now(),
    })
    await healSidecars(scope, recovered.filter(entry => entry.derived).map(entry => entry.meta))
    warn(`memory store: 已从磁盘补全索引 / Restored missing index entries (${scope}) · 片段 / episodes: ${recovered.length} · 时期总结 / rollups: ${missingRollups.length}`)
    return written
  }

  /** Current index for a writer holding the scope lock: recovers a missing or corrupt file and reconciles once per scope. */
  async function loadIndexLocked(scope: ScopeId): Promise<MemoryIndex> {
    const read = await readIndexFile(scope)
    if (read.kind === 'ok') {
      const index = reconciled.has(scope) ? read.index : await reconcile(scope, read.index)
      reconciled.add(scope)
      return index
    }
    const kept = read.kind === 'corrupt' ? await preserveCopy(indexPath(scope), `corrupt-${clock.now()}`) : undefined
    const { index, derived, closed } = await rebuildFromDirs(scope)
    reconciled.add(scope)
    if (read.kind === 'missing' && index.episodes.length === 0 && index.rollups.length === 0) return index
    await mirrorAll(scope, closed)
    const written = await writeIndex(scope, index)
    await healSidecars(scope, derived)
    const recovered = `已从磁盘重建索引 / Index rebuilt from disk (${scope}) · 片段 / episodes: ${index.episodes.length}`
    warn(read.kind === 'corrupt'
      ? `memory store: 索引已损坏 / Corrupt index (${read.reason}). ${recovered}. ${backupNotice(kept)}`
      : `memory store: 索引缺失 / Missing index. ${recovered}.`)
    return written
  }

  /** Lock-free view used while holding the state lock (state → index lock order is never taken). */
  async function peekIndex(scope: ScopeId): Promise<MemoryIndex> {
    const read = await readIndexFile(scope)
    return read.kind === 'ok' ? read.index : (await rebuildFromDirs(scope)).index
  }

  /** Replace `file`, first keeping a differing previous version as `<file>.prev-<ts>` so derived text is never lost. */
  async function replaceKeepingPrevious(file: string, text: string): Promise<void> {
    const existing = await readTextIfExists(file)
    if (existing !== undefined && existing !== text) await preserveCopy(file, `prev-${clock.now()}`)
    await writeTextAtomic(file, text)
  }

  async function hasStoredData(scope: ScopeId): Promise<boolean> {
    return await pathExists(join(scopeDir(scope), 'episodes')) || await pathExists(join(scopeDir(scope), 'rollups'))
  }

  async function withLock<T>(scope: ScopeId, operation: () => Promise<T>): Promise<T> {
    assertScopeId(scope)
    return withPathLock(indexPath(scope), operation, lockOptions)
  }

  async function readIndex(scope: ScopeId): Promise<MemoryIndex> {
    assertScopeId(scope)
    const read = await readIndexFile(scope)
    if (read.kind === 'ok' && reconciled.has(scope)) return read.index
    if (read.kind === 'missing' && !await hasStoredData(scope)) return emptyIndex(scope)
    return withLock(scope, () => loadIndexLocked(scope))
  }

  async function requireEpisode(scope: ScopeId, id: EpisodeId): Promise<EpisodeMeta> {
    assertScopeId(scope)
    assertEpisodeId(id)
    const meta = (await readIndex(scope)).episodes.find(entry => entry.id === id)
    if (meta === undefined) throw new Error(`memory store: 当前作用域中没有这个片段 / unknown episode ${id} in scope ${scope}`)
    return meta
  }

  async function mutateEpisode(
    scope: ScopeId,
    id: EpisodeId,
    change: (meta: EpisodeMeta) => EpisodeMeta | Promise<EpisodeMeta>,
  ): Promise<EpisodeMeta> {
    assertScopeId(scope)
    assertEpisodeId(id)
    return withLock(scope, async () => {
      const index = await loadIndexLocked(scope)
      const position = index.episodes.findIndex(meta => meta.id === id)
      const current = index.episodes[position]
      if (current === undefined) throw new Error(`memory store: 当前作用域中没有这个片段 / unknown episode ${id} in scope ${scope}`)
      const next = await change(current)
      if (next === current) return current
      if (!isEpisodeMeta(next, scope)) throw new TypeError(`memory store: the update would leave episode ${id} invalid`)
      await mirrorMeta(scope, next)
      const written = await writeIndex(scope, { ...index, episodes: index.episodes.with(position, next), updatedAt: clock.now() })
      return written.episodes[position] ?? next
    })
  }

  async function listScopes(): Promise<readonly ScopeId[]> {
    return (await listDirectories(join(root, 'scopes'))).filter(isValidScopeId).sort()
  }

  async function openEpisode(
    scope: ScopeId,
    init: { readonly sessionId: string; readonly startedAt: Millis; readonly firstSeq: number },
  ): Promise<EpisodeMeta> {
    assertScopeId(scope)
    if (!isString(init.sessionId)) throw new TypeError('memory store: openEpisode needs a string sessionId')
    if (!isFiniteNumber(init.firstSeq)) throw new RangeError(`memory store: invalid firstSeq ${init.firstSeq}`)
    const prefix = stamp(init.startedAt)
    return withLock(scope, async () => {
      const index = await loadIndexLocked(scope)
      const n = 1 + index.episodes.reduce((max, meta) => Math.max(max, episodeNumber(meta.id)), 0)
      const id = formatEpisodeId(prefix, init.sessionId, n)
      const meta: StoredEpisodeMeta = {
        id,
        scope,
        sessionId: init.sessionId,
        dir: episodeRelativeDir(id),
        seqRange: { first: init.firstSeq, last: init.firstSeq },
        startedAt: init.startedAt,
        status: 'open',
        tokens: { raw: 0 },
        importance: DEFAULT_IMPORTANCE,
        strength: 1,
        pinned: false,
        hidden: false,
        keywords: [],
        owner: { pid: owner.pid, startedAt: owner.startedAt },
      }
      await mirrorMeta(scope, meta)
      const written = await writeIndex(scope, { ...index, episodes: [...index.episodes, meta], updatedAt: clock.now() })
      return written.episodes.at(-1) ?? meta
    })
  }

  async function claimEpisode(scope: ScopeId, id: EpisodeId): Promise<EpisodeMeta> {
    return mutateEpisode(scope, id, meta => {
      const current = episodeOwner(meta)
      if (meta.status !== 'open' || (current?.pid === owner.pid && current.startedAt === owner.startedAt)) return meta
      const claimed: StoredEpisodeMeta = { ...meta, owner: { pid: owner.pid, startedAt: owner.startedAt } }
      return claimed
    })
  }

  async function appendRaw(scope: ScopeId, id: EpisodeId, records: readonly RawEventRecord[]): Promise<void> {
    assertScopeId(scope)
    assertEpisodeId(id)
    if (records.length === 0) return
    const lines = records.map((record, position) => {
      if (!isRawEventRecord(record)) throw new TypeError(`memory store: raw record ${position} needs a numeric seq and time and a string type`)
      return JSON.stringify(record)
    })
    const meta = await requireEpisode(scope, id)
    if (meta.status !== 'open') throw new EpisodeNotOpenError(id, meta.status)
    const file = rawPath(scope, id)
    await serialize(resolve(file), () => appendLines(file, lines))
  }

  async function sealEpisode(scope: ScopeId, id: EpisodeId, seal: {
    readonly reason: SealReason
    readonly endedAt: Millis
    readonly lastSeq: number
    readonly rawTokens: number
    readonly shadowedSeqs?: readonly number[]
  }): Promise<EpisodeMeta> {
    if (!isFiniteNumber(seal.endedAt) || !isFiniteNumber(seal.lastSeq) || !isFiniteNumber(seal.rawTokens)) {
      throw new RangeError('memory store: sealEpisode needs finite endedAt, lastSeq and rawTokens')
    }
    return mutateEpisode(scope, id, meta => {
      if (meta.status !== 'open') {
        if (meta.sealReason === seal.reason && meta.seqRange.last === seal.lastSeq) return meta
        throw new Error(`memory store: 片段已结束，本次封存条件与已有记录不同。 / Episode ${id} is already ${meta.status} with different seal parameters.`)
      }
      const { owner: _owner, ...rest } = meta as StoredEpisodeMeta
      return {
        ...rest,
        seqRange: { first: meta.seqRange.first, last: seal.lastSeq },
        endedAt: seal.endedAt,
        sealReason: seal.reason,
        status: 'sealed',
        tokens: { ...meta.tokens, raw: seal.rawTokens },
        ...seal.shadowedSeqs === undefined ? {} : { shadowedSeqs: [...seal.shadowedSeqs] },
      }
    })
  }

  async function writeSummary(
    scope: ScopeId,
    id: EpisodeId,
    result: EpisodeSummaryResult,
    provenance: SummaryProvenance,
    tokens: Required<Omit<TierTokens, 'raw'>>,
  ): Promise<EpisodeMeta> {
    if (!isString(result.summary) || !isString(result.gist) || !isFiniteNumber(result.importance) || !isStringArray(result.keywords)) {
      throw new TypeError('memory store: invalid summary result')
    }
    if (!isFiniteNumber(tokens.summary) || !isFiniteNumber(tokens.gist) || !isFiniteNumber(provenance.summarizedAt)) {
      throw new TypeError('memory store: invalid summary tokens or provenance')
    }
    return mutateEpisode(scope, id, async meta => {
      if (meta.status === 'open') throw new Error(`memory store: 请先封存片段，再写入摘要。 / Episode ${id} is still open. Seal it before writing its summary.`)
      const dir = episodeDir(scope, id)
      const shared = {
        id: meta.id,
        scope,
        sessionId: meta.sessionId,
        seq: meta.seqRange,
        time: meta.endedAt === undefined ? { start: meta.startedAt } : { start: meta.startedAt, end: meta.endedAt },
        provider: provenance.provider,
        model: provenance.model,
        promptVersion: provenance.promptVersion,
        summarizedAt: provenance.summarizedAt,
        importance: result.importance,
        keywords: result.keywords,
      }
      await replaceKeepingPrevious(join(dir, TIER_FILES.summary), renderTierFile({
        ...shared,
        tier: 'summary',
        tokens: tokens.summary,
        people: result.people,
        dates: result.dates,
        promises: result.promises,
        ongoing: result.ongoing,
      }, result.summary))
      await replaceKeepingPrevious(join(dir, TIER_FILES.gist), renderTierFile({ ...shared, tier: 'gist', tokens: tokens.gist }, result.gist))
      const { lastError: _lastError, attempts: _attempts, ...rest } = meta
      return {
        ...rest,
        status: 'summarized',
        tokens: { raw: meta.tokens.raw, summary: tokens.summary, gist: tokens.gist },
        importance: result.importance,
        keywords: [...result.keywords],
        summarizer: {
          provider: provenance.provider,
          model: provenance.model,
          promptVersion: provenance.promptVersion,
          summarizedAt: provenance.summarizedAt,
        },
      }
    })
  }

  async function updateEpisode(scope: ScopeId, id: EpisodeId, patch: EpisodeUpdate): Promise<EpisodeMeta> {
    const fixed = typeof patch === 'function' ? undefined : Object.entries(structuredClone(patch) as Record<string, unknown>)
    return mutateEpisode(scope, id, meta => {
      const changes = fixed ?? Object.entries(structuredClone((patch as (meta: EpisodeMeta) => EpisodeMetaPatch)(meta)) as Record<string, unknown>)
      if (changes.length === 0) return meta
      const next: Record<string, unknown> = { ...meta }
      for (const [key, value] of changes) {
        if (IMMUTABLE_FIELDS.has(key)) continue
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      return next as unknown as EpisodeMeta
    })
  }

  async function readRaw(scope: ScopeId, id: EpisodeId, page: { readonly offset: number; readonly limit: number }): Promise<RawPage> {
    const meta = await requireEpisode(scope, id)
    const records = await readRawCached(rawPath(scope, id))
    const { first, last } = meta.seqRange
    const visible = meta.status === 'open' ? records : records.filter(record => record.seq >= first && record.seq <= last)
    const offset = clampCount(page.offset)
    const limit = clampCount(page.limit)
    return { records: visible.slice(offset, offset + limit), offset, total: visible.length }
  }

  /**
   * Parsed `raw.jsonl`, re-reading only the bytes appended since the last call
   * (the file is append-only). A trailing line without its newline is returned
   * but not cached, since its writer may still be completing it.
   */
  async function readRawCached(file: string): Promise<readonly RawEventRecord[]> {
    let handle: FileHandle
    try {
      handle = await open(file, 'r')
    } catch (error) {
      if (!isNotFound(error)) throw error
      rawCache.delete(file)
      return []
    }
    try {
      const info = await handle.stat()
      const cached = rawCache.get(file)
      const base = cached !== undefined && cached.ino === info.ino && cached.offset <= info.size ? cached : undefined
      const start = base?.offset ?? 0
      rawCache.delete(file)
      if (base !== undefined && info.size === start) {
        rawCache.set(file, base)
        return base.records
      }
      const buffer = Buffer.alloc(info.size - start)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      const chunk = buffer.subarray(0, bytesRead)
      const complete = chunk.lastIndexOf(0x0a) + 1
      const records = [...base?.records ?? []]
      const seen = new Set(base?.seen)
      parseRawLines(chunk.subarray(0, complete).toString('utf8'), records, seen)
      rawCache.set(file, { ino: info.ino, offset: start + complete, records, seen })
      for (const key of rawCache.keys()) {
        if (rawCache.size <= RAW_CACHE_LIMIT) break
        rawCache.delete(key)
      }
      if (complete === chunk.length) return records
      const withTail = [...records]
      parseRawLines(chunk.subarray(complete).toString('utf8'), withTail, new Set(seen))
      return withTail
    } finally {
      await handle.close()
    }
  }

  async function readTierDocument(scope: ScopeId, id: EpisodeId, tier: Tier): Promise<TierDocument | undefined> {
    assertScopeId(scope)
    assertEpisodeId(id)
    if (tier !== 'summary' && tier !== 'gist') throw new TypeError(`memory store: unknown tier ${JSON.stringify(tier)}`)
    return readTierFile(episodeDir(scope, id), tier)
  }

  async function readTier(scope: ScopeId, id: EpisodeId, tier: Tier): Promise<string | undefined> {
    return (await readTierDocument(scope, id, tier))?.body
  }

  async function writeRollup(scope: ScopeId, entry: RollupEntry, text: string): Promise<void> {
    assertScopeId(scope)
    const label = JSON.stringify(entry.id)
    if (entry.scope !== scope) throw new TypeError(`memory store: 时期总结的作用域与写入目标不符。 / Rollup ${label} belongs to scope ${entry.scope}. Write target: ${scope}.`)
    if (!isRollupEntry(entry, scope)) throw new TypeError(`memory store: invalid rollup entry ${label}`)
    if (!isString(text)) throw new TypeError('memory store: rollup text must be a string')
    const stored = structuredClone(entry)
    await withLock(scope, async () => {
      const index = await loadIndexLocked(scope)
      const clash = index.rollups.find(existing => existing.file === stored.file && existing.id !== stored.id)
      if (clash !== undefined) throw new Error(`memory store: 两份时期总结使用同一文件名，本次写入已停止。 / ${stored.file} already holds rollup ${clash.id}. Write stopped.`)
      await replaceKeepingPrevious(join(scopeDir(scope), ...stored.file.split('/')), renderRollupFile(stored, text))
      const position = index.rollups.findIndex(existing => existing.id === stored.id)
      const rollups = position < 0 ? [...index.rollups, stored] : index.rollups.with(position, stored)
      await writeIndex(scope, { ...index, rollups, updatedAt: clock.now() })
    })
  }

  async function readRollup(scope: ScopeId, id: string): Promise<string | undefined> {
    const entry = (await readIndex(scope)).rollups.find(rollup => rollup.id === id)
    if (entry === undefined) return undefined
    const text = await readTextIfExists(join(scopeDir(scope), ...entry.file.split('/')))
    return text === undefined ? undefined : parseRollupFile(text).body
  }

  /** Never overwrites: a different text for the same ref lands in `<sid>-<n>.<k>.md`. */
  async function writeSnapshot(scope: ScopeId, ref: { readonly sessionId: string; readonly n: number }, text: string): Promise<string> {
    assertScopeId(scope)
    if (!isString(ref.sessionId)) throw new TypeError('memory store: snapshot needs a string sessionId')
    if (!Number.isSafeInteger(ref.n) || ref.n < 0) throw new RangeError(`memory store: invalid snapshot number ${ref.n}`)
    if (!isString(text)) throw new TypeError('memory store: snapshot text must be a string')
    const stem = `${safeFileStem(ref.sessionId)}-${ref.n}`
    const dir = join(scopeDir(scope), 'snapshots')
    return withPathLock(join(dir, `${stem}.md`), async () => {
      for (let variant = 0; variant < MAX_SNAPSHOT_VARIANTS; variant += 1) {
        const name = variant === 0 ? `${stem}.md` : `${stem}.${variant}.md`
        const existing = await readTextIfExists(join(dir, name))
        if (existing === undefined) await writeTextAtomic(join(dir, name), text)
        if (existing === undefined || existing === text) return `snapshots/${name}`
      }
      throw new Error(`memory store: too many snapshot variants for ${stem}`)
    }, lockOptions)
  }

  async function readProfile(scope: ScopeId): Promise<string | undefined> {
    assertScopeId(scope)
    return readTextIfExists(join(scopeDir(scope), PROFILE_FILE))
  }

  async function readStateFile(): Promise<StateRead> {
    const text = await readTextIfExists(statePath)
    if (text === undefined) return { kind: 'missing' }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return { kind: 'corrupt', reason: `invalid JSON: ${errorMessage(error)}` }
    }
    return isStoreState(parsed) ? { kind: 'ok', state: parsed } : { kind: 'corrupt', reason: 'unexpected shape' }
  }

  /**
   * Watermarks are always recoverable from the indexes. The summary queue is
   * re-derived only for a corrupt file: a missing file is the first-run case,
   * where deriving jobs would duplicate ones the caller is about to enqueue.
   */
  async function deriveState(withQueue: boolean): Promise<StoreState> {
    const lastSeq: Record<string, number> = {}
    const queue: QueuedJob[] = []
    const now = clock.now()
    for (const scope of await listScopes()) {
      let index: MemoryIndex
      try {
        index = await peekIndex(scope)
      } catch (error) {
        warn(`memory store: could not read the index of scope ${scope} while rebuilding state`, error)
        continue
      }
      for (const meta of index.episodes) {
        const last = meta.status === 'open' ? maxSeq(await readRawRecords(rawPath(scope, meta.id))) : meta.seqRange.last
        if (last !== undefined && last > (lastSeq[meta.sessionId] ?? -Infinity)) lastSeq[meta.sessionId] = last
        if (withQueue && (meta.status === 'sealed' || meta.status === 'failed')) {
          queue.push({ kind: 'summarize', scope, episode: meta.id, notBefore: now, attempts: meta.attempts ?? 0 })
        }
      }
    }
    return { version: 1, lastSeq, queue }
  }

  async function readState(): Promise<StoreState> {
    const read = await readStateFile()
    return read.kind === 'ok' ? read.state : deriveState(read.kind === 'corrupt')
  }

  async function updateState(change: (state: StoreState) => StoreState): Promise<StoreState> {
    if (typeof change !== 'function') throw new TypeError('memory store: updateState needs a change function')
    return withPathLock(statePath, async () => {
      const read = await readStateFile()
      let current: StoreState
      if (read.kind === 'ok') {
        current = read.state
      } else {
        if (read.kind === 'corrupt') {
          const kept = await preserveCopy(statePath, `corrupt-${clock.now()}`)
          warn(`memory store: 状态文件已损坏，将从索引重建。 / Rebuilding corrupt ${STATE_FILE} from the indexes (${read.reason}). ${backupNotice(kept)}`)
        }
        current = await deriveState(read.kind === 'corrupt')
      }
      const next = change(current)
      if (!isStoreState(next)) throw new TypeError('memory store: updateState change returned an invalid state')
      return JSON.parse(await writeJsonAtomic(statePath, next)) as StoreState
    }, lockOptions)
  }

  async function rebuildIndex(scope: ScopeId): Promise<MemoryIndex> {
    return withLock(scope, async () => {
      await preserveCopy(indexPath(scope), `prev-${clock.now()}`)
      const { index, derived, closed } = await rebuildFromDirs(scope)
      await mirrorAll(scope, closed)
      const written = await writeIndex(scope, index)
      await healSidecars(scope, derived)
      reconciled.add(scope)
      return written
    })
  }

  return {
    root,
    listScopes,
    readIndex,
    openEpisode,
    appendRaw,
    sealEpisode,
    writeSummary,
    updateEpisode,
    readRaw,
    readTier,
    readTierDocument,
    writeRollup,
    readRollup,
    writeSnapshot,
    readProfile,
    readState,
    updateState,
    withLock,
    rebuildIndex,
    claimEpisode,
  }
}

function backupNotice(kept: string | undefined): string {
  return kept === undefined
    ? '备份时已找不到原文件。 / Original file missing at backup time.'
    : `原文件备份 / Original file backup: ${kept}`
}

function episodeNumber(id: string): number {
  return parseEpisodeId(id)?.n ?? 0
}

function episodeTag(id: string): string | undefined {
  return parseEpisodeId(id)?.sessionTag
}

function clampCount(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.floor(Math.min(value, Number.MAX_SAFE_INTEGER)))
}

function maxSeq(records: readonly RawEventRecord[]): number | undefined {
  let max: number | undefined
  for (const record of records) if (max === undefined || record.seq > max) max = record.seq
  return max
}

/** Parse `raw.jsonl`, skipping torn or foreign lines and repeated seqs (a retried append). */
async function readRawRecords(file: string): Promise<RawEventRecord[]> {
  const text = await readTextIfExists(file)
  if (text === undefined) return []
  const records: RawEventRecord[] = []
  parseRawLines(text, records, new Set<number>())
  return records
}

function parseRawLines(text: string, records: RawEventRecord[], seen: Set<number>): void {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRawEventRecord(value) || seen.has(value.seq)) continue
    seen.add(value.seq)
    records.push(value)
  }
}

function createFallbackEstimator(): TokenEstimator {
  const { cjkWeight, otherWeight, safetyMargin } = DEFAULT_TOKEN_ESTIMATOR_OPTIONS
  return {
    estimate(text) {
      let cjk = 0
      let other = 0
      for (const char of text) {
        if (CJK.test(char)) cjk += 1
        else other += 1
      }
      return Math.ceil((cjk * cjkWeight + other * otherWeight) * safetyMargin)
    },
  }
}
