import { describe, expect, it } from 'vitest'
import type { ScopeId } from '../../src/contracts.ts'
import { OWNER_SCOPE, RUNTIME_CONTEXT_SOURCE_KIND } from '../../src/contracts.ts'
import { createMemorySearch } from '../../src/tools/search.ts'
import { parseDateBound } from '../../src/tools/text.ts'
import { assistantRecord, at, estimator, eventRecord, stepRecord, userRecord, withTempStore } from './helpers.ts'
import type { FakeStore, SeedEpisode } from './helpers.ts'

const owner = OWNER_SCOPE

const corpus: SeedEpisode[] = [
  {
    id: '20261101-1000_aaaa1111_1',
    startedAt: at(2026, 11, 1, 10),
    gist: '聊了猫粮品牌，决定买皇家猫粮。',
    summary: '用户说家里的猫咪小橘最近挑食，我们比较了几个猫粮品牌，最后决定试试皇家猫粮的室内配方。',
    keywords: ['猫粮', '皇家'],
    people: ['小橘'],
  },
  {
    id: '20261103-0800_aaaa1111_2',
    startedAt: at(2026, 11, 3, 8),
    gist: '整理了购物清单。',
    summary: '用户列购物清单：牛奶、鸡蛋，顺便提到猫粮快吃完了。',
    keywords: ['购物'],
  },
  {
    id: '20261105-2100_aaaa1111_3',
    startedAt: at(2026, 11, 5, 21),
    gist: '讨论周末去杭州西湖旅行的计划。',
    summary: '用户计划周末和朋友小明去杭州，想看西湖和灵隐寺，我们查了高铁时间。',
    keywords: ['旅行', '杭州'],
    people: ['小明'],
    dates: ['2026-11-08'],
  },
  {
    id: '20261110-0900_bbbb2222_1',
    startedAt: at(2026, 11, 10, 9),
    gist: 'Helped the user with TypeScript generics.',
    summary: 'We discussed TypeScript generics and conditional types; the user struggled with infer.',
    keywords: ['typescript', 'generics'],
  },
  {
    id: '20261115-2000_bbbb2222_2',
    startedAt: at(2026, 11, 15, 20),
    gist: 'Planned a surprise birthday party for Alice.',
    summary: 'The user is organizing a surprise birthday party for Alice on November 30 and ordered a chocolate cake.',
    keywords: ['birthday', 'party'],
    people: ['Alice'],
    dates: ['2026-11-30'],
  },
  {
    id: '20261116-2000_bbbb2222_3',
    startedAt: at(2026, 11, 16, 20),
    gist: 'Talked about cake recipes.',
    summary: 'The user asked how to bake a sponge cake at home.',
    keywords: ['baking'],
  },
  {
    id: '20261118-1500_cccc3333_1',
    startedAt: at(2026, 11, 18, 15),
    gist: '随便聊了天气。',
    summary: '今天天气很冷，用户说要多穿衣服，猫咪在晒太阳。',
    keywords: ['天气'],
  },
  {
    id: '20261119-1500_cccc3333_2',
    startedAt: at(2026, 11, 19, 15),
    gist: '猫粮过敏的秘密。',
    summary: '用户不想再提起猫粮过敏的事。',
    keywords: ['猫粮'],
    hidden: true,
  },
  {
    id: '20261120-1000_dddd4444_1',
    startedAt: at(2026, 11, 20, 10),
    status: 'sealed',
    raw: [
      stepRecord(at(2026, 11, 20, 10)),
      userRecord('我把红色雨伞忘在咖啡馆了', at(2026, 11, 20, 10, 1)),
      assistantRecord('别担心，明天可以回去问店员。', at(2026, 11, 20, 10, 2)),
    ],
  },
]

async function seeded(store: FakeStore, extra: readonly SeedEpisode[] = []): Promise<void> {
  await store.seed(owner, [...corpus, ...extra])
}

