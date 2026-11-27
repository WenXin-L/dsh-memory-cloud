import type { Millis, TokenEstimator } from '../contracts.ts'

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const WORD = /[\p{L}\p{N}]/u
const ASCII_WORD = /^[a-z]+$/

const PARTICLES = new Set(['的', '了', '吗', '呢', '吧', '啊', '呀', '嘛', '哦', '么'])

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'doe', 'does', 'did', 'have', 'has', 'had',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'my', 'your', 'our', 'their', 'us', 'him', 'her', 'them', 'its',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'about', 'into', 'over', 'than', 'then', 'there', 'here', 'not', 'no', 'yes', 'can', 'could', 'would',
  'should', 'will', 'shall', 'may', 'might', 'must', 'just', 'also', 'so', 'if', 'please', 'tell',
  'remember', 'said', 'say', 'again', 'any', 'some', 'all',
])

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

export function isCjk(char: string): boolean {
  return CJK.test(char)
}

function stem(word: string): string {
  if (!ASCII_WORD.test(word) || word.length <= 3) return word
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1)
  return word
}

export interface Tokens {
  /** Words, CJK bigrams, and lone CJK characters, in text order with repeats. */
  readonly terms: readonly string[]
  /** CJK unigrams of multi-character runs, kept so one-character queries still match. */
  readonly chars: readonly string[]
  /** Distinct CJK runs and words of two or more characters, for keyword containment checks. */
  readonly runs: readonly string[]
}

/** Lowercase word tokens plus Chinese/Japanese/Korean character bigrams. */
export function tokenize(text: string): Tokens {
  const terms: string[] = []
  const chars: string[] = []
  const runs = new Set<string>()
  let cjk: string[] = []
  let word = ''
  const flushCjk = (): void => {
    if (cjk.length === 1) {
      terms.push(cjk[0]!)
    } else if (cjk.length > 1) {
      for (let index = 0; index + 1 < cjk.length; index++) terms.push(cjk[index]! + cjk[index + 1]!)
      chars.push(...cjk)
      runs.add(cjk.join(''))
    }
    cjk = []
  }
  const flushWord = (): void => {
    if (word !== '') {
      terms.push(stem(word))
      if (word.length >= 2) runs.add(word)
    }
    word = ''
  }
  for (const char of normalize(text)) {
    if (CJK.test(char)) {
      flushWord()
      cjk.push(char)
    } else if (WORD.test(char)) {
      flushCjk()
      word += char
    } else {
      flushCjk()
      flushWord()
    }
  }
  flushCjk()
  flushWord()
  return { terms, chars, runs: [...runs] }
}

function isWeakTerm(term: string): boolean {
  if (STOPWORDS.has(term)) return true
  if ([...term].length !== 2 || !CJK.test(term)) return false
  return [...term].some(char => PARTICLES.has(char))
}

/** Distinct query terms. Browsing the archive keeps a weak-only query searchable. */
export function queryTerms(text: string, keepWeakOnly = true): readonly string[] {
  const all = [...new Set(tokenize(text).terms)]
  const strong = all.filter(term => !isWeakTerm(term))
  return strong.length === 0 && keepWeakOnly ? all : strong
}

const FULL_DATE = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/g
const MONTH_DAY = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g

export interface QueryDates {
  /** `YYYY-MM-DD` dates named in the query. */
  readonly full: readonly string[]
  /** `MM-DD` dates named without a year. */
  readonly monthDay: readonly string[]
  /** The query with every recognized date removed. */
  readonly rest: string
}

const pad = (value: number): string => String(value).padStart(2, '0')

function validMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

export function extractQueryDates(query: string): QueryDates {
  const full = new Set<string>()
  const monthDay = new Set<string>()
  let rest = query.normalize('NFKC').replace(FULL_DATE, (match, year: string, month: string, day: string) => {
    if (!validMonthDay(Number(month), Number(day))) return match
    full.add(`${year}-${pad(Number(month))}-${pad(Number(day))}`)
    return ' '
  })
  rest = rest.replace(MONTH_DAY, (match, month: string, day: string) => {
    if (!validMonthDay(Number(month), Number(day))) return match
    monthDay.add(`${pad(Number(month))}-${pad(Number(day))}`)
    return ' '
  })
  return { full: [...full], monthDay: [...monthDay], rest }
}

