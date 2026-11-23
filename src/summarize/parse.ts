import type { Commitment, DatedFact, EpisodeSummaryResult, LlmCompletion } from '../contracts.ts'
import { MEMORY_SAVE_TOOL_NAME } from './prompt.ts'
import { oneLine, stripThink, tidyBlock } from './text.ts'

export type ParseSource = 'tool' | 'json' | 'delimited'

export interface ParsedSummary {
  readonly result: EpisodeSummaryResult
  readonly source: ParseSource
}

type FieldKey = keyof EpisodeSummaryResult

const FIELD_NAMES = {
  gist: ['gist', '总结'],
  summary: ['summary', '摘要'],
  ongoing: ['ongoing', '进行中', '进行中事项'],
  importance: ['importance', '重要度', '重要性'],
  keywords: ['keywords', '关键词'],
  people: ['people', '人物'],
  dates: ['dates', '日期'],
  promises: ['promises', '承诺', '约定事项'],
} as const satisfies Record<FieldKey, readonly string[]>

export const LIST_LIMITS = { ongoing: 12, keywords: 12, people: 20, dates: 20, promises: 20 } as const
const ITEM_CHARS = 300

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pick(object: Json, names: readonly string[]): unknown {
  for (const name of names) if (object[name] !== undefined) return object[name]
  const lowered = new Map(Object.keys(object).map(key => [key.toLowerCase(), key]))
  for (const name of names) {
    const key = lowered.get(name.toLowerCase())
    if (key !== undefined && object[key] !== undefined) return object[key]
  }
  return undefined
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join('\n')
  if (isRecord(value)) return Object.entries(value).map(([key, item]) => `## ${key}\n${toText(item)}`).join('\n\n')
  return ''
}

const PLACEHOLDER = /^(?:…+|\.\.\.|-|<.*>|（.*(?:每行一项|整数|一行|几个小节).*）)$/

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim())
}

function cleanItem(value: string): string {
  const line = oneLine(value.replace(/^\s*(?:[-*•·]|\d+[.)、])\s+/, ''))
  if (isPlaceholder(line)) return ''
  return line.length > ITEM_CHARS ? `${line.slice(0, ITEM_CHARS - 1)}…` : line
}

export function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function rawItems(value: unknown, separators: RegExp): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value.split(separators)
  return []
}

function toStringList(value: unknown, limit: number, separators: RegExp): string[] {
  const items = rawItems(value, separators)
    .map(item => (typeof item === 'string' || typeof item === 'number' ? cleanItem(String(item)) : isRecord(item) ? cleanItem(toText(Object.values(item))) : ''))
    .filter(item => item.length > 0 && !/^(?:无|none|n\/a|\(none\)|（无）)$/i.test(item))
  return dedupeBy(items, item => item.toLowerCase()).slice(0, limit)
}

/** Normalize `YYYY-MM-DD`, `YYYY/MM/DD`, `YYYY年M月D日` (optionally with `HH:mm`) to ISO 8601. */
export function isoDate(value: string): string | undefined {
  const match = /^\s*(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2})日?)?(?:(?:T|\s+)(\d{1,2}):(\d{2}))?/.exec(value)
  if (match === null) return undefined
  const [, year, month, day, hour, minute] = match
  const m = Number(month)
  if (m < 1 || m > 12) return undefined
  let out = `${year}-${String(m).padStart(2, '0')}`
  if (day !== undefined) {
    const d = Number(day)
    if (d < 1 || d > new Date(Date.UTC(Number(year), m, 0)).getUTCDate()) return undefined
    out += `-${String(d).padStart(2, '0')}`
    if (hour !== undefined && minute !== undefined && Number(hour) < 24 && Number(minute) < 60) out += `T${hour.padStart(2, '0')}:${minute}`
  }
  return out
}

const LEADING_DATE = /^\s*(?:[-*•·]\s*)?(\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?(?:(?:T|\s+)\d{1,2}:\d{2})?)\s*[:：\-–—,，]?\s*(.*)$/

function toDates(value: unknown): DatedFact[] {
  const out: DatedFact[] = []
  for (const item of rawItems(value, /\n/)) {
    if (isRecord(item)) {
      const date = isoDate(toText(pick(item, ['date', '日期', 'when', 'time'])))
      const what = cleanItem(toText(pick(item, ['what', 'event', '事件', '内容', 'description', 'fact'])))
      if (date !== undefined && what.length > 0) out.push({ date, what })
    } else if (typeof item === 'string') {
      const match = LEADING_DATE.exec(item)
      const date = match?.[1] === undefined ? undefined : isoDate(match[1])
      const what = cleanItem(match?.[2] ?? '')
      if (date !== undefined && what.length > 0) out.push({ date, what })
    }
  }
  return dedupeBy(out, fact => `${fact.date}|${fact.what}`).slice(0, LIST_LIMITS.dates)
}