describe('createMemorySearch', () => {
  it('ranks Chinese matches with bigrams, keywords and phrase bonus first', async () => {
    await withTempStore(async store => {
      await seeded(store)
      const search = createMemorySearch({ store, estimator })
      const result = await search.search({ scope: owner, query: '猫粮品牌' })
      expect(result.hits.map(hit => hit.id)).toEqual(['20261101-1000_aaaa1111_1', '20261103-0800_aaaa1111_2'])
      expect(result.total).toBe(2)
      expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score)
      expect(result.hits[0]!.gist).toBe('聊了猫粮品牌，决定买皇家猫粮。')
      expect(result.hits[0]!.date).toBe('2026-11-01')
    })
  })

  it('ignores particles in natural-language Chinese queries and boosts people', async () => {
    await withTempStore(async store => {
      await seeded(store)
      const search = createMemorySearch({ store, estimator })
      const result = await search.search({ scope: owner, query: '上次和小明去哪里玩了？' })
      expect(result.hits[0]?.id).toBe('20261105-2100_aaaa1111_3')
    })
  })

  it('ranks English matches case-insensitively with plural folding', async () => {
    await withTempStore(async store => {
      await seeded(store)
      const search = createMemorySearch({ store, estimator })
      const party = await search.search({ scope: owner, query: 'Birthday cakes for Alice' })
      expect(party.hits[0]?.id).toBe('20261115-2000_bbbb2222_2')
      expect(party.hits.map(hit => hit.id)).toContain('20261116-2000_bbbb2222_3')
      expect(party.total).toBe(2)
      const strict = await search.search({ scope: owner, query: 'What did we plan for Alice birthday cakes?' })
      expect(strict.hits.map(hit => hit.id)).toEqual(['20261115-2000_bbbb2222_2'])
      const generics = await search.search({ scope: owner, query: 'TYPESCRIPT' })
      expect(generics.hits.map(hit => hit.id)).toEqual(['20261110-0900_bbbb2222_1'])
    })
  })

  it('does not boost short ASCII keywords that merely occur inside query words', async () => {
    await withTempStore(async store => {
      await seeded(store, [{ id: '20261121-1000_eeee5555_1', startedAt: at(2026, 11, 21), gist: 'Chatted.', summary: 'Small talk.', keywords: ['ai'] }])
      const search = createMemorySearch({ store, estimator })
      const result = await search.search({ scope: owner, query: 'explain' })
      expect(result.total).toBe(0)
    })
  })

  it('reports the true total independent of limit', async () => {
    await withTempStore(async store => {
      const coffee = Array.from({ length: 12 }, (_, index): SeedEpisode => ({
        id: `202611${String(19 + index).padStart(2, '0')}-2300_ffff6666_${index + 1}`,
        startedAt: at(2026, 11, 19 + index, 23),
        gist: `喝了一杯拿铁咖啡 ${index + 1}`,
        summary: '用户分享了今天的咖啡。',
        keywords: ['咖啡'],
      }))
      await seeded(store, coffee)
      const search = createMemorySearch({ store, estimator })
      const result = await search.search({ scope: owner, query: '咖啡', limit: 3 })
      expect(result.total).toBe(12)
      expect(result.hits).toHaveLength(3)

      const ranged = await search.search({
        scope: owner,
        query: '咖啡',
        from: parseDateBound('2026-11-20', 'from')!,
        to: parseDateBound('2026-11-25', 'to')!,
        limit: 50,
      })
      expect(ranged.total).toBe(6)
      expect(ranged.hits.map(hit => hit.date).sort()).toEqual(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25'])
    })
  })

  it('filters by date range and lists everything in range for an empty query', async () => {
    await withTempStore(async store => {
      await seeded(store)
      const search = createMemorySearch({ store, estimator })
      const result = await search.search({
        scope: owner,
        query: '',
        from: parseDateBound('2026-11-05', 'from')!,
        to: parseDateBound('2026-11-15', 'to')!,
      })
      expect(result.hits.map(hit => hit.id)).toEqual([
        '20261115-2000_bbbb2222_2',
        '20261110-0900_bbbb2222_1',
        '20261105-2100_aaaa1111_3',
      ])
      expect(result.total).toBe(3)
    })
  })

  it('matches dates named in the query against start dates and summary facts', async () => {
    await withTempStore(async store => {
      await seeded(store)
      const search = createMemorySearch({ store, estimator })
      const trip = await search.search({ scope: owner, query: '11月8日' })
      expect(trip.hits.map(hit => hit.id)).toEqual(['20261105-2100_aaaa1111_3'])
      const day = await search.search({ scope: owner, query: '2026-11-18' })
      expect(day.hits.map(hit => hit.id)).toEqual(['20261118-1500_cccc3333_1'])
    })
  })

  it('excludes hidden episodes and slightly prefers pinned ones', async () => {
    await withTempStore(async store => {
      await seeded(store, [
        { id: '20261122-1000_gggg7777_1', startedAt: at(2026, 11, 22), gist: '讨论了吉他和弦', summary: '吉他练习。', keywords: ['吉他'], pinned: true },
        { id: '20261123-1000_gggg7777_2', startedAt: at(2026, 11, 23), gist: '讨论了吉他和弦', summary: '吉他练习。', keywords: ['吉他'] },
      ])
      const search = createMemorySearch({ store, estimator })
      const secret = await search.search({ scope: owner, query: '猫粮过敏' })
      expect(secret.hits.map(hit => hit.id)).not.toContain('20261119-1500_cccc3333_2')
      const guitar = await search.search({ scope: owner, query: '吉他' })
      expect(guitar.hits.map(hit => hit.id)).toEqual(['20261122-1000_gggg7777_1', '20261123-1000_gggg7777_2'])
    })
  })

  it('searches raw transcripts only when includeRaw is set, with a snippet as the gist', async () => {
    await withTempStore(async store => {
      await seeded(store)
      const search = createMemorySearch({ store, estimator })
      expect((await search.search({ scope: owner, query: '红色雨伞' })).total).toBe(0)
      const raw = await search.search({ scope: owner, query: '红色雨伞', includeRaw: true })
      expect(raw.hits.map(hit => hit.id)).toEqual(['20261120-1000_dddd4444_1'])
      expect(raw.hits[0]!.gist).toContain('红色雨伞')
      expect(raw.rawPartial).toBeUndefined()
    })
  })

  it('scans only the conversation records of raw transcripts', async () => {
    await withTempStore(async store => {
      await seeded(store, [{
        id: '20261122-1000_ffff6666_1',
        startedAt: at(2026, 11, 22, 10),
        status: 'sealed',
        raw: [
          userRecord('<system-reminder>紫色望远镜</system-reminder>', at(2026, 11, 22, 10), undefined, { kind: RUNTIME_CONTEXT_SOURCE_KIND }),
          eventRecord('session/title', { title: '紫色望远镜' }, at(2026, 11, 22, 10)),
          userRecord('今天去了植物园', at(2026, 11, 22, 10, 1)),
        ],
      }])
      const search = createMemorySearch({ store, estimator })
      expect((await search.search({ scope: owner, query: '紫色望远镜', includeRaw: true })).total).toBe(0)
      expect((await search.search({ scope: owner, query: '植物园', includeRaw: true })).hits.map(hit => hit.id)).toEqual(['20261122-1000_ffff6666_1'])
    })
  })

  it('bounds raw scanning and flags a partial scan', async () => {
    await withTempStore(async store => {
      await seeded(store)
      const search = createMemorySearch({ store, estimator, options: { rawScanEpisodes: 2 } })
      const result = await search.search({ scope: owner, query: '雨伞', includeRaw: true })
      expect(result.rawPartial).toBe(true)
      expect(store.calls.readRaw).toBeLessThanOrEqual(2)
      const tiny = createMemorySearch({ store, estimator, options: { rawScanTokens: 1 } })
      expect((await tiny.search({ scope: owner, query: '雨伞', includeRaw: true })).rawPartial).toBe(true)
    })
  })

  it('rebuilds lazily when index.updatedAt changes and re-reads only changed episodes', async () => {
    await withTempStore(async store => {
      await seeded(store)
      const search = createMemorySearch({ store, estimator })
      await Promise.all([search.search({ scope: owner, query: '猫粮' }), search.search({ scope: owner, query: '杭州' })])
      const firstBuild = store.calls.readTier
      expect(firstBuild).toBe(16)

      await search.search({ scope: owner, query: '天气' })
      expect(store.calls.readTier).toBe(firstBuild)

      await store.updateEpisode(owner, '20261118-1500_cccc3333_1' as never, { pinned: true })
      await search.search({ scope: owner, query: '天气' })
      expect(store.calls.readTier).toBe(firstBuild)

      await store.resummarize(owner, '20261118-1500_cccc3333_1', '一起去看了初雪。')
      const snow = await search.search({ scope: owner, query: '初雪' })
      expect(store.calls.readTier).toBe(firstBuild + 2)
      expect(snow.hits.map(hit => hit.id)).toEqual(['20261118-1500_cccc3333_1'])
    })
  })

  it('keeps scopes apart', async () => {
    await withTempStore(async store => {
      await seeded(store)
      const group = 'qq-group-42' as ScopeId
      await store.seed(group, [{ id: '20261121-1200_hhhh8888_1', startedAt: at(2026, 11, 21), gist: '群里讨论猫粮团购。', summary: '群友拼单买猫粮。', keywords: ['猫粮'] }])
      const search = createMemorySearch({ store, estimator })
      const inGroup = await search.search({ scope: group, query: '猫粮' })
      expect(inGroup.hits.map(hit => hit.id)).toEqual(['20261121-1200_hhhh8888_1'])
      const inOwner = await search.search({ scope: owner, query: '猫粮' })
      expect(inOwner.hits.map(hit => hit.id)).not.toContain('20261121-1200_hhhh8888_1')
    })
  })
})
