import type { EpisodeId, EpisodeMeta, MemoryIndex, Millis, RollupEntry, RollupPeriod } from '../../contracts.ts'
import { parentPeriod, periodId, periodRange, rollupPeriodOf, type PeriodRange } from './periods.ts'

const DAY_MS = 86_400_000

export interface RollupMemberOptions {
  readonly now: Millis
  /** Episodes that ended within this many days stay out of rollups. */
  readonly keepRecentDays: number
}

export interface RollupPlanOptions extends RollupMemberOptions {
  /** Distant-tier budget (gists plus active rollups) that triggers rolling up. */
  readonly distantQuotaTokens: number
  readonly gistTokensOf: (meta: EpisodeMeta) => number
  /** Expected size of the rollup that would replace `replacedTokens`; defaults to 0 (re-planned once real sizes exist). */
  readonly estimateRollupTokens?: (period: RollupPeriod, replacedTokens: number) => number
}

export interface RollupPlan {
  readonly period: RollupPeriod
  /** Episodes the rollup should cover (same set as {@link rollupMembers}). */
  readonly episodeIds: readonly EpisodeId[]
  readonly from: Millis
  readonly to: Millis
  /** Distant-tier tokens the rollup replaces: member gists for a week, week rollups (plus late gists) for a month. */
  readonly replacedTokens: number
}

interface WeekBucket {
  readonly period: RollupPeriod
  readonly range: PeriodRange
  readonly members: EpisodeMeta[]
  memberTokens: number
  blocked: boolean
}

interface MonthBucket {
  readonly period: RollupPeriod
  readonly range: PeriodRange
  readonly weeks: WeekBucket[]
  readonly weekRollups: RollupEntry[]
}

const episodeTime = (meta: EpisodeMeta): Millis => meta.endedAt ?? meta.startedAt

export function recentCutoff(now: Millis, keepRecentDays: number): Millis {
  return now - Math.max(0, keepRecentDays) * DAY_MS
}

function isMemberCandidate(meta: EpisodeMeta, cutoff: Millis): boolean {
  return meta.status === 'summarized' && !meta.pinned && !meta.hidden && episodeTime(meta) <= cutoff
}

/**
 * Episodes a rollup of `period` should merge: summarized, not pinned, not
 * hidden, no longer recent, and assigned to the period by start time (months
 * own whole ISO weeks, see `weekMonthKey`). Rollup builders recompute
 * membership with this at run time because queued jobs carry only the period.
 */
export function rollupMembers(index: MemoryIndex, period: RollupPeriod, options: RollupMemberOptions): readonly EpisodeMeta[] {
  const cutoff = recentCutoff(options.now, options.keepRecentDays)
  const id = periodId(period)
  return index.episodes.filter(meta => isMemberCandidate(meta, cutoff) && periodId(rollupPeriodOf(period.kind, meta.startedAt)) === id)
}

/**
 * Periods to roll up so the distant tier fits `distantQuotaTokens`, in the
 * order they should be built: the oldest complete ISO weeks first, then whole
 * months whose weeks already have rollups. The distant load is the gist tokens
 * of summarized, visible, non-recent episodes not covered by a rollup (pinned
 * ones included: they occupy the tier but are never merged) plus the tokens of
 * rollups not superseded by a coarser one.
 *
 * A week qualifies once it ends before the recent cutoff, holds no open,
 * sealed (pending summary) or recent episode, and has at least one mergeable
 * episode. A month qualifies once it ends before the cutoff, at least two of
 * its weeks have rollups, and every week with mergeable episodes has one.
 * Periods that already have a rollup, or whose parent does, are skipped.
 */
