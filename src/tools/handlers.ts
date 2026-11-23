import type { Clock, EpisodeId, EpisodeMeta, MemoryIndex, MemoryStore, RawEventRecord, ScopeDecision, ScopeId, TokenEstimator } from '../contracts.ts'
import { canReadScope } from '../scope/guard.ts'
import { percent, recallPolicy } from './policy.ts'
import type { RecallAllowance } from './policy.ts'
import { isConversationRecord, renderRawRecord } from './raw.ts'
import { formatHit, formatTimelineEntry } from './render.ts'
import type { FlagOutput, ReadLevel, ReadOutput, SearchHitOutput, SearchOutput, TimelineEntryOutput, TimelineOutput } from './render.ts'
import type { MemorySearch } from './search.ts'
import { localDateTime, parseDateBound, splitFrontmatter, truncateToTokens } from './text.ts'

export interface ToolLogger {
  warn(message: string, ...args: unknown[]): void
}

/**
 * What the recall tools need from the host. `A` is the calling agent as DSH
 * hands it to a tool (`ToolRunContext.agent`); this module never inspects it.
 */
export interface ToolDeps<A = unknown> {
  readonly store: MemoryStore
  readonly search: MemorySearch
  /** Scope of the agent's session; owner memory is readable only when `private` is true. */
  scopeFor(agent: A): ScopeDecision
  /** Context pressure of the agent's session, 0..1. */
  pressure(agent: A): number
  /** Single-read ceiling for the active level (`ResolvedBudget.recallLimitTokens`). */
  recallLimitTokens(agent: A): number
  readonly estimator: TokenEstimator
  readonly clock: Clock
  readonly logger?: ToolLogger
}

export type MemoryToolErrorCode =
  | 'NO_AGENT'
  | 'SCOPE_UNAVAILABLE'
  | 'SCOPE_DENIED'
  | 'RECALL_PAUSED'
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'HIDDEN'

/** A refusal or bad request reported to the model as a failed tool call. */
export class MemoryToolError extends Error {
  readonly code: MemoryToolErrorCode

  constructor(code: MemoryToolErrorCode, message: string) {
    super(message)
    this.name = 'MemoryToolError'
    this.code = code
  }
}

export interface SearchArgs {
  readonly query: string
  readonly from?: string
  readonly to?: string
  readonly limit?: number
  readonly includeRaw?: boolean
}

export interface ReadArgs {
  readonly id: string
  readonly level?: ReadLevel
  readonly offset?: number
  readonly limit?: number
  /** Raw only: page over every stored record instead of the conversation records. */
  readonly includeSystem?: boolean
}

export interface TimelineArgs {
  readonly id: string
  readonly before?: number
  readonly after?: number
}

export interface IdArgs {
  readonly id: string
}

export interface MemoryToolHandlers<A> {
  search(agent: A | undefined, args: SearchArgs, signal?: AbortSignal): Promise<SearchOutput>
  read(agent: A | undefined, args: ReadArgs, signal?: AbortSignal): Promise<ReadOutput>
  timeline(agent: A | undefined, args: TimelineArgs, signal?: AbortSignal): Promise<TimelineOutput>
  pin(agent: A | undefined, args: IdArgs): Promise<FlagOutput>
  unpin(agent: A | undefined, args: IdArgs): Promise<FlagOutput>
  hide(agent: A | undefined, args: IdArgs): Promise<FlagOutput>
  unhide(agent: A | undefined, args: IdArgs): Promise<FlagOutput>
}

/** One page of a raw read's view; `total` counts the view, `hidden` the episode records left out of it. */
interface RawView {
  readonly records: readonly RawEventRecord[]
  readonly total: number
  readonly hidden: number
}

