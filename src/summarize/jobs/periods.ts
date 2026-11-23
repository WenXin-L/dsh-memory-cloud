import type { Millis, RollupPeriod } from '../../contracts.ts'

const DAY_MS = 86_400_000

interface CivilDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** Half-open local-time span `[from, to)`. */
export interface PeriodRange {
  readonly from: Millis
  readonly to: Millis
}

export interface IsoWeek {
  readonly year: number
  readonly week: number
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

function civilOf(time: Millis): CivilDate {
  const date = new Date(time)
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
}

function dayNumberOf(date: CivilDate): number {
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS)
}

function civilOfDayNumber(dayNumber: number): CivilDate {
  const date = new Date(dayNumber * DAY_MS)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function localStartOf(dayNumber: number): Millis {
  const { year, month, day } = civilOfDayNumber(dayNumber)
  return new Date(year, month - 1, day).getTime()
}

/** Monday = 1 … Sunday = 7. */
function isoWeekday(dayNumber: number): number {
  return (((dayNumber % 7) + 10) % 7) + 1
}

function firstIsoThursday(year: number): number {
  const jan4 = dayNumberOf({ year, month: 1, day: 4 })
  return jan4 - isoWeekday(jan4) + 4
}

function isoWeekOfDay(dayNumber: number): IsoWeek {
  const thursday = dayNumber - isoWeekday(dayNumber) + 4
  const year = civilOfDayNumber(thursday).year
  return { year, week: Math.floor((thursday - firstIsoThursday(year)) / 7) + 1 }
}

function isoWeeksIn(year: number): number {
  return isoWeekOfDay(dayNumberOf({ year, month: 12, day: 28 })).week
}

function isoWeekMonday(week: IsoWeek): number {
  return firstIsoThursday(week.year) - 3 + (week.week - 1) * 7
}

function formatWeek(week: IsoWeek): string {
  return `${pad(week.year, 4)}-W${pad(week.week)}`
}

function formatMonth(date: Pick<CivilDate, 'year' | 'month'>): string {
  return `${pad(date.year, 4)}-${pad(date.month)}`
}

/** Local calendar day, `2026-11-23`; the daily job quota resets when it changes. */
export function localDayKey(time: Millis): string {
  const { year, month, day } = civilOf(time)
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

export function startOfNextLocalDay(time: Millis): Millis {
  const { year, month, day } = civilOf(time)
  return new Date(year, month - 1, day + 1).getTime()
}

/** ISO 8601 week of a local time, `2026-W47`. */
export function isoWeekKey(time: Millis): string {
  return formatWeek(isoWeekOfDay(dayNumberOf(civilOf(time))))
}

/** Calendar month of a local time, `2026-11`. */
export function monthKey(time: Millis): string {
  return formatMonth(civilOf(time))
}

export function parseIsoWeekKey(key: string): IsoWeek | undefined {
  const match = /^(\d{4})-W(\d{2})$/.exec(key)
  if (!match) return undefined
  const year = Number(match[1])
  const week = Number(match[2])
  return week >= 1 && week <= isoWeeksIn(year) ? { year, week } : undefined
}

export function parseMonthKey(key: string): { readonly year: number; readonly month: number } | undefined {
  const match = /^(\d{4})-(\d{2})$/.exec(key)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  return month >= 1 && month <= 12 ? { year, month } : undefined
}

function parseYearKey(key: string): number | undefined {
  return /^\d{4}$/.test(key) ? Number(key) : undefined
}

export function isoWeekRange(key: string): PeriodRange | undefined {
  const week = parseIsoWeekKey(key)
  if (!week) return undefined
  const monday = isoWeekMonday(week)
  return { from: localStartOf(monday), to: localStartOf(monday + 7) }
}

/**
 * The month that owns an ISO week: the month of its Thursday. Rollup months
 * are unions of whole ISO weeks, so a month rollup supersedes exactly its
 * week rollups (e.g. `2026-W44`, Oct 26 – Nov 1, belongs to `2026-10`).
 */
export function weekMonthKey(weekKey: string): string | undefined {
  const week = parseIsoWeekKey(weekKey)
  return week ? formatMonth(civilOfDayNumber(isoWeekMonday(week) + 3)) : undefined
}

/** ISO weeks owned by a rollup month (those whose Thursday falls in it), oldest first. */
export function monthWeekKeys(key: string): readonly string[] {
  const parsed = parseMonthKey(key)
  if (!parsed) return []
  const first = dayNumberOf({ ...parsed, day: 1 })
  const weeks: string[] = []
  for (let thursday = first + ((4 - isoWeekday(first) + 7) % 7); civilOfDayNumber(thursday).month === parsed.month; thursday += 7) {
    weeks.push(formatWeek(isoWeekOfDay(thursday)))
  }
  return weeks
}

/**
 * Local-time span a rollup period covers. Weeks are ISO weeks; months and
 * years are the spans of the ISO weeks they own, so periods nest exactly.
 */
export function periodRange(period: RollupPeriod): PeriodRange | undefined {
  switch (period.kind) {
    case 'week':
      return isoWeekRange(period.key)
    case 'month': {
      const weeks = monthWeekKeys(period.key)
      const first = weeks[0]
      const last = weeks.at(-1)
      if (first === undefined || last === undefined) return undefined
      const from = isoWeekRange(first)
      const to = isoWeekRange(last)
      return from && to ? { from: from.from, to: to.to } : undefined
    }
    case 'year': {
      const year = parseYearKey(period.key)
      if (year === undefined) return undefined
      const monday = isoWeekMonday({ year, week: 1 })
      return { from: localStartOf(monday), to: localStartOf(monday + isoWeeksIn(year) * 7) }
    }
  }
}

/** The rollup period of a given kind that contains a local time. */
export function rollupPeriodOf(kind: RollupPeriod['kind'], time: Millis): RollupPeriod {
  const week = isoWeekOfDay(dayNumberOf(civilOf(time)))
  switch (kind) {
    case 'week':
      return { kind, key: formatWeek(week) }
    case 'month':
      return { kind, key: formatMonth(civilOfDayNumber(isoWeekMonday(week) + 3)) }
    case 'year':
      return { kind, key: pad(week.year, 4) }
  }
}

/** The next-coarser period that supersedes this one, if any. */
export function parentPeriod(period: RollupPeriod): RollupPeriod | undefined {
  switch (period.kind) {
    case 'week': {
      const key = weekMonthKey(period.key)
      return key === undefined ? undefined : { kind: 'month', key }
    }
    case 'month':
      return parseMonthKey(period.key) ? { kind: 'year', key: period.key.slice(0, 4) } : undefined
    case 'year':
      return undefined
  }
}

/** Stable identity of a period, e.g. `week:2026-W47`. */
export function periodId(period: RollupPeriod): string {
  return `${period.kind}:${period.key}`
}
