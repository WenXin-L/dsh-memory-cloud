import type {
  Clock,
  EpisodeId,
  EpisodeMeta,
  MemoryStore,
  Millis,
  RawEventRecord,
  ScopeDecision,
  ScopeId,
  SealReason,
  SessionDescriptor,
  TokenEstimator,
} from '../contracts.ts'
import type { FileMemoryStore } from '../store/file-store.ts'
import { isEpisodeNotOpenError, isOwnedByLiveForeignProcess } from '../store/owner.ts'
import { isExcludedRecord, isMessageRecord, isSyntheticRecord, readShadowedSeqs, recordText, stripReasoning } from './records.ts'

export type CaptureStore = Pick<MemoryStore, 'listScopes' | 'readIndex' | 'openEpisode' | 'appendRaw' | 'sealEpisode' | 'readRaw' | 'readState' | 'updateState'> & Pick<FileMemoryStore, 'claimEpisode'>

/**
 * Read on every use, so an object with getters over volatile config values
 * applies setting changes live.
 */
export interface CaptureOptions {
  readonly idleMinutes: number
  /** `0` disables size sealing. */
  readonly maxEpisodeTokens: number
  readonly captureReasoning: boolean
  /** Upper bound on how long appended records stay buffered in memory; default 2000 ms. */
  readonly flushDelayMs?: number
}

export interface CaptureLogger {
  warn(message: string, ...args: unknown[]): void
}

export interface CaptureDeps {
  readonly store: CaptureStore
  readonly estimator: TokenEstimator
  readonly clock: Clock
  /**
   * Re-run when a session is first seen, at every `turn/start`, and whenever
   * the session's descriptor object changes, so volatile scope rules apply
   * from the next turn on.
   */
  readonly resolveScope: (session: SessionDescriptor) => ScopeDecision
  /** Called once per sealed non-empty episode, e.g. to enqueue summarization. Errors are logged; a returned promise is awaited by `settle`/`flush`/`dispose`. */
  readonly onSealed: (scope: ScopeId, meta: EpisodeMeta) => void | Promise<void>
  readonly options: CaptureOptions
  readonly logger?: CaptureLogger
}

export interface Capture {
  /** Queue one session event; never throws and never blocks the caller. */
  handleEvent(session: SessionDescriptor, event: RawEventRecord): void
  /** Write the session's buffered records now (coalesced with an already queued write). */
  flushSession(sessionId: string): Promise<void>
  /**
   * Seal open episodes of sessions idle for at least `idleMinutes`, skipping
   * sessions inside a turn, and retry failed end seals. At most every five
   * minutes it also runs {@link sealStale}, so episodes a crashed process left
   * open are sealed once they are old enough, not only at startup.
   */
  sealIdle(now?: Millis): Promise<void>
  /** Seal the session's open episode; `'end'` also forgets the session (use on `session/disposed`). */
  sealSession(sessionId: string, reason?: Exclude<SealReason, 'compaction' | 'size'>): Promise<void>
  /**
   * Flush and seal the session's open episode (reason `end`) and forget its
   * cached scope decision, so its next event resolves the scope again. Use
   * when what decides the session's scope (tags, rules) changed.
   */
  rescope(sessionId: string): Promise<void>
  /**
   * Seal `open` episodes in the store that no live session of this process
   * owns, whose recorded owner process is not still running, and whose last
   * record is older than `olderThanMs` (default `idleMinutes`). Recovers
   * episodes left open by a crash or an unload. Call it at startup;
   * `sealIdle` repeats it. Overlapping calls share one sweep.
   */
  sealStale(now?: Millis, olderThanMs?: number): Promise<void>
  /** Write every session's buffered records and wait for all queued work, including pending `onSealed` callbacks. */
  flush(): Promise<void>
  /** Wait for queued work and pending `onSealed` callbacks without forcing buffered records out. */
  settle(): Promise<void>
  /**
   * Stop accepting events and timers, then write every buffered record (also
   * trailing non-message events, so a restart adopts them) and wait for
   * pending `onSealed` callbacks and the stale sweep, so no store write is cut
   * short by a process exit. Open episodes stay open and are adopted after a restart.
   */
  dispose(): Promise<void>
}