/** Local calendar date `YYYY-MM-DD`. */
export function localDate(time: Millis): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local `YYYY-MM-DD HH:mm`. */
export function localDateTime(time: Millis): string {
  const date = new Date(time)
  return `${localDate(time)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Local `HH:mm`. */
export function localTime(time: Millis): string {
  const date = new Date(time)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const DATE_BOUND = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/i

function isCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(year, month - 1, day)
  return probe.getMonth() === month - 1 && probe.getDate() === day
}

/**
 * Parse a `from`/`to` filter: `YYYY`, `YYYY-MM`, `YYYY-MM-DD` with `-`, `/` or
 * `.` (local time; `to` covers the whole named period), or an ISO date-time
 * `YYYY-MM-DD[T ]HH:mm[:ss[.sss]][Z|±hh:mm]` (local time without an offset).
 * @throws RangeError for anything else, including dates V8 would guess at.
 */
export function parseDateBound(text: string, edge: 'from' | 'to'): Millis | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const invalid = (): RangeError => new RangeError(`日期 ${JSON.stringify(text)} 无效。`)
  const match = DATE_BOUND.exec(trimmed.replace(/[/.]/g, '-'))
  if (match !== null) {
    const year = Number(match[1])
    const month = match[2] === undefined ? undefined : Number(match[2])
    const day = match[3] === undefined ? undefined : Number(match[3])
    if (month !== undefined && (month < 1 || month > 12)) throw invalid()
    if (day !== undefined && !isCalendarDate(year, month!, day)) throw invalid()
    if (edge === 'from') return new Date(year, (month ?? 1) - 1, day ?? 1).getTime()
    if (day !== undefined) return new Date(year, month! - 1, day + 1).getTime() - 1
    if (month !== undefined) return new Date(year, month, 1).getTime() - 1
    return new Date(year + 1, 0, 1).getTime() - 1
  }
  const dateTime = DATE_TIME.exec(trimmed)
  if (dateTime === null || !isCalendarDate(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3]))) throw invalid()
  const parsed = Date.parse(trimmed.toUpperCase().replace(' ', 'T'))
  if (!Number.isFinite(parsed)) throw invalid()
  return parsed
}

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})/g

export function isoDatesIn(text: string | undefined): readonly string[] {
  if (text === undefined) return []
  return [...new Set([...text.matchAll(ISO_DATE)].map(match => `${match[1]}-${match[2]}-${match[3]}`))]
}

export interface Truncated {
  readonly text: string
  readonly truncated: boolean
}

/** Cut text to at most `maxTokens` estimated tokens, preferring a line break near the cut. */
export function truncateToTokens(text: string, maxTokens: number, estimator: TokenEstimator, marker = '…'): Truncated {
  if (estimator.estimate(text) <= maxTokens) return { text, truncated: false }
  const budget = maxTokens - estimator.estimate(marker)
  if (budget <= 0) return { text: '', truncated: text.length > 0 }
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (estimator.estimate(text.slice(0, middle)) <= budget) low = middle
    else high = middle - 1
  }
  let cut = low
  const code = text.charCodeAt(cut - 1)
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut--
  const lineBreak = text.lastIndexOf('\n', cut)
  if (lineBreak > cut * 0.8) cut = lineBreak
  return { text: `${text.slice(0, cut).trimEnd()}${marker}`, truncated: true }
}

/** Shorten text to `maxChars`, noting how much was dropped. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let cut = Math.max(0, maxChars)
  const code = text.charCodeAt(cut - 1)
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut--
  return `${text.slice(0, cut)}…(+${text.length - cut} chars)`
}