export function planRollups(index: MemoryIndex, options: RollupPlanOptions): readonly RollupPlan[] {
  const cutoff = recentCutoff(options.now, options.keepRecentDays)
  const estimate = options.estimateRollupTokens ?? (() => 0)
  const rolled = new Set(index.rollups.map(entry => periodId(entry.period)))
  const covered = new Set<string>(index.rollups.flatMap(entry => entry.episodeIds))
  const superseded = (period: RollupPeriod): boolean => {
    for (let parent = parentPeriod(period); parent; parent = parentPeriod(parent)) {
      if (rolled.has(periodId(parent))) return true
    }
    return false
  }
  const activeRollups = index.rollups.filter(entry => !superseded(entry.period))

  let load = activeRollups.reduce((sum, entry) => sum + Math.max(0, entry.tokens), 0)
  const weeks = new Map<string, WeekBucket>()
  for (const meta of index.episodes) {
    const period = rollupPeriodOf('week', meta.startedAt)
    let bucket = weeks.get(period.key)
    if (!bucket) {
      const range = periodRange(period)
      if (!range) continue
      bucket = { period, range, members: [], memberTokens: 0, blocked: false }
      weeks.set(period.key, bucket)
    }
    const recent = episodeTime(meta) > cutoff
    if (recent || meta.status === 'open' || meta.status === 'sealed') bucket.blocked = true
    if (meta.status !== 'summarized' || meta.hidden || recent || covered.has(meta.id)) continue
    const tokens = Math.max(0, options.gistTokensOf(meta))
    load += tokens
    if (meta.pinned) continue
    bucket.members.push(meta)
    bucket.memberTokens += tokens
  }

  const plans: RollupPlan[] = []
  if (load <= options.distantQuotaTokens) return plans
  const take = (period: RollupPeriod, range: PeriodRange, members: readonly EpisodeMeta[], replacedTokens: number): boolean => {
    const saved = replacedTokens - Math.max(0, estimate(period, replacedTokens))
    if (saved <= 0) return false
    plans.push({ period, episodeIds: members.map(meta => meta.id), from: range.from, to: range.to, replacedTokens })
    load -= saved
    return load <= options.distantQuotaTokens
  }

  const isOpenPeriod = (period: RollupPeriod, range: PeriodRange): boolean =>
    range.to <= cutoff && !rolled.has(periodId(period)) && !superseded(period)

  const weekCandidates = [...weeks.values()]
    .filter(bucket => !bucket.blocked && bucket.members.length > 0 && isOpenPeriod(bucket.period, bucket.range))
    .sort((a, b) => a.range.from - b.range.from)
  for (const bucket of weekCandidates) {
    if (take(bucket.period, bucket.range, bucket.members, bucket.memberTokens)) return plans
  }

  const months = new Map<string, MonthBucket>()
  const monthOf = (week: RollupPeriod): MonthBucket | undefined => {
    const period = parentPeriod(week)
    if (!period) return undefined
    let bucket = months.get(period.key)
    if (!bucket) {
      const range = periodRange(period)
      if (!range) return undefined
      bucket = { period, range, weeks: [], weekRollups: [] }
      months.set(period.key, bucket)
    }
    return bucket
  }
  for (const bucket of weeks.values()) monthOf(bucket.period)?.weeks.push(bucket)
  for (const entry of activeRollups) {
    if (entry.period.kind === 'week') monthOf(entry.period)?.weekRollups.push(entry)
  }

  const monthCandidates = [...months.values()]
    .filter(month =>
      isOpenPeriod(month.period, month.range)
      && month.weekRollups.length >= 2
      && month.weeks.every(week => !week.blocked && (week.members.length === 0 || rolled.has(periodId(week.period)))))
    .sort((a, b) => a.range.from - b.range.from)
  for (const month of monthCandidates) {
    const members = rollupMembers(index, month.period, options)
    if (members.length === 0) continue
    const replaced = month.weekRollups.reduce((sum, entry) => sum + Math.max(0, entry.tokens), 0)
      + month.weeks.reduce((sum, week) => sum + week.memberTokens, 0)
    if (take(month.period, month.range, members, replaced)) return plans
  }
  return plans
}
