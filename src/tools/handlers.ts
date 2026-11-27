import type { Clock, EpisodeId, EpisodeMeta, MemoryIndex, MemoryStore, RawEventRecord, ScopeDecision, ScopeId, TokenEstimator } from '../contracts.ts'
import { isEmptyEpisode } from '../runtime/sources.ts'
import { canReadScope, mayUseOwnerMemory } from '../scope/guard.ts'
import { EventMemoryError, type EventMemory, type EventMemoryEntry } from '../store/event-memory.ts'
import type { ProfileNoteAction, ProfileNoteRequest, ProfileNoteResult, ProfileNotes } from '../store/profile-notes.ts'
import { rankEventMemories } from './event-recall.ts'
import { percent, recallPolicy } from './policy.ts'
import type { RecallAllowance } from './policy.ts'
import { isConversationRecord, renderRawRecord } from './raw.ts'
import { formatHit, formatTimelineEntry, missingGist } from './render.ts'
import type { FlagOutput, ReadLevel, ReadOutput, SearchHitOutput, SearchOutput, TimelineEntryOutput, TimelineOutput } from './render.ts'
import type { MemorySearch } from './search.ts'
import { localDateTime, parseDateBound, truncateToTokens } from './text.ts'

export interface ToolLogger {
  warn(message: string, ...args: unknown[]): void
}

/**
 * What the recall tools need from the host. `A` is the calling agent as DSH
 * hands it to a tool (`ToolRunContext.agent`); this module never inspects it.
 */
export interface ToolDeps<A = unknown> {
  readonly store: MemoryStore
  readonly notes: ProfileNotes
  readonly events: EventMemory
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
  | 'REVISION_CONFLICT'
  | 'EVENT_CAPACITY'
  | 'EVENT_STORE_ERROR'
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

export interface EventArgs {
  readonly action: 'find' | 'save' | 'remove'
  readonly query?: string
  readonly subject?: string
  readonly text?: string
  readonly expectedRevision?: number
}

export interface EventFindOutput {
  readonly total: number
  readonly entries: EventMemoryEntry[]
}

export type EventOutput = EventFindOutput | { readonly revision: number } | { readonly removed: boolean }

type NoteOutput = Omit<ProfileNoteResult, 'entries'> & { readonly entries?: string[] }

export interface MemoryToolHandlers<A> {
  search(agent: A | undefined, args: SearchArgs, signal?: AbortSignal): Promise<SearchOutput>
  read(agent: A | undefined, args: ReadArgs, signal?: AbortSignal): Promise<ReadOutput>
  timeline(agent: A | undefined, args: TimelineArgs, signal?: AbortSignal): Promise<TimelineOutput>
  pin(agent: A | undefined, args: IdArgs): Promise<FlagOutput>
  unpin(agent: A | undefined, args: IdArgs): Promise<FlagOutput>
  hide(agent: A | undefined, args: IdArgs): Promise<FlagOutput>
  unhide(agent: A | undefined, args: IdArgs): Promise<FlagOutput>
  note(agent: A | undefined, args: ProfileNoteRequest): Promise<NoteOutput>
  event(agent: A | undefined, args: EventArgs, signal?: AbortSignal): Promise<EventOutput>
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
const NOTE_FIELDS: Record<ProfileNoteAction, readonly ('text' | 'oldText')[]> = {
  list: [], add: ['text'], replace: ['oldText', 'text'], remove: ['oldText'],
}
const EVENT_FIELDS: Record<EventArgs['action'], readonly string[]> = {
  find: ['action', 'query'],
  save: ['action', 'subject', 'text', 'expectedRevision'],
  remove: ['action', 'subject', 'expectedRevision'],
}

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
    throw new MemoryToolError('INVALID_ARGS', `${JSON.stringify(raw)} 不是有效的片段 ID。请从 memory_search 复制 ID，如 #20261120-2130_ab12cd34_1。`)
  }
  return id as EpisodeId
}

