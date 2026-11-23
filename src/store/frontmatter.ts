import type { Commitment, DatedFact, EpisodeId, Millis, RollupEntry, ScopeId } from '../contracts.ts'
import { isRollupFile, isValidScopeId, parseEpisodeId } from './layout.ts'
import { isFiniteNumber, isRecord, isRollupPeriod, isString, isStringArray } from './validate.ts'

type Fields = Readonly<Record<string, unknown>>

const DELIMITER = '---'
const KEY = /^[A-Za-z_][\w-]*$/
const FIELD = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/
const PLAIN = /^[\p{L}\p{N}_][\p{L}\p{N}_.:/@+-]*$/u
const RESERVED = /^(?:true|false|null|yes|no|on|off|y|n)$/i
const NUMBER_LIKE = /^[-+]?(?:[\d_]+(?:\.[\d_]*)?(?:e[-+]?\d+)?|0x[\da-f_]+|0o[0-7_]+|0b[01_]+|[\d_]+(?::[0-5]?\d)+(?:\.[\d_]*)?)$/i
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[-+]?\d+)?$/i

export type Tier = 'summary' | 'gist'

/** Frontmatter of `summary.md` / `gist.md`. The extraction fields appear on the summary tier only. */
export interface TierFrontmatter {
  readonly id: EpisodeId
  readonly scope: ScopeId
  readonly sessionId: string
  readonly tier: Tier
  readonly seq: { readonly first: number; readonly last: number }
  readonly time: { readonly start: Millis; readonly end?: Millis }
  readonly provider: string
  readonly model: string
  readonly promptVersion: string
  readonly summarizedAt: Millis
  readonly tokens: number
  readonly importance?: number
  readonly keywords?: readonly string[]
  readonly people?: readonly string[]
  readonly dates?: readonly DatedFact[]
  readonly promises?: readonly Commitment[]
  readonly ongoing?: readonly string[]
}

export interface TierDocument {
  /** Present when the file carries a complete, well-formed tier frontmatter. */
  readonly frontmatter?: TierFrontmatter
  /** Every parsed frontmatter field, including unknown or hand-edited ones. */
  readonly fields: Fields
  readonly body: string
}

export interface RollupDocument {
  readonly entry?: RollupEntry
  readonly fields: Fields
  readonly body: string
}

function isPlain(text: string): boolean {
  return PLAIN.test(text) && !RESERVED.test(text) && !NUMBER_LIKE.test(text) && !text.endsWith(':')
}

function renderValue(value: unknown): string {
  if (typeof value === 'string' && isPlain(value)) return value
  const rendered = JSON.stringify(value)
  if (rendered === undefined) throw new TypeError('memory store: frontmatter value is not serializable')
  return rendered
}

