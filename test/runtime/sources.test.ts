import { describe, expect, it } from 'vitest'
import type { EpisodeId, EpisodeMeta, MemoryIndex, RollupEntry } from '../../src/contracts.ts'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import { createMemoryPacker, createTokenEstimator, resolveBudget } from '../../src/pack/index.ts'
import { createPackSourceLoader, leakingRollupPeriods } from '../../src/runtime/sources.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 23, 7)
const WEEK_START = Date.UTC(2026, 9, 5, 2)

function episode(index: number, patch: Partial<EpisodeMeta> = {}): EpisodeMeta {
  const startedAt = WEEK_START + index * DAY
  return {
    id: `2026100${5 + index}-1000_owner000_${index}` as EpisodeId,
    scope: OWNER_SCOPE,
    sessionId: `s-${index}`,
    dir: `episodes/2026/10/e${index}`,
    seqRange: { first: 1, last: 2 },
    startedAt,
    endedAt: startedAt + 60_000,
    status: 'summarized',
    tokens: { raw: 100, summary: 40, gist: 12 },
    importance: 5,
    strength: 1,
    pinned: false,
    hidden: false,
    keywords: [],
    summarizer: { provider: 'fake', model: 'fake-1', promptVersion: 't', summarizedAt: startedAt + 120_000 },
    ...patch,
  }
}

function rollup(kind: 'week' | 'month', key: string, members: readonly EpisodeMeta[]): RollupEntry {
  return {
    id: key,
    scope: OWNER_SCOPE,
    period: { kind, key },
    episodeIds: members.map(meta => meta.id),
    from: Math.min(...members.map(meta => meta.startedAt)),
    to: Math.max(...members.map(meta => meta.endedAt ?? meta.startedAt)),
    tokens: 20,
    file: `rollups/${key}.md`,
    createdAt: NOW - DAY,
  }
}

function loaderFor(index: MemoryIndex, rollupTexts: Record<string, string>) {
  return createPackSourceLoader({
    readIndex: async () => index,
    readTier: async (_scope, id, tier) => tier === 'gist' ? `第 ${id.slice(-1)} 段的总结：${'散步、聊天、看书和做饭。'.repeat(6)}` : undefined,
    readTierDocument: async (_scope, id) => ({ fields: {}, body: `第 ${id.slice(-1)} 段的摘要。` }),
    readRollup: async (_scope, id) => rollupTexts[id],
    readProfile: async () => undefined,
  })
}

describe('pack sources and hidden episodes', () => {
  const [e1, e2, e3, e4] = [episode(0), episode(1), episode(2), episode(8)] as [EpisodeMeta, EpisodeMeta, EpisodeMeta, EpisodeMeta]
  const week = rollup('week', '2026-W41', [e1, e2, e3])
  const otherWeek = rollup('week', '2026-W42', [e4])
  const texts = { '2026-W41': '这周：散步；还有 SECRET-HIDDEN 的内容。', '2026-W42': '下一周：看书。', '2026-10': '十月：散步、看书，还有 SECRET-HIDDEN 的内容。' }

  it('drops every rollup that lists a hidden episode, and the coarser rollups built from it', async () => {
    const hidden = { ...e2, hidden: true }
    const month = rollup('month', '2026-10', [e1, e3, e4])
    const index: MemoryIndex = { version: 1, scope: OWNER_SCOPE, episodes: [e1, hidden, e3, e4], rollups: [week, otherWeek, month], updatedAt: NOW }
    expect([...leakingRollupPeriods(index)].sort()).toEqual(['month:2026-10', 'week:2026-W41', 'year:2026'])

    const sources = await loaderFor(index, texts).load(OWNER_SCOPE)
    expect(sources.rollups.map(item => item.entry.id)).toEqual(['2026-W42'])
    expect(sources.candidates.map(candidate => candidate.meta.id)).toEqual([e1.id, e3.id, e4.id])
    expect(JSON.stringify(sources)).not.toContain('SECRET-HIDDEN')
  })

  it('keeps every rollup while no member is hidden', async () => {
    const index: MemoryIndex = { version: 1, scope: OWNER_SCOPE, episodes: [e1, e2, e3, e4], rollups: [week, otherWeek], updatedAt: NOW }
    expect(leakingRollupPeriods(index).size).toBe(0)
    const sources = await loaderFor(index, texts).load(OWNER_SCOPE)
    expect(sources.rollups.map(item => item.entry.id)).toEqual(['2026-W41', '2026-W42'])
  })

  it('never lets a packed block show a hidden episode through a rollup on a tight distant tier', async () => {
    const estimator = createTokenEstimator()
    const packer = createMemoryPacker({ estimator })
    const base = resolveBudget({ level: 3, capacity: { contextWindow: 131072, reservedOutputTokens: 8192 }, headroomTokens: 8192, memoryShare: 0.25 })
    const budget = { ...base, memoryBudgetTokens: 200, recentSummaryCount: 0, quotas: { ongoing: 0, profile: 0, recent: 0, distant: 200 } }
    const pack = async (index: MemoryIndex) => packer.pack({ ...await loaderFor(index, texts).load(OWNER_SCOPE), budget, mode: 'session-start', halfLifeDays: 14, now: NOW }).text
    const visible: MemoryIndex = { version: 1, scope: OWNER_SCOPE, episodes: [e1, e2, e3], rollups: [week], updatedAt: NOW }
    expect(await pack(visible)).toContain('SECRET-HIDDEN')
    const hidden: MemoryIndex = { ...visible, episodes: [e1, { ...e2, hidden: true }, e3] }
    expect(await pack(hidden)).not.toContain('SECRET-HIDDEN')
  })
})
