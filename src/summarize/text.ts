import type { Millis, TokenEstimator } from '../contracts.ts'

const LEADING_THINK_OPEN = /^\s*<think(?:ing)?>/i
const THINK_CLOSE = /<\/think(?:ing)?\s*>/i

/**
 * Remove `<think>`/`<thinking>` blocks that open a raw completion; an
 * unterminated leading block removes everything. Tags anywhere else are
 * part of the answer and kept.
 */
export function stripThink(text: string): string {
  let out = text
  for (let open = LEADING_THINK_OPEN.exec(out); open !== null; open = LEADING_THINK_OPEN.exec(out)) {
    const rest = out.slice(open[0].length)
    const close = THINK_CLOSE.exec(rest)
    if (close === null) return ''
    out = rest.slice(close.index + close[0].length)
  }
  return out.trim()
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** First `length` UTF-16 units without splitting a surrogate pair. */
export function sliceHead(text: string, length: number): string {
  let end = Math.max(0, Math.min(text.length, length))
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1
  return text.slice(0, end)
}

/** Last `length` UTF-16 units without splitting a surrogate pair. */
export function sliceTail(text: string, length: number): string {
  let start = Math.max(0, text.length - Math.max(0, length))
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1
  return text.slice(start)
}

/** Keep the head (2/3) and tail (1/3) of an over-long text; `maxChars` ≤ 0 or non-finite keeps everything. */
export function clipMiddle(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text
  const headChars = Math.ceil((maxChars * 2) / 3)
  const head = sliceHead(text, headChars).trimEnd()
  const tail = sliceTail(text, maxChars - headChars).trimStart()
  const omitted = text.length - head.length - tail.length
  return `${head}\n[… 中间省略了 ${omitted} 个 UTF-16 代码单元 …]\n${tail}`
}

const CJK_TERMINATORS = new Set(['。', '！', '？', '；', '…', '\n'])
const LATIN_TERMINATORS = new Set(['.', '!', '?', ';'])

function isListNumber(text: string, dot: number): boolean {
  return /^\s*\d+$/.test(text.slice(text.lastIndexOf('\n', dot - 1) + 1, dot))
}

function sentenceEnd(text: string, limit: number): number {
  for (let index = limit - 1; index >= 0; index--) {
    const char = text[index] as string
    if (CJK_TERMINATORS.has(char)) return index + 1
    if (LATIN_TERMINATORS.has(char)) {
      const next = text[index + 1]
      if ((next === undefined || /\s/.test(next)) && !(char === '.' && isListNumber(text, index))) return index + 1
    }
  }
  return 0
}

const DANGLING_LINE = /(?:^|\n)[ \t]*(?:[-*+•·]|\d+[.)、]|#{1,6}(?:[ \t][^\n]*)?)[ \t]*$/

/** Drop trailing lines that hold only a list marker or a Markdown heading. */
function trimDanglingLines(text: string): string {
  let out = text.trimEnd()
  for (let match = DANGLING_LINE.exec(out); match !== null; match = DANGLING_LINE.exec(out)) out = out.slice(0, match.index).trimEnd()
  return out
}

/** `text` cut back to its last sentence end (see {@link truncateToTokens}); empty when it has none. */
export function completeSentences(text: string): string {
  const boundary = sentenceEnd(text, text.length)
  return boundary === 0 ? '' : trimDanglingLines(text.slice(0, boundary))
}

function largestPrefix(text: string, maxTokens: number, estimator: TokenEstimator, suffix = ''): number {
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimator.estimate(sliceHead(text, mid) + suffix) <= maxTokens) low = mid
    else high = mid - 1
  }
  return sliceHead(text, low).length
}

/**
 * Cut `text` so its estimate fits `maxTokens`, preferring the last sentence
 * boundary (a line break counts; the dot of a `1.` list marker does not) and
 * dropping trailing lines left with only a list marker or a heading; falls
 * back to a hard cut with `…` when that keeps less than a third of the
 * allowed prefix.
 */