function parseScalar(raw: string): unknown {
  const text = raw.trim()
  if (text === '' || text === '~' || text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (NUMBER.test(text)) return Number(text)
  if (text.startsWith('"') || text.startsWith('[') || text.startsWith('{')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  if (text.length >= 2 && text.startsWith('\'') && text.endsWith('\'')) return text.slice(1, -1).replaceAll('\'\'', '\'')
  return text
}

/**
 * Render a YAML-compatible frontmatter block followed by `body`. Strings stay
 * plain when unambiguous and are otherwise JSON-quoted; arrays and objects use
 * JSON flow style, which YAML also reads. A trailing newline is always added
 * and removed again by {@link splitFrontmatter}, so bodies round-trip exactly.
 */
export function renderFrontmatter(fields: Fields, body: string): string {
  const lines = [DELIMITER]
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (!KEY.test(key)) throw new TypeError(`memory store: invalid frontmatter key ${JSON.stringify(key)}`)
    lines.push(`${key}: ${renderValue(value)}`)
  }
  lines.push(DELIMITER)
  return `${lines.join('\n')}\n${body}\n`
}

/** Split a leading frontmatter block from its body; undefined when the text has none. */
export function splitFrontmatter(text: string): { readonly fields: Fields; readonly body: string } | undefined {
  const lines = text.split('\n')
  const line = (position: number): string => (lines[position] ?? '').replace(/\r$/, '')
  if (lines.length < 2 || line(0) !== DELIMITER) return undefined
  let end = -1
  for (let position = 1; position < lines.length; position += 1) {
    if (line(position) === DELIMITER) {
      end = position
      break
    }
  }
  if (end < 0) return undefined
  const fields: Record<string, unknown> = {}
  for (let position = 1; position < end; position += 1) {
    const match = FIELD.exec(line(position))
    if (match === null) continue
    const [, key = '', value = ''] = match
    fields[key] = parseScalar(value)
  }
  const rest = lines.slice(end + 1).join('\n')
  return { fields, body: rest.endsWith('\n') ? rest.slice(0, -1) : rest }
}

function iso(time: Millis): string {
  return new Date(time).toISOString()
}

function parseTime(value: unknown): Millis | undefined {
  if (!isString(value)) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

function isDatedFact(value: unknown): value is DatedFact {
  return isRecord(value) && isString(value.date) && isString(value.what)
}

function isCommitment(value: unknown): value is Commitment {
  return isRecord(value)
    && isString(value.what)
    && (value.who === undefined || isString(value.who))
    && (value.due === undefined || isString(value.due))
}

export function renderTierFile(frontmatter: TierFrontmatter, body: string): string {
  const { time, seq } = frontmatter
  return renderFrontmatter({
    id: frontmatter.id,
    scope: frontmatter.scope,
    sessionId: frontmatter.sessionId,
    tier: frontmatter.tier,
    seq: [seq.first, seq.last],
    time: time.end === undefined ? [iso(time.start)] : [iso(time.start), iso(time.end)],
    provider: frontmatter.provider,
    model: frontmatter.model,
    promptVersion: frontmatter.promptVersion,
    summarizedAt: iso(frontmatter.summarizedAt),
    tokens: frontmatter.tokens,
    importance: frontmatter.importance,
    keywords: frontmatter.keywords,
    people: frontmatter.people,
    dates: frontmatter.dates,
    promises: frontmatter.promises,
    ongoing: frontmatter.ongoing,
  }, body)
}

export function decodeTierFrontmatter(fields: Fields): TierFrontmatter | undefined {
  const { id, scope, sessionId, tier, seq, time, provider, model, promptVersion, tokens } = fields
  if (!isString(id) || parseEpisodeId(id) === undefined) return undefined
  if (!isString(scope) || !isValidScopeId(scope)) return undefined
  if (!isString(sessionId) || (tier !== 'summary' && tier !== 'gist')) return undefined
  if (!Array.isArray(seq) || seq.length !== 2 || !seq.every(isFiniteNumber)) return undefined
  if (!Array.isArray(time) || time.length < 1 || time.length > 2) return undefined
  const start = parseTime(time[0])
  const end = time.length === 2 ? parseTime(time[1]) : undefined
  if (start === undefined || (time.length === 2 && end === undefined)) return undefined
  const summarizedAt = parseTime(fields.summarizedAt)
  if (!isString(provider) || !isString(model) || !isString(promptVersion)) return undefined
  if (summarizedAt === undefined || !isFiniteNumber(tokens)) return undefined
  const { importance, keywords, people, dates, promises, ongoing } = fields
  if (importance !== undefined && !isFiniteNumber(importance)) return undefined
  if (keywords !== undefined && !isStringArray(keywords)) return undefined
  if (people !== undefined && !isStringArray(people)) return undefined
  if (dates !== undefined && !(Array.isArray(dates) && dates.every(isDatedFact))) return undefined
  if (promises !== undefined && !(Array.isArray(promises) && promises.every(isCommitment))) return undefined
  if (ongoing !== undefined && !isStringArray(ongoing)) return undefined
  return {
    id: id as EpisodeId,
    scope,
    sessionId,
    tier,
    seq: { first: seq[0] as number, last: seq[1] as number },
    time: end === undefined ? { start } : { start, end },
    provider,
    model,
    promptVersion,
    summarizedAt,
    tokens,
    ...importance === undefined ? {} : { importance },
    ...keywords === undefined ? {} : { keywords },
    ...people === undefined ? {} : { people },
    ...dates === undefined ? {} : { dates: dates as DatedFact[] },
    ...promises === undefined ? {} : { promises: promises as Commitment[] },
    ...ongoing === undefined ? {} : { ongoing },
  }
}

export function parseTierFile(text: string): TierDocument {
  const split = splitFrontmatter(text)
  if (split === undefined) return { fields: {}, body: text }
  const frontmatter = decodeTierFrontmatter(split.fields)
  return frontmatter === undefined ? split : { ...split, frontmatter }
}

export function renderRollupFile(entry: RollupEntry, body: string): string {
  return renderFrontmatter({
    id: entry.id,
    scope: entry.scope,
    period: entry.period.kind,
    key: entry.period.key,
    from: iso(entry.from),
    to: iso(entry.to),
    tokens: entry.tokens,
    createdAt: iso(entry.createdAt),
    file: entry.file,
    episodeIds: entry.episodeIds,
  }, body)
}

export function decodeRollupFrontmatter(fields: Fields): RollupEntry | undefined {
  const { id, scope, key, tokens, file, episodeIds } = fields
  const period = { kind: fields.period, key }
  const from = parseTime(fields.from)
  const to = parseTime(fields.to)
  const createdAt = parseTime(fields.createdAt)
  if (!isString(id) || id === '' || !isString(scope) || !isValidScopeId(scope)) return undefined
  if (!isRollupPeriod(period) || !isFiniteNumber(tokens) || !isStringArray(episodeIds)) return undefined
  if (!isString(file) || !isRollupFile(file)) return undefined
  if (from === undefined || to === undefined || createdAt === undefined) return undefined
  return { id, scope, period, episodeIds: episodeIds as EpisodeId[], from, to, tokens, file, createdAt }
}

export function parseRollupFile(text: string): RollupDocument {
  const split = splitFrontmatter(text)
  if (split === undefined) return { fields: {}, body: text }
  const entry = decodeRollupFrontmatter(split.fields)
  return entry === undefined ? split : { ...split, entry }
}