function parseBound(text: string | undefined, edge: 'from' | 'to'): number | undefined {
  if (text === undefined) return undefined
  try {
    return parseDateBound(text, edge)
  } catch {
    throw new MemoryToolError('INVALID_ARGS', `${edge} 收到无效日期 ${JSON.stringify(text)}。请使用 YYYY、YYYY-MM、YYYY-MM-DD 或 ISO 日期时间。`)
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
    if (agent === undefined) throw new MemoryToolError('NO_AGENT', '记忆工具需要由当前回合的 agent 调用。')
    return agent
  }

  function resolveScope(agent: A): ScopeDecision {
    try {
      return deps.scopeFor(agent)
    } catch (error) {
      warn('确定会话记忆范围时出错（%s）', errorText(error))
      throw new MemoryToolError('SCOPE_UNAVAILABLE', '未能确定当前会话的记忆范围，本次操作已停止。')
    }
  }

  function readableScope(agent: A): ScopeDecision {
    const decision = resolveScope(agent)
    if (!canReadScope(decision)) {
      throw new MemoryToolError('SCOPE_DENIED', '当前会话没有访问此记忆范围的权限。')
    }
    return decision
  }

  function allowance(agent: A): RecallAllowance {
    let pressure = 0
    let limit = Number.NaN
    try {
      pressure = deps.pressure(agent)
    } catch (error) {
      warn('读取上下文用量失败（%s）', errorText(error))
    }
    try {
      limit = deps.recallLimitTokens(agent)
    } catch (error) {
      warn('读取单次回忆上限失败（%s）', errorText(error))
    }
    const policy = recallPolicy(pressure, limit)
    if (policy.kind === 'refuse') throw new MemoryToolError('RECALL_PAUSED', policy.message)
    return policy
  }

  async function findEpisode(scope: ScopeId, id: EpisodeId, includeHidden: boolean): Promise<{ meta: EpisodeMeta; index: MemoryIndex }> {
    const index = await store.readIndex(scope)
    const meta = index.episodes.find(episode => episode.id === id && episode.scope === scope)
    if (meta === undefined) {
      throw new MemoryToolError('NOT_FOUND', `当前记忆范围内未找到 #${id}。请用 memory_search 核对片段 ID。`)
    }
    if (meta.hidden && !includeHidden) {
      throw new MemoryToolError('HIDDEN', `片段 #${id} 已隐藏。用 memory_unhide 可恢复可见。`)
    }
    return { meta, index }
  }

  async function readTierBody(scope: ScopeId, id: EpisodeId, tier: 'summary' | 'gist'): Promise<string | undefined> {
    const body = (await store.readTier(scope, id, tier))?.trim()
    return body === '' ? undefined : body
  }

  async function recall(scope: ScopeId, meta: EpisodeMeta): Promise<void> {
    try {
      const now = deps.clock.now()
      await store.updateEpisode(scope, meta.id, current => ({ strength: current.strength + 1, lastRecalledAt: now }))
    } catch (error) {
      warn('更新片段 %s 的回忆计数失败（%s）', meta.id, errorText(error))
    }
  }

  async function search(agent: A | undefined, args: SearchArgs, signal?: AbortSignal): Promise<SearchOutput> {
    const caller = requireAgent(agent)
    const { scope } = readableScope(caller)
    const allowed = allowance(caller)
    const from = parseBound(args.from, 'from')
    const to = parseBound(args.to, 'to')
    if (from !== undefined && to !== undefined && from > to) {
      throw new MemoryToolError('INVALID_ARGS', '起始日期 from 晚于截止日期 to。')
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
      notices.push(`受回忆预算限制，另有 ${result.hits.length - hits.length} 个命中片段未列出。可细化查询词或缩小日期范围。`)
    }
    if (result.rawPartial === true) notices.push('原文扫描已达上限，较早的对话未全部查完。')
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
        notices.push(`本片段没有对话记录。设 includeSystem=true 可查看其 ${view.hidden} 条系统记录中有正文的部分。`)
      } else {
        notices.push(`从 offset=${offset} 起没有记录，当前共 ${view.total} 条${includeSystem ? '记录' : '对话记录'}。`)
      }
    } else if (lines.length === 0) {
      lines.push(includeSystem ? '（本页没有可显示的正文，内部运行记录仍计入分页）' : '（本页记录没有可显示的正文）')
    }
    if (offset === 0 && view.records.length > 0) await recall(scope, meta)
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
    const { scope } = readableScope(caller)
    const allowed = allowance(caller)
    const id = parseEpisodeId(args.id)
    const { meta } = await findEpisode(scope, id, false)
    const notices: string[] = []
    let level: ReadLevel = args.level ?? 'summary'
    if (level === 'raw' && !allowed.allowRaw) {
      level = 'summary'
      notices.push(`上下文已用 ${percent(allowed.pressure)}%，本次 raw 请求暂不读原文，先查摘要。`)
    }
    if (level === 'raw') return readRaw(scope, meta, args, allowed, notices, signal)

    let text = await readTierBody(scope, id, level)
    if (text === undefined && level === 'summary') {
      text = await readTierBody(scope, id, 'gist')
      if (text !== undefined) {
        level = 'gist'
        notices.push('本片段没有已保存的摘要，返回一行总结（gist）。')
      }
    }
    const date = localDateTime(meta.startedAt)
    if (text === undefined) {
      notices.push(`未找到${level === 'gist' ? '一行总结' : '摘要或一行总结'}（片段状态 ${meta.status}）。${allowed.allowRaw ? '可用 level="raw" 查原文。' : ''}`)
      return { id, date, level, text: '', truncated: false, ...joinNotices(notices) }
    }
    const cut = truncateToTokens(text, Math.max(1, allowed.capTokens - 30), estimator, '\n…[已截断]')
    if (level === 'summary') await recall(scope, meta)
    return { id, date, level, text: cut.text, truncated: cut.truncated, ...joinNotices(notices) }
  }

  async function gistLine(scope: ScopeId, meta: EpisodeMeta): Promise<string> {
    let text: string | undefined
    try {
      text = await readTierBody(scope, meta.id, 'gist')
    } catch (error) {
      warn('读取片段 %s 的一行总结失败（%s）', meta.id, errorText(error))
    }
    if (text === undefined) return missingGist(meta.status)
    return truncateToTokens(oneLine(text), TIMELINE_GIST_TOKENS, estimator).text
  }

  async function timeline(agent: A | undefined, args: TimelineArgs, signal?: AbortSignal): Promise<TimelineOutput> {
    const caller = requireAgent(agent)
    const { scope } = readableScope(caller)
    const allowed = allowance(caller)
    const id = parseEpisodeId(args.id)
    const { meta, index } = await findEpisode(scope, id, false)
    const ordered = index.episodes
      .filter(episode => episode.scope === scope && !episode.hidden && (episode.id === id || !isEmptyEpisode(episode)))
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
    const notices = dropped > 0 ? [`受回忆预算限制，已省略 ${dropped} 个相邻片段。`] : []
    return { id, entries, ...joinNotices(notices) }
  }

  async function setFlags(agent: A | undefined, args: IdArgs, change: { readonly pinned?: boolean; readonly hidden?: boolean }): Promise<FlagOutput> {
    const caller = requireAgent(agent)
    const { scope } = readableScope(caller)
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

  async function note(agent: A | undefined, args: ProfileNoteRequest): Promise<NoteOutput> {
    const decision = resolveScope(requireAgent(agent))
    if (!mayUseOwnerMemory(decision)) {
      throw new MemoryToolError('SCOPE_DENIED', '偏好笔记仅限主人的私有会话访问。')
    }
    if (args.action !== 'list' && decision.capture !== true) {
      throw new MemoryToolError('SCOPE_DENIED', '此会话已关闭记忆捕获，偏好笔记只可用 list 查看。')
    }
    if (!Object.hasOwn(NOTE_FIELDS, args.action)) throw new MemoryToolError('INVALID_ARGS', 'action 请选择 list、add、replace 或 remove。')
    const fields = NOTE_FIELDS[args.action]
    if (Object.keys(args).length !== 1 + fields.length || fields.some(field => !args[field]?.trim())) {
      throw new MemoryToolError('INVALID_ARGS', `memory_note ${args.action} 只接受 ${['action', ...fields].join('、')}，这些字段均须填写且非空。`)
    }
    const result = await deps.notes.apply(args)
    if (args.action === 'list') return result
    const { changed, usedChars, limitChars } = result
    return { changed, usedChars, limitChars }
  }

  async function accessEvents<T>(action: EventArgs['action'], operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof EventMemoryError) {
        switch (error.reason) {
          case 'conflict':
            throw new MemoryToolError('REVISION_CONFLICT', '修订号不匹配，本次变更未写入。用 find 重查同一 subject，核对内容后将最新 revision 传给 expectedRevision。若主题已不存在，只有新建时才用 0。')
          case 'input':
            throw new MemoryToolError('INVALID_ARGS', action === 'remove'
              ? 'subject 须为不含控制字符的非空单行，最多 80 个 Unicode 码点。'
              : 'subject 和 text 均须为不含控制字符的非空单行。subject 最多 80 个 Unicode 码点，text 最多 600 个。')
          case 'capacity':
            throw new MemoryToolError('EVENT_CAPACITY', '当前记忆范围的事件数已达上限，仍可修订已有主题。')
        }
      }
      throw new MemoryToolError('EVENT_STORE_ERROR', `访问事件记忆存储时出错，${action} 未返回结果。`)
    }
  }

  async function findEvents(scope: ScopeId, query: string, capTokens: number, signal?: AbortSignal): Promise<EventFindOutput> {
    const stored = await accessEvents('find', () => deps.events.list(scope))
    signal?.throwIfAborted()
    const matches = rankEventMemories(stored, query)
    const result: EventFindOutput = { total: matches.length, entries: [] }
    if (estimator.estimate(JSON.stringify(result)) > capTokens) {
      throw new MemoryToolError('RECALL_PAUSED', '本次回忆预算不足以返回含命中总数的 JSON 结果。')
    }
    for (const { subject, text, revision, updatedAt } of matches.slice(0, 5)) {
      const entry = { subject, text, revision, updatedAt }
      result.entries.push(entry)
      if (estimator.estimate(JSON.stringify(result)) <= capTokens) continue

      // Keep the subject and revision intact so a caller can still correct this entry.
      entry.text = ''
      const remaining = capTokens - estimator.estimate(JSON.stringify(result))
      entry.text = truncateToTokens(text, remaining, {
        estimate: value => estimator.estimate(JSON.stringify(value).slice(1, -1)),
      }).text || '…'
      if (estimator.estimate(JSON.stringify(result)) > capTokens) result.entries.pop()
      break
    }
    return result
  }

  async function event(agent: A | undefined, args: EventArgs, signal?: AbortSignal): Promise<EventOutput> {
    const caller = requireAgent(agent)
    const { scope, capture } = readableScope(caller)
    const { action, subject, text, expectedRevision } = args
    if (!Object.hasOwn(EVENT_FIELDS, action) || Object.keys(args).some(key => !EVENT_FIELDS[action].includes(key))) {
      throw new MemoryToolError('INVALID_ARGS', 'memory_event 的 action 或参数组合有误。find 可带 query，save 需 subject、text 和 expectedRevision，remove 需 subject 和 expectedRevision。')
    }
    signal?.throwIfAborted()
    if (action === 'find') {
      const result = await findEvents(scope, args.query ?? '', allowance(caller).capTokens, signal)
      if (!canReadScope(resolveScope(caller), scope)) {
        throw new MemoryToolError('SCOPE_DENIED', '查询期间会话的记忆范围已改变，本次结果未返回。')
      }
      return result
    }
    if (capture !== true) {
      throw new MemoryToolError('SCOPE_DENIED', '此会话已关闭记忆捕获，事件记忆只可用 find 查询。')
    }
    if (!subject?.trim()) throw new MemoryToolError('INVALID_ARGS', 'subject 需要填写非空的主题名。')
    const minimum = action === 'save' ? 0 : 1
    if (expectedRevision === undefined || !Number.isSafeInteger(expectedRevision) || expectedRevision < minimum) {
      throw new MemoryToolError('INVALID_ARGS', `${action} 的 expectedRevision 须为安全整数，最小值为 ${minimum}。`)
    }
    if (action === 'remove') {
      const removed = await accessEvents(action, () => deps.events.remove(scope, { subject, expectedRevision }))
      return { removed }
    }
    if (!text?.trim()) throw new MemoryToolError('INVALID_ARGS', 'save 需要在 text 中填写非空的事实或决定。')
    const { revision } = await accessEvents(action, () => deps.events.save(scope, { subject, text, expectedRevision }))
    return { revision }
  }

  return {
    search,
    read,
    timeline,
    note,
    event,
    pin: (agent, args) => setFlags(agent, args, { pinned: true }),
    unpin: (agent, args) => setFlags(agent, args, { pinned: false }),
    hide: (agent, args) => setFlags(agent, args, { hidden: true }),
    unhide: (agent, args) => setFlags(agent, args, { hidden: false }),
  }
}
