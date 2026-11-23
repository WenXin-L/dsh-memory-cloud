import type { EpisodeId, Millis, ScopeId } from '../contracts.ts'

const SCOPE_ID = /^[\p{L}\p{N}_][\p{L}\p{N}._-]{0,127}$/u
const EPISODE_ID = /^(\d{4})(\d{2})\d{2}-\d{4}_([A-Za-z0-9-]{1,8})_([1-9]\d{0,14})$/
const ROLLUP_FILE = /^rollups\/[\p{L}\p{N}_][\p{L}\p{N}._-]{0,127}\.md$/u
const LOG_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
const SESSION_TAG_LENGTH = 8
/** Every DSH session id starts with this (`session-<uuid>`), so it carries no identity. */
const SESSION_ID_PREFIX = 'session-'
const FILE_STEM_LENGTH = 120

export interface ParsedEpisodeId {
  readonly year: string
  readonly month: string
  readonly sessionTag: string
  readonly n: number
}

/** Scope ids double as directory names, so they are restricted instead of sanitized (sanitizing could merge two scopes). */
export function isValidScopeId(value: string): value is ScopeId {
  return SCOPE_ID.test(value)
}

export function assertScopeId(value: string): asserts value is ScopeId {
  if (!isValidScopeId(value)) throw new TypeError(`memory store: invalid scope id ${JSON.stringify(value)}`)
}

export function parseEpisodeId(value: string): ParsedEpisodeId | undefined {
  const match = EPISODE_ID.exec(value)
  if (match === null) return undefined
  const [, year = '', month = '', sessionTag = '', n = ''] = match
  return { year, month, sessionTag, n: Number(n) }
}

export function assertEpisodeId(value: string): ParsedEpisodeId {
  const parsed = parseEpisodeId(value)
  if (parsed === undefined) throw new TypeError(`memory store: invalid episode id ${JSON.stringify(value)}`)
  return parsed
}

/**
 * First eight characters of the session id, after DSH's shared `session-`
 * prefix, with everything outside `[A-Za-z0-9-]` replaced by `-`.
 */
export function sessionTag(sessionId: string): string {
  const distinct = sessionId.startsWith(SESSION_ID_PREFIX) && sessionId.length > SESSION_ID_PREFIX.length
    ? sessionId.slice(SESSION_ID_PREFIX.length)
    : sessionId
  const tag = distinct.slice(0, SESSION_TAG_LENGTH).replace(/[^A-Za-z0-9-]/g, '-')
  return tag === '' ? 'anon' : tag
}

export function formatEpisodeId(stamp: string, sessionId: string, n: number): EpisodeId {
  return `${stamp}_${sessionTag(sessionId)}_${n}` as EpisodeId
}

/** `episodes/YYYY/MM/<id>`, relative to the scope root, always `/`-separated. */
export function episodeRelativeDir(id: string): string {
  const { year, month } = assertEpisodeId(id)
  return `episodes/${year}/${month}/${id}`
}

/** Formats epoch milliseconds as `YYYYMMDD-HHmm` in `timeZone` (host zone when omitted). */
export function createStampFormatter(timeZone?: string): (time: Millis) => string {
  const format = new Intl.DateTimeFormat('en-US', {
    ...timeZone === undefined ? {} : { timeZone },
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  return time => {
    if (!Number.isFinite(time)) throw new RangeError(`memory store: invalid timestamp ${time}`)
    const parts: Record<string, string> = {}
    for (const part of format.formatToParts(time)) parts[part.type] = part.value
    const year = (parts.year ?? '').padStart(4, '0')
    return `${year}${parts.month ?? ''}${parts.day ?? ''}-${parts.hour ?? ''}${parts.minute ?? ''}`
  }
}

export function isRollupFile(value: string): boolean {
  return ROLLUP_FILE.test(value)
}

export function isLogName(value: string): boolean {
  return LOG_NAME.test(value)
}

/** A single path segment derived from arbitrary text (session ids in snapshot names). */
export function safeFileStem(value: string): string {
  const stem = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\./, '_').slice(0, FILE_STEM_LENGTH)
  return stem === '' ? 'session' : stem
}