function commitment(what: string, who: string | undefined, due: string | undefined): Commitment {
  return {
    what,
    ...(who !== undefined && who.length > 0 ? { who } : {}),
    ...(due !== undefined ? { due } : {}),
  }
}

function toPromises(value: unknown): Commitment[] {
  const out: Commitment[] = []
  for (const item of rawItems(value, /\n/)) {
    if (isRecord(item)) {
      const what = cleanItem(toText(pick(item, ['what', '内容', '事项', 'promise', 'content', 'task'])))
      if (what.length === 0) continue
      const who = cleanItem(toText(pick(item, ['who', '谁', 'by', 'owner'])))
      const due = isoDate(toText(pick(item, ['due', '截止', '截止日期', 'deadline', 'date'])))
      out.push(commitment(what, who, due))
    } else if (typeof item === 'string') {
      const line = cleanItem(item)
      if (line.length === 0 || /^(?:无|none|（无）)$/i.test(line)) continue
      const who = cleanItem(/(?:谁|who)\s*[:：]\s*([^；;，,)）]+)/i.exec(line)?.[1] ?? '')
      const dueText = /(?:截止|due|deadline)\s*[:：]?\s*(\d{4}[^；;，,)）]*)/i.exec(line)?.[1]
      const what = line.replace(/\s*[（(][^（()）]*(?:谁|who|截止|due|deadline)[^（()）]*[)）]\s*$/i, '').trim()
      if (what.length > 0) out.push(commitment(what, who, dueText === undefined ? undefined : isoDate(dueText)))
    }
  }
  return dedupeBy(out, promise => promise.what).slice(0, LIST_LIMITS.promises)
}

/** Rescale a 0–1 or 0–100 scale (×10 / ÷10), then round and clamp to 1–10; anything unparseable (or a skeleton placeholder) becomes 5. */
export function clampImportance(value: unknown): number {
  const raw = typeof value === 'number'
    ? value
    : typeof value === 'string' && !isPlaceholder(value) ? Number(/-?\d+(?:\.\d+)?/.exec(value)?.[0]) : Number.NaN
  if (!Number.isFinite(raw)) return 5
  const n = raw > 0 && raw < 1 ? raw * 10 : raw > 10 && raw <= 100 ? raw / 10 : raw
  return Math.min(10, Math.max(1, Math.round(n)))
}

/** Normalize loosely typed fields; `undefined` when gist or summary is empty. */
export function normalizeSummary(fields: Partial<Record<FieldKey, unknown>>): EpisodeSummaryResult | undefined {
  const gist = oneLine(stripThink(toText(fields.gist)))
  const summary = tidyBlock(stripThink(toText(fields.summary)))
  if (gist.length === 0 || summary.length === 0 || isPlaceholder(gist) || isPlaceholder(summary)) return undefined
  return {
    gist,
    summary,
    ongoing: toStringList(fields.ongoing, LIST_LIMITS.ongoing, /\n|[;；]/),
    importance: clampImportance(fields.importance),
    keywords: toStringList(fields.keywords, LIST_LIMITS.keywords, /\n|[,，、;；]/),
    people: toStringList(fields.people, LIST_LIMITS.people, /\n|[,，、;；]/),
    dates: toDates(fields.dates),
    promises: toPromises(fields.promises),
  }
}

function hasSummaryKeys(object: Json): boolean {
  return pick(object, FIELD_NAMES.gist) !== undefined || pick(object, FIELD_NAMES.summary) !== undefined
}

function fromObject(value: unknown): EpisodeSummaryResult | undefined {
  if (!isRecord(value)) return undefined
  let object = value
  if (!hasSummaryKeys(object)) {
    const nested = Object.values(object)
      .map(item => (typeof item === 'string' ? tryParse(item) : item))
      .find((item): item is Json => isRecord(item) && hasSummaryKeys(item))
    if (nested === undefined) return undefined
    object = nested
  }
  const fields: Partial<Record<FieldKey, unknown>> = {}
  for (const [field, names] of Object.entries(FIELD_NAMES) as [FieldKey, readonly string[]][]) fields[field] = pick(object, names)
  return normalizeSummary(fields)
}

const CONTROL_ESCAPES: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** Escape raw newlines, carriage returns, and tabs inside JSON string literals. */
function escapeRawControls(text: string): string {
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string
    if (inString) {
      if (char === '\\') {
        out += char + (text[index + 1] ?? '')
        index += 1
        continue
      }
      if (char === '"') inString = false
      out += CONTROL_ESCAPES[char] ?? char
    } else {
      if (char === '"') inString = true
      out += char
    }
  }
  return out
}

function tryParse(text: string): unknown {
  const attempts = [text]
  const escaped = escapeRawControls(text)
  if (escaped !== text) attempts.push(escaped)
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch {}
    try {
      return JSON.parse(attempt.replace(/,\s*([}\]])/g, '$1'))
    } catch {}
  }
  return undefined
}

