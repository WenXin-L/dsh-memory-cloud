import { describe, expect, it } from 'vitest'
import { OWNER_SCOPE, type EpisodeMeta, type RollupEntry, type RollupPeriod } from '../../src/contracts.ts'
import { planRollups, rollupMembers, type RollupPlanOptions } from '../../src/summarize/jobs/index.ts'
import { at, episode, index } from './helpers.ts'

const scope = OWNER_SCOPE
const gistTokensOf = (meta: EpisodeMeta) => meta.tokens.gist ?? 0

const options = (overrides: Partial<RollupPlanOptions> = {}): RollupPlanOptions => ({
  distantQuotaTokens: 1000,
  gistTokensOf,
  now: at(2026, 11, 23),
  keepRecentDays: 7,
  ...overrides,
})

const rollup = (period: RollupPeriod, episodeIds: readonly string[], tokens: number): RollupEntry => ({
  id: period.key,
  scope,
  period,
  episodeIds: episodeIds as RollupEntry['episodeIds'],
  from: 0,
  to: 0,
  tokens,
  file: `rollups/${period.key}.md`,
  createdAt: 0,
})

const week = (key: string): RollupPeriod => ({ kind: 'week', key })
const keys = (plans: ReturnType<typeof planRollups>) => plans.map(plan => `${plan.period.kind}:${plan.period.key}`)

// now = Mon 2026-11-23 noon, keepRecentDays 7 → cutoff Mon 2026-11-16 noon.
const base = [
  episode(scope, 'e0', { startedAt: at(2026, 11, 1) }), // Sun, W44 → month 2026-10
  episode(scope, 'e1', { startedAt: at(2026, 11, 3) }), // W45
  episode(scope, 'e2', { startedAt: at(2026, 11, 5) }), // W45
  episode(scope, 'e3', { startedAt: at(2026, 11, 10) }), // W46
  episode(scope, 'e4', { startedAt: at(2026, 11, 12) }), // W46
  episode(scope, 'e5', { startedAt: at(2026, 11, 17) }), // W47, still recent
]