interface Episode {
  readonly scope: ScopeId
  id: EpisodeId | undefined
  readonly records: RawEventRecord[]
  readonly tokens: number[]
  totalTokens: number
  messages: number
  persisted: number
}

/** A seal of the open episode at `cutSeq`, kept until it succeeds. */
interface PendingSeal {
  readonly cutSeq: number
  readonly reason: SealReason
  readonly shadowedSeqs?: readonly number[]
}

interface SessionState {
  readonly sessionId: string
  readonly decision: ScopeDecision | undefined
  descriptor: SessionDescriptor
  episode: Episode | undefined
  readonly seals: PendingSeal[]
  lastSeq: number
  watermark: number
  lastActivity: Millis
  turnOpen: boolean
  queue: Promise<void>
  timer: ReturnType<typeof setTimeout> | undefined
  flushQueued: boolean
}

const DEFAULT_FLUSH_DELAY_MS = 2000
const RAW_PAGE_SIZE = 500
const SEAL_ATTEMPTS = 2
const STALE_SWEEP_INTERVAL_MS = 5 * 60_000

function sum(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  return total
}

function findLastIndex<T>(items: readonly T[], before: number, predicate: (item: T) => boolean): number {
  for (let index = Math.min(before, items.length - 1); index >= 0; index--) {
    if (predicate(items[index] as T)) return index
  }
  return -1
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameScope(left: ScopeDecision | undefined, right: ScopeDecision | undefined): boolean {
  return left === undefined || right === undefined ? left === right : left.scope === right.scope
}

export function createCapture(deps: CaptureDeps): Capture {
  const { store, estimator, clock, options } = deps
  const logger: CaptureLogger = deps.logger ?? console
  const sessions = new Map<string, SessionState>()
  const retiring = new Map<string, Promise<void>>()
  /** Forgotten sessions whose final seal failed; retried by `sealIdle`, `flush` and `dispose`. */
  const stranded = new Set<SessionState>()
  /** Pending `onSealed` work (store writes such as queueing a summary), awaited like queued capture work. */
  const callbacks = new Set<Promise<void>>()
  /** Whether a session was inside a turn when a rescope retired it, for the state that replaces it. */
  const carriedTurns = new Map<string, boolean>()
  let sweeping: Promise<void> | undefined
  let lastSweep: Millis | undefined
  let disposed = false

  function warn(message: string, error?: unknown): void {
    try {
      if (error === undefined) logger.warn(`memory-cloud capture: ${message}`)
      else logger.warn(`memory-cloud capture: ${message}: ${errorText(error)}`)
    } catch {}
  }

  function enqueue(state: SessionState, label: string, operation: () => Promise<void> | void): Promise<void> {
    const next = state.queue.then(operation).catch((error: unknown) => warn(`${label} failed for session ${state.sessionId}`, error))
    state.queue = next
    return next
  }

  function estimate(record: RawEventRecord): number {
    const text = recordText(record)
    if (text === '') return 0
    try {
      return Math.max(0, estimator.estimate(text))
    } catch (error) {
      warn('token estimate failed', error)
      return Math.ceil(text.length / 4)
    }
  }

  function createEpisode(scope: ScopeId, records: readonly RawEventRecord[] = [], tokens?: readonly number[], id?: EpisodeId): Episode {
    const counted = tokens ?? records.map(estimate)
    return {
      scope,
      id,
      records: [...records],
      tokens: [...counted],
      totalTokens: sum(counted),
      messages: records.filter(isMessageRecord).length,
      persisted: id === undefined ? 0 : records.length,
    }
  }

  function push(episode: Episode, record: RawEventRecord): void {
    const tokens = estimate(record)
    episode.records.push(record)
    episode.tokens.push(tokens)
    episode.totalTokens += tokens
    if (isMessageRecord(record)) episode.messages++
  }

  function notifySealed(scope: ScopeId, meta: EpisodeMeta): void {
    try {
      const returned: unknown = deps.onSealed(scope, meta)
      if (isPromiseLike(returned)) {
        const settled = Promise.resolve(returned).then<void, void>(() => {}, (error: unknown) => warn(`onSealed failed for ${meta.id}`, error))
        callbacks.add(settled)
        void settled.finally(() => callbacks.delete(settled))
      }
    } catch (error) {
      warn(`onSealed failed for ${meta.id}`, error)
    }
  }

  function clearTimer(state: SessionState): void {
    if (state.timer === undefined) return
    clearTimeout(state.timer)
    state.timer = undefined
  }

  function scheduleFlush(state: SessionState): void {
    if (disposed || state.timer !== undefined) return
    const delay = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS
    const timer = setTimeout(() => {
      state.timer = undefined
      void flushState(state)
    }, delay)
    ;(timer as { unref?: () => void }).unref?.()
    state.timer = timer
  }

  function flushState(state: SessionState): Promise<void> {
    if (state.flushQueued) return state.queue
    state.flushQueued = true
    return enqueue(state, 'flush', () => persist(state))
  }

  async function writeWatermark(state: SessionState, seq: number): Promise<void> {
    if (seq <= state.watermark) return
    try {
      await store.updateState((current) => {
        const previous = current.lastSeq[state.sessionId]
        if (previous !== undefined && previous >= seq) return current
        return { ...current, lastSeq: { ...current.lastSeq, [state.sessionId]: seq } }
      })
      state.watermark = seq
    } catch (error) {
      warn(`failed to record capture watermark for session ${state.sessionId}`, error)
    }
  }

  async function ensureOpened(state: SessionState, episode: Episode): Promise<EpisodeId> {
    if (episode.id !== undefined) return episode.id
    const first = episode.records[0]
    if (first === undefined) throw new Error('cannot open an episode without records')
    const meta = await store.openEpisode(episode.scope, { sessionId: state.sessionId, startedAt: first.time, firstSeq: first.seq })
    episode.id = meta.id
    return meta.id
  }

  async function appendUpTo(state: SessionState, episode: Episode, end: number): Promise<void> {
    if (episode.persisted >= end) return
    const id = await ensureOpened(state, episode)
    await store.appendRaw(episode.scope, id, episode.records.slice(episode.persisted, end))
    episode.persisted = end
  }

  async function storedMeta(episode: Episode): Promise<EpisodeMeta | undefined> {
    return (await store.readIndex(episode.scope)).episodes.find(meta => meta.id === episode.id)
  }

  /**
   * `episode` is no longer open in the store (another process sealed it).
   * Records the stored episode covers are dropped; later ones continue in a
   * fresh episode that is opened on the next write.
   */
  function rebase(state: SessionState, episode: Episode, current: EpisodeMeta | undefined): void {
    const covered = current?.seqRange.last ?? -Infinity
    warn(`episode ${episode.id ?? '(unopened)'} is no longer open (${current?.status ?? 'missing'}); continuing after seq ${covered} in a new episode`)
    if (state.episode !== episode) return
    const start = episode.records.findIndex(record => record.seq > covered)
    state.episode = start < 0 ? undefined : createEpisode(episode.scope, episode.records.slice(start), episode.tokens.slice(start))
  }

  /**
   * Seal the records up to `seal.cutSeq` of the open episode; later records
   * (if any) continue as a new open episode in the same scope. Write, seal,
   * and only then swap, so a failure keeps the whole episode in memory.
   * Records of the new episode that were already written to the sealed one
   * are written again, because `raw.jsonl` is append-only; the sealed
   * `seqRange` tells them apart.
   */
  async function sealUpTo(state: SessionState, seal: PendingSeal): Promise<void> {
    for (let attempt = 1; attempt <= SEAL_ATTEMPTS; attempt++) {
      const episode = state.episode
      if (episode === undefined) return
      const cut = findLastIndex(episode.records, episode.records.length - 1, record => record.seq <= seal.cutSeq)
      const head = episode.records.slice(0, cut + 1)
      const last = head.at(-1)
      if (last === undefined || !head.some(isMessageRecord)) return
      try {
        await appendUpTo(state, episode, cut + 1)
        const current = await storedMeta(episode)
        if (current?.status !== 'open') {
          rebase(state, episode, current)
          continue
        }
        const meta = await store.sealEpisode(episode.scope, current.id, {
          reason: seal.reason,
          endedAt: last.time,
          lastSeq: last.seq,
          rawTokens: sum(episode.tokens.slice(0, cut + 1)),
          ...seal.shadowedSeqs === undefined ? {} : { shadowedSeqs: [...seal.shadowedSeqs] },
        })
        if (state.episode === episode) {
          state.episode = cut + 1 < episode.records.length
            ? createEpisode(episode.scope, episode.records.slice(cut + 1), episode.tokens.slice(cut + 1))
            : undefined
        }
        await writeWatermark(state, last.seq)
        notifySealed(episode.scope, meta)
        return
      } catch (error) {
        if (!isEpisodeNotOpenError(error) || attempt === SEAL_ATTEMPTS) throw error
        rebase(state, episode, await storedMeta(episode))
      }
    }
  }

  /** Run pending seals in order; on a failure the rest stay pending and the episode stays whole. */
  async function drainSeals(state: SessionState): Promise<boolean> {
    for (let seal = state.seals[0]; seal !== undefined; seal = state.seals[0]) {
      try {
        await sealUpTo(state, seal)
      } catch (error) {
        warn(`failed to seal ${seal.reason} episode ${state.episode?.id ?? '(unopened)'} of session ${state.sessionId}`, error)
        return false
      }
      state.seals.shift()
    }
    return true
  }

  /** Repeated non-compaction seal requests while one is failing merge into one at the later cut. */
  async function split(state: SessionState, seal: PendingSeal): Promise<boolean> {
    const previous = state.seals.at(-1)
    if (previous !== undefined && previous.reason === seal.reason && seal.reason !== 'compaction') {
      state.seals[state.seals.length - 1] = { ...previous, cutSeq: Math.max(previous.cutSeq, seal.cutSeq) }
    } else {
      state.seals.push(seal)
    }
    return drainSeals(state)
  }

  async function persist(state: SessionState, mode: { readonly mark?: boolean; readonly includeEmpty?: boolean } = {}): Promise<void> {
    state.flushQueued = false
    clearTimer(state)
    await drainSeals(state)
    for (let attempt = 1; ; attempt++) {
      const episode = state.episode
      if (episode === undefined || episode.records.length === 0) return
      if (episode.messages === 0 && (mode.includeEmpty !== true || episode.persisted >= episode.records.length)) return
      try {
        await appendUpTo(state, episode, episode.records.length)
      } catch (error) {
        if (!isEpisodeNotOpenError(error) || attempt === SEAL_ATTEMPTS) throw error
        rebase(state, episode, await storedMeta(episode))
        continue
      }
      const last = episode.records.at(-1)
      if (mode.mark === true && last !== undefined) await writeWatermark(state, last.seq)
      return
    }
  }

  async function sealForCompaction(state: SessionState, shadowed: readonly number[]): Promise<void> {
    const episode = state.episode
    if (episode === undefined || shadowed.length === 0) return
    const real = new Set<number>()
    for (const record of episode.records) if (!isSyntheticRecord(record)) real.add(record.seq)
    let lastSeq = -1
    for (const seq of shadowed) if (real.has(seq) && seq > lastSeq) lastSeq = seq
    if (lastSeq < 0) return
    await split(state, { cutSeq: lastSeq, reason: 'compaction', shadowedSeqs: shadowed })
  }

  function headHasMessage(episode: Episode, cut: number): boolean {
    for (let index = 0; index <= cut; index++) {
      if (isMessageRecord(episode.records[index] as RawEventRecord)) return true
    }
    return false
  }

  async function sealForSize(state: SessionState): Promise<void> {
    const episode = state.episode
    if (episode === undefined) return
    const lastIndex = episode.records.length - 1
    const candidates = [
      episode.records[lastIndex]?.type === 'turn/end' ? lastIndex : findLastIndex(episode.records, lastIndex - 1, record => record.type === 'turn/end'),
      findLastIndex(episode.records, lastIndex - 1, record => record.type === 'step/end'),
      lastIndex,
    ]
    const cut = candidates.find(index => index >= 0 && headHasMessage(episode, index))
    const record = cut === undefined ? undefined : episode.records[cut]
    if (record !== undefined) await split(state, { cutSeq: record.seq, reason: 'size' })
  }

  async function sealAll(state: SessionState, reason: SealReason): Promise<boolean> {
    const last = state.episode?.records.at(-1)
    if (state.episode === undefined || state.episode.messages === 0 || last === undefined) return drainSeals(state)
    return split(state, { cutSeq: last.seq, reason })
  }

  async function readAllRaw(scope: ScopeId, id: EpisodeId): Promise<RawEventRecord[]> {
    const records: RawEventRecord[] = []
    for (;;) {
      const page = await store.readRaw(scope, id, { offset: records.length, limit: RAW_PAGE_SIZE })
      records.push(...page.records)
      if (page.records.length === 0 || records.length >= page.total) return records
    }
  }

  async function initialize(state: SessionState): Promise<void> {
    try {
      const stored = (await store.readState()).lastSeq[state.sessionId]
      if (typeof stored === 'number') {
        state.watermark = stored
        state.lastSeq = Math.max(state.lastSeq, stored)
      }
    } catch (error) {
      warn(`failed to read capture watermark for session ${state.sessionId}`, error)
    }
    if (sweeping !== undefined) await sweeping
    await takeOverStranded(state)
    await adopt(state)
    const carried = carriedTurns.get(state.sessionId)
    if (carried !== undefined) {
      carriedTurns.delete(state.sessionId)
      state.turnOpen = carried
    }
  }

  /**
   * A forgotten state of this session in the same scope whose final seal
   * failed still holds the open episode with records it has not written yet.
   * Continue from it rather than adopting the stored part of that episode, so
   * its pending seals run here and none of its records are dropped.
   */
  async function takeOverStranded(state: SessionState): Promise<void> {
    for (const previous of [...stranded]) {
      if (previous.sessionId !== state.sessionId || !sameScope(previous.decision, state.decision)) continue
      stranded.delete(previous)
      await previous.queue
      if (previous.episode === undefined) continue
      state.episode = previous.episode
      state.seals.push(...previous.seals.splice(0))
      state.lastSeq = Math.max(state.lastSeq, previous.lastSeq)
      state.lastActivity = previous.lastActivity
      previous.episode = undefined
      return
    }
  }

  /** Record this process as the owner of an adopted episode; on failure the previous owner stays recorded. */
  async function claim(scope: ScopeId, meta: EpisodeMeta): Promise<EpisodeMeta> {
    try {
      return await store.claimEpisode(scope, meta.id)
    } catch (error) {
      warn(`failed to claim episode ${meta.id}`, error)
      return meta
    }
  }

  /** Adopt the session's open episode in its scope (left by an earlier process) and skip seqs its sealed episodes cover. */
  async function adopt(state: SessionState): Promise<void> {
    const decision = state.decision
    if (decision === undefined) return
    try {
      const index = await store.readIndex(decision.scope)
      let latest: EpisodeMeta | undefined
      for (const meta of index.episodes) {
        if (meta.sessionId !== state.sessionId) continue
        if (meta.status !== 'open') state.lastSeq = Math.max(state.lastSeq, meta.seqRange.last)
        else if (latest === undefined || meta.seqRange.first > latest.seqRange.first) latest = meta
      }
      if (latest === undefined || state.episode !== undefined) return
      const claimed = await claim(decision.scope, latest)
      if (claimed.status !== 'open') {
        state.lastSeq = Math.max(state.lastSeq, claimed.seqRange.last)
        return
      }
      const records = await readAllRaw(decision.scope, latest.id)
      state.episode = createEpisode(decision.scope, records, undefined, latest.id)
      const last = records.at(-1)
      if (last !== undefined) {
        state.lastSeq = Math.max(state.lastSeq, last.seq)
        state.lastActivity = last.time
      }
      const turnStart = records.findLastIndex(record => record.type === 'turn/start')
      state.turnOpen = turnStart >= 0 && turnStart > records.findLastIndex(record => record.type === 'turn/end')
    } catch (error) {
      warn(`failed to adopt the open episode of session ${state.sessionId}`, error)
    }
  }

  async function process(state: SessionState, record: RawEventRecord): Promise<void> {
    const decision = state.decision
    if (decision === undefined || record.seq <= state.lastSeq) return
    state.lastSeq = record.seq
    if (isExcludedRecord(record)) return
    const stored = options.captureReasoning ? record : stripReasoning(record)
    state.lastActivity = Math.max(state.lastActivity, record.time)
    if (record.type === 'turn/start') state.turnOpen = true
    else if (record.type === 'turn/end') state.turnOpen = false

    if (record.type === 'compaction/summary') {
      await sealForCompaction(state, readShadowedSeqs(record))
      push(state.episode ??= createEpisode(decision.scope), stored)
      scheduleFlush(state)
      return
    }

    const episode = state.episode ??= createEpisode(decision.scope)
    push(episode, stored)
    const maxTokens = options.maxEpisodeTokens
    if (maxTokens > 0 && episode.messages > 0 && episode.totalTokens > maxTokens) {
      await sealForSize(state)
      if (state.episode === undefined) return
    }
    if (record.type === 'turn/end') await persist(state, { mark: true })
    else scheduleFlush(state)
  }

  function resolve(session: SessionDescriptor): { readonly ok: boolean; readonly decision?: ScopeDecision } {
    try {
      const resolved = deps.resolveScope(session)
      return resolved.capture ? { ok: true, decision: resolved } : { ok: true }
    } catch (error) {
      warn(`scope resolution failed for session ${session.sessionId}`, error)
      return { ok: false }
    }
  }

  function createState(session: SessionDescriptor): SessionState | undefined {
    const resolved = resolve(session)
    if (!resolved.ok) return undefined
    const state: SessionState = {
      sessionId: session.sessionId,
      decision: resolved.decision,
      descriptor: session,
      episode: undefined,
      seals: [],
      lastSeq: -1,
      watermark: -1,
      lastActivity: clock.now(),
      turnOpen: false,
      queue: retiring.get(session.sessionId) ?? Promise.resolve(),
      timer: undefined,
      flushQueued: false,
    }
    sessions.set(session.sessionId, state)
    if (state.decision !== undefined) void enqueue(state, 'initialize', () => initialize(state))
    return state
  }

  /** Whether the session's scope resolves differently now; resolution errors keep the current decision. */
  function scopeChanged(state: SessionState, session: SessionDescriptor): boolean {
    state.descriptor = session
    const resolved = resolve(session)
    return resolved.ok && !sameScope(state.decision, resolved.decision)
  }

  /**
   * Forget the session, then flush and seal its episode; a failed seal leaves
   * it stranded for a later retry. With `carryTurn` (a rescope, not the end of
   * the session) the state that replaces it learns whether a turn is open.
   */
  async function retire(state: SessionState, reason: SealReason, carryTurn: boolean): Promise<void> {
    const { sessionId } = state
    if (sessions.get(sessionId) === state) sessions.delete(sessionId)
    const done = enqueue(state, `${reason} seal`, async () => {
      clearTimer(state)
      if (carryTurn && state.decision !== undefined) carriedTurns.set(sessionId, state.turnOpen)
      else carriedTurns.delete(sessionId)
      if (state.decision === undefined) return
      if (await sealAll(state, reason)) {
        stranded.delete(state)
        state.episode = undefined
      } else {
        stranded.add(state)
      }
    })
    retiring.set(sessionId, done)
    await done
    if (retiring.get(sessionId) === done) retiring.delete(sessionId)
  }

  function retryStranded(): Promise<void>[] {
    return [...stranded].map(state => enqueue(state, 'end seal retry', async () => {
      if (await drainSeals(state)) {
        stranded.delete(state)
        state.episode = undefined
      }
    }))
  }

  /** Wait for queued session work, retiring seals, the stale sweep, and the `onSealed` work they started. */
  async function liveQueues(): Promise<void> {
    for (let round = 0; round < 8; round++) {
      const pending = [
        ...[...sessions.values()].map(state => state.queue),
        ...[...stranded].map(state => state.queue),
        ...retiring.values(),
        ...callbacks,
        ...sweeping === undefined ? [] : [sweeping],
      ]
      await Promise.all(pending)
      if (callbacks.size === 0) return
    }
  }

  async function sweep(now: Millis, olderThanMs: number): Promise<void> {
    const owned = (sessionId: string) => sessions.has(sessionId)
      || retiring.has(sessionId)
      || [...stranded].some(state => state.sessionId === sessionId)
    for (const scope of await store.listScopes()) {
      let episodes: readonly EpisodeMeta[]
      try {
        episodes = (await store.readIndex(scope)).episodes
      } catch (error) {
        warn(`failed to read index of scope ${scope}`, error)
        continue
      }
      for (const meta of episodes) {
        if (meta.status !== 'open' || owned(meta.sessionId) || isOwnedByLiveForeignProcess(meta)) continue
        try {
          const records = await readAllRaw(scope, meta.id)
          const last = records.at(-1)
          const endedAt = last?.time ?? meta.startedAt
          if (now - endedAt < olderThanMs || owned(meta.sessionId)) continue
          const sealed = await store.sealEpisode(scope, meta.id, {
            reason: 'idle',
            endedAt,
            lastSeq: last?.seq ?? meta.seqRange.first,
            rawTokens: sum(records.map(estimate)),
          })
          if (records.some(isMessageRecord)) notifySealed(scope, sealed)
        } catch (error) {
          warn(`failed to seal stale episode ${meta.id}`, error)
        }
      }
    }
  }

  function sealStale(now: Millis, olderThanMs: number): Promise<void> {
    if (disposed) return Promise.resolve()
    if (sweeping !== undefined) return sweeping
    lastSweep = now
    const running = sweep(now, olderThanMs)
      .catch((error: unknown) => warn('stale episode sweep failed', error))
      .finally(() => {
        if (sweeping === running) sweeping = undefined
      })
    sweeping = running
    return running
  }

  return {
    handleEvent(session, event) {
      try {
        if (disposed || session.origin === 'subagent') return
        let state = sessions.get(session.sessionId)
        if (state !== undefined && (session !== state.descriptor || event.type === 'turn/start') && scopeChanged(state, session)) {
          void retire(state, 'end', true)
          state = undefined
        }
        const target = state ?? createState(session)
        if (target?.decision === undefined) return
        void enqueue(target, 'capture', () => process(target, event))
      } catch (error) {
        warn('failed to queue session event', error)
      }
    },

    flushSession(sessionId) {
      const state = sessions.get(sessionId)
      if (state?.decision === undefined) return Promise.resolve()
      return flushState(state)
    },

    async sealIdle(now = clock.now()) {
      if (disposed) return
      const thresholdMs = options.idleMinutes * 60_000
      const tasks: Promise<void>[] = retryStranded()
      if (lastSweep === undefined || now - lastSweep >= STALE_SWEEP_INTERVAL_MS) tasks.push(sealStale(now, thresholdMs))
      for (const state of sessions.values()) {
        if (state.decision === undefined) continue
        tasks.push(enqueue(state, 'idle seal', async () => {
          const episode = state.episode
          if (episode === undefined || episode.messages === 0 || state.turnOpen) return
          if (now - state.lastActivity < thresholdMs) return
          clearTimer(state)
          await sealAll(state, 'idle')
        }))
      }
      await Promise.all(tasks)
    },

    async sealSession(sessionId, reason = 'end') {
      const state = sessions.get(sessionId)
      if (state === undefined) {
        if (reason === 'end') {
          await retiring.get(sessionId)
          carriedTurns.delete(sessionId)
        }
        return
      }
      if (reason === 'end') return retire(state, 'end', false)
      return enqueue(state, `${reason} seal`, async () => {
        clearTimer(state)
        await sealAll(state, reason)
      })
    },

    async rescope(sessionId) {
      const state = sessions.get(sessionId)
      if (state === undefined) {
        await retiring.get(sessionId)
        return
      }
      await retire(state, 'end', true)
    },

    sealStale(now = clock.now(), olderThanMs = options.idleMinutes * 60_000) {
      return sealStale(now, olderThanMs)
    },

    async flush() {
      for (const state of sessions.values()) {
        if (state.decision !== undefined) void flushState(state)
      }
      void retryStranded()
      await liveQueues()
    },

    async settle() {
      await liveQueues()
    },

    async dispose() {
      if (disposed) {
        await liveQueues()
        return
      }
      disposed = true
      for (const state of sessions.values()) clearTimer(state)
      for (const state of sessions.values()) {
        if (state.decision !== undefined) void enqueue(state, 'flush', () => persist(state, { includeEmpty: true }))
      }
      void retryStranded()
      await liveQueues()
      for (const state of sessions.values()) clearTimer(state)
    },
  }
}