function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** First JSON object in free text (fenced block first), preferring one with summary keys. */
export function extractJsonObject(text: string): Json | undefined {
  let fallback: Json | undefined
  const consider = (candidate: string): Json | undefined => {
    const value = tryParse(candidate.trim())
    if (!isRecord(value)) return undefined
    if (hasSummaryKeys(value)) return value
    fallback ??= value
    return undefined
  }
  for (const match of text.matchAll(/```[A-Za-z]*[ \t]*\n?([\s\S]*?)```/g)) {
    const found = consider(match[1] ?? '')
    if (found !== undefined) return found
  }
  let starts = 0
  for (let start = text.indexOf('{'); start >= 0 && starts < 50; start = text.indexOf('{', start + 1), starts++) {
    const end = balancedEnd(text, start)
    if (end < 0) continue
    const found = consider(text.slice(start, end + 1))
    if (found !== undefined) return found
  }
  return fallback
}

/** Parse a whole-text JSON value, a double-encoded JSON string, or an object embedded in prose. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const direct = tryParse(trimmed)
  if (typeof direct === 'string') return tryParse(direct) ?? extractJsonObject(direct)
  if (direct !== undefined) return direct
  return extractJsonObject(trimmed)
}

const FIELD_LOOKUP = new Map<string, FieldKey>(
  (Object.entries(FIELD_NAMES) as [FieldKey, readonly string[]][]).flatMap(([field, names]) => names.map(name => [name.toLowerCase(), field] as const)),
)

function sectionMarker(line: string): { readonly key: FieldKey; readonly inline: string } | undefined {
  let rest = line.trim()
  const open = /^(?:#{1,6}\s*|={2,}\s*|\*\*\s*|【\s*|\[\s*|<\s*)/.exec(rest)
  if (open !== null) rest = rest.slice(open[0].length)
  const word = /^(?:[A-Za-z]+|[\u4e00-\u9fff]+)/.exec(rest)
  if (word === null) return undefined
  const key = FIELD_LOOKUP.get(word[0].toLowerCase())
  if (key === undefined) return undefined
  rest = rest.slice(word[0].length)
  const close = /^\s*(?:\*\*|】|\]|>|={2,})/.exec(rest)
  if (close !== null) rest = rest.slice(close[0].length)
  rest = rest.trim()
  if (rest.length === 0) return { key, inline: '' }
  const colon = /^[:：]\s*/.exec(rest)
  if (colon !== null) {
    return { key, inline: rest.slice(colon[0].length).replace(/^\*\*\s*/, '').replace(/\s*(?:\*\*|={2,})\s*$/, '').trim() }
  }
  if (open !== null && close !== null) return { key, inline: rest }
  return undefined
}

/** Last-resort parser for `===总结===` / `## 摘要` / `Gist:` style sections. */
export function parseDelimited(text: string): EpisodeSummaryResult | undefined {
  const sections = new Map<FieldKey, string[]>()
  let current: string[] | undefined
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) continue
    const marker = sectionMarker(line)
    if (marker !== undefined && !sections.has(marker.key)) {
      current = marker.inline.length > 0 ? [marker.inline] : []
      sections.set(marker.key, current)
      continue
    }
    current?.push(line)
  }
  const section = (key: FieldKey): string | undefined => sections.get(key)?.join('\n').trim()
  return normalizeSummary({
    gist: section('gist'),
    summary: section('summary'),
    ongoing: section('ongoing'),
    importance: section('importance'),
    keywords: section('keywords'),
    people: section('people'),
    dates: section('dates'),
    promises: section('promises'),
  })
}

/**
 * Parse one summarizer completion: the `memory_save` tool call first (then any
 * other tool call carrying summary fields), then a JSON object in the text,
 * then delimiter sections. `<think>` blocks are stripped from the text.
 */
export function parseSummaryOutput(completion: Pick<LlmCompletion, 'text' | 'toolCalls'>, toolName: string = MEMORY_SAVE_TOOL_NAME): ParsedSummary | undefined {
  const calls = [
    ...completion.toolCalls.filter(call => call.name === toolName),
    ...completion.toolCalls.filter(call => call.name !== toolName),
  ]
  for (const call of calls) {
    const result = fromObject(parseJsonLoose(call.arguments))
    if (result !== undefined) return { result, source: 'tool' }
  }
  const text = stripThink(completion.text)
  if (text.length === 0) return undefined
  const json = fromObject(parseJsonLoose(text))
  if (json !== undefined) return { result: json, source: 'json' }
  const delimited = parseDelimited(text)
  return delimited === undefined ? undefined : { result: delimited, source: 'delimited' }
}

/** The model's visible answer, for replaying it as the assistant turn of a retry. */
export function answerText(completion: Pick<LlmCompletion, 'text' | 'toolCalls'>, toolName: string = MEMORY_SAVE_TOOL_NAME): string {
  const call = completion.toolCalls.find(item => item.name === toolName) ?? completion.toolCalls[0]
  const text = call === undefined ? stripThink(completion.text) : call.arguments.trim()
  return text.length > 0 ? text : '(empty)'
}