describe('planRollups', () => {
  it('plans nothing while the distant tier fits its quota', () => {
    expect(planRollups(index(scope, base), options({ distantQuotaTokens: 250 }))).toEqual([])
  })

  it('rolls up the oldest complete weeks first and stops once the load fits', () => {
    const one = planRollups(index(scope, base), options({ distantQuotaTokens: 200 }))
    expect(keys(one)).toEqual(['week:2026-W44'])
    expect(one[0]).toMatchObject({ episodeIds: ['e0'], replacedTokens: 50, from: at(2026, 10, 26, 0), to: at(2026, 11, 2, 0) })

    expect(keys(planRollups(index(scope, base), options({ distantQuotaTokens: 120 })))).toEqual(['week:2026-W44', 'week:2026-W45'])
    expect(keys(planRollups(index(scope, base), options({ distantQuotaTokens: 0 })))).toEqual(['week:2026-W44', 'week:2026-W45', 'week:2026-W46'])
  })

  it('never merges pinned or hidden episodes', () => {
    const episodes = base.map(meta =>
      meta.id === 'e0' ? { ...meta, pinned: true } : meta.id === 'e1' ? { ...meta, hidden: true } : meta)
    const plans = planRollups(index(scope, episodes), options({ distantQuotaTokens: 0 }))
    expect(keys(plans)).toEqual(['week:2026-W45', 'week:2026-W46'])
    expect(plans[0]?.episodeIds).toEqual(['e2'])
    expect(plans.flatMap(plan => plan.episodeIds)).not.toContain('e0')
    expect(plans.flatMap(plan => plan.episodeIds)).not.toContain('e1')
  })

  it('counts pinned gists in the load even though they are never merged', () => {
    const episodes = [
      episode(scope, 'pinned', { startedAt: at(2026, 11, 3), pinned: true, tokens: { raw: 1, gist: 400 } }),
      episode(scope, 'plain', { startedAt: at(2026, 11, 10) }),
    ]
    expect(keys(planRollups(index(scope, episodes), options({ distantQuotaTokens: 420 })))).toEqual(['week:2026-W46'])
  })

  it('keeps recent episodes and incomplete weeks out', () => {
    expect(keys(planRollups(index(scope, base), options({ distantQuotaTokens: 0, keepRecentDays: 10 })))).toEqual(['week:2026-W44', 'week:2026-W45'])
    const late = [...base, episode(scope, 'late', { startedAt: at(2026, 11, 15, 23), endedAt: at(2026, 11, 16, 13) })]
    expect(keys(planRollups(index(scope, late), options({ distantQuotaTokens: 0 })))).toEqual(['week:2026-W44', 'week:2026-W45'])
  })

  it('waits for pending summaries but not for failed episodes', () => {
    const sealed = base.map(meta => (meta.id === 'e2' ? { ...meta, status: 'sealed' as const } : meta))
    expect(keys(planRollups(index(scope, sealed), options({ distantQuotaTokens: 0 })))).toEqual(['week:2026-W44', 'week:2026-W46'])
    const failed = base.map(meta => (meta.id === 'e2' ? { ...meta, status: 'failed' as const } : meta))
    const plans = planRollups(index(scope, failed), options({ distantQuotaTokens: 0 }))
    expect(keys(plans)).toEqual(['week:2026-W44', 'week:2026-W45', 'week:2026-W46'])
    expect(plans[1]?.episodeIds).toEqual(['e1'])
  })

  it('skips periods that already have a rollup and counts rollup tokens instead of covered gists', () => {
    const rollups = [rollup(week('2026-W44'), ['e0'], 20), rollup(week('2026-W45'), ['e1', 'e2'], 30)]
    // load = 20 + 30 + e3 + e4 = 150
    expect(planRollups(index(scope, base, rollups), options({ distantQuotaTokens: 150 }))).toEqual([])
    expect(keys(planRollups(index(scope, base, rollups), options({ distantQuotaTokens: 0 })))).toEqual(['week:2026-W46'])
  })

  it('skips a period when the estimated rollup would not save tokens', () => {
    const plans = planRollups(index(scope, base), options({
      distantQuotaTokens: 0,
      estimateRollupTokens: period => (period.key === '2026-W45' ? 500 : 10),
    }))
    expect(keys(plans)).toEqual(['week:2026-W44', 'week:2026-W46'])
  })

  describe('months', () => {
    // now = 2026-12-15 noon → cutoff 2026-12-08 noon; November (W45–W48) ended 2026-11-30.
    const later = options({ now: at(2026, 12, 15), distantQuotaTokens: 0 })
    const novemberWeeks = [
      rollup(week('2026-W45'), ['e1', 'e2'], 30),
      rollup(week('2026-W46'), ['e3', 'e4'], 30),
      rollup(week('2026-W47'), ['e5'], 30),
    ]

    it('merges a month once its weeks are rolled up, after any remaining weeks', () => {
      const plans = planRollups(index(scope, base, novemberWeeks), later)
      expect(keys(plans)).toEqual(['week:2026-W44', 'month:2026-11'])
      expect(plans[1]).toMatchObject({
        episodeIds: ['e1', 'e2', 'e3', 'e4', 'e5'],
        replacedTokens: 90,
        from: at(2026, 11, 2, 0),
        to: at(2026, 11, 30, 0),
      })
    })

    it('does not merge a month while one of its weeks with gists has no rollup', () => {
      const plans = planRollups(index(scope, base, novemberWeeks.slice(0, 2)), later)
      expect(keys(plans)).toEqual(['week:2026-W44', 'week:2026-W47'])
    })

    it('needs at least two week rollups and a finished month', () => {
      const single = planRollups(index(scope, base.slice(1, 3), [novemberWeeks[0]!]), later)
      expect(single).toEqual([])
      expect(keys(planRollups(index(scope, base, novemberWeeks), options({ now: at(2026, 12, 3), distantQuotaTokens: 0 }))))
        .toEqual(['week:2026-W44'])
    })

    it('absorbs gists summarized after their week was rolled up', () => {
      const lateGist = episode(scope, 'e6', { startedAt: at(2026, 11, 13) })
      const plans = planRollups(index(scope, [...base, lateGist], novemberWeeks), later)
      expect(plans.find(plan => plan.period.kind === 'month')).toMatchObject({ replacedTokens: 140 })
      expect(plans.find(plan => plan.period.kind === 'month')?.episodeIds).toContain('e6')
    })

    it('ignores week rollups superseded by a month rollup', () => {
      const rollups = [...novemberWeeks, rollup({ kind: 'month', key: '2026-11' }, ['e1', 'e2', 'e3', 'e4', 'e5'], 40)]
      // load = month 40 + e0 50 = 90; superseded week rollups (90) are not counted.
      expect(planRollups(index(scope, base, rollups), { ...later, distantQuotaTokens: 90 })).toEqual([])
      expect(keys(planRollups(index(scope, base, rollups), later))).toEqual(['week:2026-W44'])
    })
  })
})

describe('rollupMembers', () => {
  it('returns the mergeable episodes of a period by start time', () => {
    const episodes = [...base, episode(scope, 'pin', { startedAt: at(2026, 11, 4), pinned: true })]
    const now = at(2026, 12, 15)
    expect(rollupMembers(index(scope, episodes), week('2026-W45'), { now, keepRecentDays: 7 }).map(meta => meta.id)).toEqual(['e1', 'e2'])
    expect(rollupMembers(index(scope, episodes), { kind: 'month', key: '2026-10' }, { now, keepRecentDays: 7 }).map(meta => meta.id)).toEqual(['e0'])
    expect(rollupMembers(index(scope, episodes), { kind: 'month', key: '2026-11' }, { now: at(2026, 11, 23), keepRecentDays: 7 }).map(meta => meta.id))
      .toEqual(['e1', 'e2', 'e3', 'e4'])
  })
})