export function truncateToTokens(text: string, maxTokens: number, estimator: TokenEstimator): string {
  if (estimator.estimate(text) <= maxTokens) return text
  const prefixLength = largestPrefix(text, maxTokens, estimator)
  const boundary = sentenceEnd(text, prefixLength)
  if (boundary > 0) {
    const cut = trimDanglingLines(text.slice(0, boundary))
    if (cut.length > 0 && cut.length >= prefixLength / 3) return cut
  }
  const hard = largestPrefix(text, maxTokens, estimator, '…')
  if (hard === 0) return ''
  return `${sliceHead(text, hard).trimEnd()}…`
}

/** Index where the largest prefix of `text` within `maxTokens` ends, preferring a newline, never 0 for non-empty text. */
export function splitPoint(text: string, maxTokens: number, estimator: TokenEstimator): number {
  const prefix = Math.max(1, largestPrefix(text, maxTokens, estimator))
  const newline = text.lastIndexOf('\n', prefix)
  return newline > prefix / 2 ? newline : prefix
}

/** Approximate character counts for a token target, derived from the injected estimator. */
export function lengthHint(tokens: number, estimator: TokenEstimator): string {
  const cjkPer100 = estimator.estimate('字'.repeat(100))
  const wordsPer100 = estimator.estimate('memory '.repeat(100))
  const hanzi = Math.max(1, Math.floor((tokens * 100) / (cjkPer100 > 0 ? cjkPer100 : 70)))
  const words = Math.max(1, Math.floor((tokens * 100) / (wordsPer100 > 0 ? wordsPer100 : 130)))
  return `${tokens} tokens（约 ${hanzi} 个汉字或 ${words} 个英文单词）`
}

/** Collapse a value to one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Trim, normalize newlines, drop trailing spaces, and collapse runs of blank lines. */
export function tidyBlock(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A valid IANA zone, or the host zone when `timeZone` is absent or invalid. */
export function resolveTimeZone(timeZone?: string): string {
  if (timeZone !== undefined && timeZone.length > 0) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone })
      return timeZone
    } catch {}
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export interface TimeFormatter {
  readonly timeZone: string
  /** `YYYY-MM-DD` */
  date(time: Millis): string
  /** `HH:mm` */
  time(time: Millis): string
  /** `YYYY-MM-DD HH:mm` */
  dateTime(time: Millis): string
  /** Chinese weekday (`周一`…`周日`); empty for a non-finite time. */
  weekday(time: Millis): string
  /** `YYYY-MM-DD 周X HH:mm` */
  weekdayDateTime(time: Millis): string
}

const ZH_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

export function createTimeFormatter(timeZone?: string): TimeFormatter {
  const zone = resolveTimeZone(timeZone)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const fields = (time: Millis): Record<string, string> | undefined => {
    if (!Number.isFinite(time)) return undefined
    const out: Record<string, string> = {}
    for (const part of parts.formatToParts(time)) out[part.type] = part.value
    return out
  }
  return {
    timeZone: zone,
    date(time) {
      const f = fields(time)
      return f === undefined ? '????-??-??' : `${f.year}-${f.month}-${f.day}`
    },
    time(time) {
      const f = fields(time)
      return f === undefined ? '??:??' : `${f.hour}:${f.minute}`
    },
    dateTime(time) {
      return `${this.date(time)} ${this.time(time)}`
    },
    weekday(time) {
      const f = fields(time)
      return f === undefined ? '' : ZH_WEEKDAYS[new Date(Date.UTC(Number(f.year), Number(f.month) - 1, Number(f.day))).getUTCDay()] ?? ''
    },
    weekdayDateTime(time) {
      const weekday = this.weekday(time)
      return weekday.length === 0 ? this.dateTime(time) : `${this.date(time)} ${weekday} ${this.time(time)}`
    },
  }
}