export const RAW_DEFAULT_RECORDS = 40
export const RAW_MAX_RECORDS = 200
const RAW_SCAN_PAGE = 500
const RAW_RECORD_CHARS = 4000
const TIMELINE_DEFAULT_SPAN = 3
const TIMELINE_MAX_SPAN = 20
const TIMELINE_GIST_TOKENS = 80
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function parseEpisodeId(raw: string): EpisodeId {
  const id = raw.trim().replace(/^#/, '')
  if (!ID_PATTERN.test(id) || id.includes('..')) {
    throw new MemoryToolError('INVALID_ARGS', `"${raw}" is not a memory id; ids look like 20261120-2130_ab12cd34_1.`)
  }
  return id as EpisodeId
}

function parseBound(text: string | undefined, edge: 'from' | 'to'): number | undefined {
  if (text === undefined) return undefined
  try {
    return parseDateBound(text, edge)
  } catch {
    throw new MemoryToolError('INVALID_ARGS', `${edge} must be a date such as 2026-11-20, 2026-11, or an ISO date-time; got "${text}".`)
  }
}

function joinNotices(notices: readonly string[]): { notice?: string } {
  return notices.length === 0 ? {} : { notice: notices.join(' ') }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function createMemoryToolHandlers<A>(deps: ToolDeps<A>): MemoryToolHandlers<A> {
  const { store, estimator } = deps

  function warn(message: string, ...args: unknown[]): void {
    try {
      deps.logger?.warn(message, ...args)
    } catch {}
  }

  function requireAgent(agent: A | undefined): A {
    if (agent === undefined) throw new MemoryToolError('NO_AGENT', 'Memory tools are only available inside an agent turn.')
    return agent
  }

  function scopeOf(agent: A): ScopeId {
    let decision: ScopeDecision
    try {
      decision = deps.scopeFor(agent)
    } catch (error) {
      warn('memory scope resolution failed: %s', errorText(error))
      throw new MemoryToolError('SCOPE_UNAVAILABLE', 'Memory is unavailable for this session.')
    }
    if (!canReadScope(decision)) {
      throw new MemoryToolError('SCOPE_DENIED', 'Memory is not available in this session.')
    }
    return decision.scope
  }

  function allowance(agent: A): RecallAllowance {
    let pressure = 0
    let limit = Number.NaN
    try {
      pressure = deps.pressure(agent)
    } catch (error) {
      warn('memory pressure probe failed: %s', errorText(error))
    }
    try {
      limit = deps.recallLimitTokens(agent)
    } catch (error) {
      warn('memory recall limit lookup failed: %s', errorText(error))
    }
    const policy = recallPolicy(pressure, limit)
    if (policy.kind === 'refuse') throw new MemoryToolError('RECALL_PAUSED', policy.message)
    return policy
  }

  async function findEpisode(scope: ScopeId, id: EpisodeId, includeHidden: boolean): Promise<{ meta: EpisodeMeta; index: MemoryIndex }> {
    const index = await store.readIndex(scope)
    const meta = index.episodes.find(episode => episode.id === id && episode.scope === scope)
    if (meta === undefined) {
      throw new MemoryToolError('NOT_FOUND', `No memory #${id} here. Use memory_search to find episode ids.`)
    }
    if (meta.hidden && !includeHidden) {
      throw new MemoryToolError('HIDDEN', `Memory #${id} is hidden. memory_unhide restores it.`)
    }
    return { meta, index }
  }

  async function readTierBody(scope: ScopeId, id: EpisodeId, tier: 'summary' | 'gist'): Promise<string | undefined> {
    const text = await store.readTier(scope, id, tier)
    if (text === undefined) return undefined
    const body = splitFrontmatter(text).body.trim()
    return body === '' ? undefined : body
  }

  async function recall(scope: ScopeId, meta: EpisodeMeta): Promise<void> {
    try {
      const now = deps.clock.now()
      await store.updateEpisode(scope, meta.id, current => ({ strength: current.strength + 1, lastRecalledAt: now }))
    } catch (error) {
      warn('memory recall bookkeeping failed for %s: %s', meta.id, errorText(error))
    }
  }

  async function search(agent: A | undefined, args: SearchArgs, signal?: AbortSignal): Promise<SearchOutput> {
    const caller = requireAgent(agent)
    const scope = scopeOf(caller)
    const allowed = allowance(caller)
    const from = parseBound(args.from, 'from')
    const to = parseBound(args.to, 'to')
    if (from !== undefined && to !== undefined && from > to) {
      throw new MemoryToolError('INVALID_ARGS', '`from` is later than `to`.')
    }
    const result = await deps.search.search({
      scope,
      query: args.query,
      ...from === undefined ? {} : { from },
      ...to === undefined ? {} : { to },
      ...args.limit === undefined ? {} : { limit: args.limit },
      includeRaw: args.includeRaw === true,
    }, signal)
    const hits: SearchHitOutput[] = []
    let used = estimator.estimate(args.query) + 40
    for (const hit of result.hits) {
      const output = { id: hit.id, date: hit.date, gist: hit.gist, score: hit.score }
      const cost = estimator.estimate(formatHit(output)) + 1
      if (used + cost > allowed.capTokens) break
      hits.push(output)
      used += cost
    }
    const notices: string[] = []
    if (hits.length < result.hits.length) {
      notices.push(`${result.hits.length - hits.length} more hits were left out to save context; narrow the query or the date range.`)
    }
    if (result.rawPartial === true) notices.push('The raw scan was bounded, so older transcripts were not fully searched.')
    return { total: result.total, hits, ...joinNotices(notices) }
  }

  async function conversationView(scope: ScopeId, id: EpisodeId, offset: number, limit: number, signal?: AbortSignal): Promise<RawView> {
    const records: RawEventRecord[] = []
    let total = 0
    let hidden = 0
    let position = 0
    for (;;) {
      signal?.throwIfAborted()
      const page = await store.readRaw(scope, id, { offset: position, limit: RAW_SCAN_PAGE })
      for (const record of page.records) {
        if (!isConversationRecord(record)) {
          hidden++
          continue
        }
        if (total >= offset && records.length < limit) records.push(record)
        total++
      }
      position += page.records.length
      if (page.records.length === 0 || position >= page.total) break
    }
    return { records, total, hidden }
  }

  async function rawView(scope: ScopeId, id: EpisodeId, includeSystem: boolean, offset: number, limit: number, signal?: AbortSignal): Promise<RawView> {
    if (!includeSystem) return conversationView(scope, id, offset, limit, signal)
    const page = await store.readRaw(scope, id, { offset, limit })
    return { records: page.records, total: page.total, hidden: 0 }
  }

  async function readRaw(scope: ScopeId, meta: EpisodeMeta, args: ReadArgs, allowed: RecallAllowance, notices: string[], signal?: AbortSignal): Promise<ReadOutput> {
    const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = clampInt(args.limit, RAW_DEFAULT_RECORDS, 1, RAW_MAX_RECORDS)
    const includeSystem = args.includeSystem === true
    const view = await rawView(scope, meta.id, includeSystem, offset, limit, signal)
    const lines: string[] = []
    let used = 30
    let consumed = 0
    let truncated = false
    for (const record of view.records) {
      signal?.throwIfAborted()
      const line = renderRawRecord(record, { maxChars: RAW_RECORD_CHARS, reasoning: true })
      if (line === undefined) {
        consumed++
        continue
      }
      const cost = estimator.estimate(line) + 1
      if (used + cost > allowed.capTokens) {
        truncated = true
        if (lines.length === 0) {
          lines.push(truncateToTokens(line, Math.max(1, allowed.capTokens - used), estimator).text)
          consumed++
        }
        break
      }
      lines.push(line)
      used += cost
      consumed++
    }
    const next = offset + consumed
    if (view.records.length === 0) {
      if (view.total === 0 && view.hidden > 0) {
        notices.push(`This episode has no conversation records; includeSystem: true shows its ${view.hidden} system records.`)
      } else {
        notices.push(`Offset ${offset} is past the end of this episode (${view.total} ${includeSystem ? 'records' : 'conversation records'}).`)
      }
    } else if (lines.length === 0) {
      lines.push(includeSystem ? '(no conversation in this range, only bookkeeping events)' : '(no text in this range)')
    }
    if (view.records.length > 0) await recall(scope, meta)
    return {
      id: meta.id,
      date: localDateTime(meta.startedAt),
      level: 'raw',
      text: lines.join('\n'),
      truncated,
      offset,
      count: consumed,
      total: view.total,
      ...view.hidden > 0 ? { hiddenRecords: view.hidden } : {},
      ...next < view.total ? { nextOffset: next } : {},
      ...joinNotices(notices),
    }
  }

  async function read(agent: A | undefined, args: ReadArgs, signal?: AbortSignal): Promise<ReadOutput> {
    const caller = requireAgent(agent)
    const scope = scopeOf(caller)
    const allowed = allowance(caller)
    const id = parseEpisodeId(args.id)
    const { meta } = await findEpisode(scope, id, false)
    const notices: string[] = []
    let level: ReadLevel = args.level ?? 'summary'
    if (level === 'raw' && !allowed.allowRaw) {
      level = 'summary'
      notices.push(`Raw text is unavailable at ${percent(allowed.pressure)}% context use; this is the summary instead.`)
    }
    if (level === 'raw') return readRaw(scope, meta, args, allowed, notices, signal)

    let text = await readTierBody(scope, id, level)
    if (text === undefined && level === 'summary') {
      text = await readTierBody(scope, id, 'gist')
      if (text !== undefined) {
        level = 'gist'
        notices.push('No summary is stored for this episode; this is its gist.')
      }
    }
    const date = localDateTime(meta.startedAt)
    if (text === undefined) {
      notices.push(`This episode is not summarized yet (status: ${meta.status}).${allowed.allowRaw ? ' Read level "raw" for the original transcript.' : ''}`)
      return { id, date, level, text: '', truncated: false, ...joinNotices(notices) }
    }
    const cut = truncateToTokens(text, Math.max(1, allowed.capTokens - 30), estimator, '\n…[truncated]')
    if (level === 'summary') await recall(scope, meta)
    return { id, date, level, text: cut.text, truncated: cut.truncated, ...joinNotices(notices) }
  }

  async function gistLine(scope: ScopeId, meta: EpisodeMeta): Promise<string> {
    let text: string | undefined
    try {
      text = await readTierBody(scope, meta.id, 'gist')
    } catch (error) {
      warn('memory gist read failed for %s: %s', meta.id, errorText(error))
    }
    if (text === undefined) return `(${meta.status}; not summarized yet)`
    return truncateToTokens(oneLine(text), TIMELINE_GIST_TOKENS, estimator).text
  }

  async function timeline(agent: A | undefined, args: TimelineArgs, signal?: AbortSignal): Promise<TimelineOutput> {
    const caller = requireAgent(agent)
    const scope = scopeOf(caller)
    const allowed = allowance(caller)
    const id = parseEpisodeId(args.id)
    const { meta, index } = await findEpisode(scope, id, false)
    const ordered = index.episodes
      .filter(episode => episode.scope === scope && !episode.hidden)
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
    const at = ordered.findIndex(episode => episode.id === id)
    const before = clampInt(args.before, TIMELINE_DEFAULT_SPAN, 0, TIMELINE_MAX_SPAN)
    const after = clampInt(args.after, TIMELINE_DEFAULT_SPAN, 0, TIMELINE_MAX_SPAN)
    const span = ordered.slice(Math.max(0, at - before), at + after + 1)
    signal?.throwIfAborted()
    const gists = await Promise.all(span.map(episode => gistLine(scope, episode)))
    let entries: TimelineEntryOutput[] = span.map((episode, position) => ({
      id: episode.id,
      date: localDateTime(episode.startedAt),
      gist: gists[position]!,
      status: episode.status,
      current: episode.id === id,
      sameSession: episode.sessionId === meta.sessionId,
      pinned: episode.pinned,
    }))
    const cost = (list: readonly TimelineEntryOutput[]): number =>
      30 + list.reduce((sum, entry) => sum + estimator.estimate(formatTimelineEntry(entry)) + 1, 0)
    let dropped = 0
    while (entries.length > 1 && cost(entries) > allowed.capTokens) {
      const center = entries.findIndex(entry => entry.current)
      entries = center >= entries.length - 1 - center ? entries.slice(1) : entries.slice(0, -1)
      dropped++
    }
    const notices = dropped > 0 ? [`${dropped} neighbouring episodes were left out to save context.`] : []
    return { id, entries, ...joinNotices(notices) }
  }

  async function setFlags(agent: A | undefined, args: IdArgs, change: { readonly pinned?: boolean; readonly hidden?: boolean }): Promise<FlagOutput> {
    const caller = requireAgent(agent)
    const scope = scopeOf(caller)
    const id = parseEpisodeId(args.id)
    const { meta } = await findEpisode(scope, id, true)
    const changed = (change.pinned !== undefined && change.pinned !== meta.pinned)
      || (change.hidden !== undefined && change.hidden !== meta.hidden)
    let next = meta
    if (changed) {
      next = await store.updateEpisode(scope, id, change)
      deps.search.invalidate(scope)
    }
    return { id, pinned: next.pinned, hidden: next.hidden, changed }
  }

  return {
    search,
    read,
    timeline,
    pin: (agent, args) => setFlags(agent, args, { pinned: true }),
    unpin: (agent, args) => setFlags(agent, args, { pinned: false }),
    hide: (agent, args) => setFlags(agent, args, { hidden: true }),
    unhide: (agent, args) => setFlags(agent, args, { hidden: false }),
  }
}
