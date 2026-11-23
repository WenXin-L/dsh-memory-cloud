import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EpisodeId, ResolvedBudget, ScopeId, SummaryRoute } from '../../src/contracts.ts'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import { createTokenEstimator, resolveBudget } from '../../src/pack/index.ts'
import { createSummaryService } from '../../src/runtime/summaries.ts'
import { createPackSourceLoader, EMPTY_EPISODE_ERROR, isEmptyEpisode } from '../../src/runtime/sources.ts'
import { createTakeoverStateFile } from '../../src/runtime/takeover-state.ts'
import { createFileMemoryStore } from '../../src/store/index.ts'
import { isoWeekKey, JobDeferredError } from '../../src/summarize/jobs/index.ts'
import { scriptedLlm, summaryJson } from '../summarize/helpers.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 10, 23, 7)
const DAY = 86_400_000
const estimator = createTokenEstimator()
const budget: ResolvedBudget = resolveBudget({ level: 3, capacity: { contextWindow: 131072, reservedOutputTokens: 8192 }, headroomTokens: 8192, memoryShare: 0.25 })
const logger = { debug() {}, info() {}, warn() {} }

async function setup(
  replies: Parameters<typeof scriptedLlm>[0],
  options: { readonly hostReady?: () => boolean; readonly route?: () => SummaryRoute; readonly timeZone?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'mcb-summaries-'))
  roots.push(root)
  const clock = { now: () => NOW }
  const store = createFileMemoryStore({ root, clock, estimator })
  const { llm, calls } = scriptedLlm(replies)
  const service = createSummaryService({
    store,
    llm,
    estimator,
    clock,
    logger,
    backgroundRoute: async () => options.route?.() ?? { provider: 'fake', model: 'fake-1' },
    levelBudget: async () => budget,
    maxAttempts: 8,
    ...options.hostReady === undefined ? {} : { hostReady: options.hostReady },
    ...options.timeZone === undefined ? {} : { timeZone: options.timeZone },
  })
  return { root, store, service, calls }
}

async function sealed(store: ReturnType<typeof createFileMemoryStore>, scope: ScopeId, startedAt: number, texts: readonly string[]): Promise<EpisodeId> {
  const meta = await store.openEpisode(scope, { sessionId: `s-${startedAt}`, startedAt, firstSeq: 1 })
  await store.appendRaw(scope, meta.id, texts.map((text, index) => ({
    seq: index + 1,
    time: startedAt + index,
    type: index % 2 === 0 ? 'user/message' : 'assistant/message',
    data: index % 2 === 0 ? { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } : { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  })))
  await store.sealEpisode(scope, meta.id, { reason: 'end', endedAt: startedAt + texts.length, lastSeq: Math.max(1, texts.length), rawTokens: 10 })
  return meta.id
}

describe('summary jobs', () => {
  it('summarizes a sealed episode with the level targets, logs it, and is a no-op afterwards', async () => {
    const { root, store, service, calls } = await setup([{ text: summaryJson() }])
    const id = await sealed(store, OWNER_SCOPE, NOW - DAY, ['明天要面试', '加油'])
    await service.summarizeEpisode(OWNER_SCOPE, id, new AbortController().signal)
    await service.summarizeEpisode(OWNER_SCOPE, id, new AbortController().signal)
    await service.summarizeEpisode(OWNER_SCOPE, 'missing' as EpisodeId, new AbortController().signal)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: 'fake', model: 'fake-1' })
    expect(JSON.stringify(calls[0]?.messages)).toContain(`${budget.recentSummaryTokens}`)
    const meta = (await store.readIndex(OWNER_SCOPE)).episodes.find(episode => episode.id === id)
    expect(meta).toMatchObject({ status: 'summarized', importance: 7 })
    expect(meta?.tokens.summary).toBeGreaterThan(0)
    const log = (await readFile(join(root, 'logs', 'summarizer.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(log).toMatchObject([{ kind: 'episode', ok: true, episode: id, provider: 'fake' }])
  })

  it('renders the transcript and the prompt clock in the configured time zone', async () => {
    const { store, service, calls } = await setup([{ text: summaryJson() }], { timeZone: 'America/New_York' })
    const id = await sealed(store, OWNER_SCOPE, NOW - DAY, ['明天要面试', '加油'])
    await service.summarizeEpisode(OWNER_SCOPE, id, new AbortController().signal)
    const prompt = JSON.stringify(calls[0]?.messages)
    expect(prompt).toContain('时区 America/New_York')
    expect(prompt).toContain('2026-11-23 周一 02:00')
    expect(prompt).toContain('[2026-11-22 周日 02:00] User: 明天要面试')
    expect(prompt).not.toContain('07:00')
  })

  it('marks an episode without conversation permanently instead of retrying it', async () => {
    const { store, service, calls } = await setup([])
    const id = await sealed(store, OWNER_SCOPE, NOW - DAY, [])
    await service.summarizeEpisode(OWNER_SCOPE, id, new AbortController().signal)
    const meta = (await store.readIndex(OWNER_SCOPE)).episodes.find(episode => episode.id === id)!
    expect(calls).toEqual([])
    expect(meta).toMatchObject({ status: 'failed', attempts: 8 })
    expect(meta.lastError?.startsWith(EMPTY_EPISODE_ERROR)).toBe(true)
    expect(isEmptyEpisode(meta)).toBe(true)
  })

  it('leaves an episode already marked empty alone when it is queued again', async () => {
    const { root, store, service } = await setup([])
    const id = await sealed(store, OWNER_SCOPE, NOW - DAY, [])
    await service.summarizeEpisode(OWNER_SCOPE, id, new AbortController().signal)
    const marked = (await store.readIndex(OWNER_SCOPE)).episodes.find(episode => episode.id === id)
    await service.summarizeEpisode(OWNER_SCOPE, id, new AbortController().signal)
    expect((await store.readIndex(OWNER_SCOPE)).episodes.find(episode => episode.id === id)).toEqual(marked)
    const log = (await readFile(join(root, 'logs', 'summarizer.jsonl'), 'utf8')).trim().split('\n')
    expect(log).toHaveLength(1)
  })

  it('defers instead of failing while the host is going away or no model route exists', async () => {
    let ready = false
    let route: SummaryRoute = { provider: 'fake', model: 'fake-1' }
    const { root, store, service, calls } = await setup(() => {
      ready = false
      return { finish: 'error', error: 'adapter disposed' }
    }, { hostReady: () => ready, route: () => route })
    const id = await sealed(store, OWNER_SCOPE, NOW - DAY, ['明天要面试', '加油'])
    const signal = new AbortController().signal

    await expect(service.summarizeEpisode(OWNER_SCOPE, id, signal)).rejects.toBeInstanceOf(JobDeferredError)
    expect(calls).toEqual([])

    ready = true
    await expect(service.summarizeEpisode(OWNER_SCOPE, id, signal)).rejects.toBeInstanceOf(JobDeferredError)
    expect(calls).toHaveLength(1)

    ready = true
    route = { provider: '', model: 'deepseek-flash' }
    await expect(service.summarizeEpisode(OWNER_SCOPE, id, signal)).rejects.toBeInstanceOf(JobDeferredError)
    expect(calls).toHaveLength(1)

    expect((await store.readIndex(OWNER_SCOPE)).episodes.find(episode => episode.id === id)).toMatchObject({ status: 'sealed' })
    await expect(readFile(join(root, 'logs', 'summarizer.jsonl'), 'utf8')).rejects.toThrow()
  })

  it('plans and builds a week rollup from old summarized episodes', async () => {
    const { store, service, calls } = await setup([{ text: '这一周主要在准备搬家和面试。' }])
    const weekStart = Date.UTC(2026, 9, 5, 2)
    const ids: EpisodeId[] = []
    for (let day = 0; day < 5; day++) {
      const id = await sealed(store, OWNER_SCOPE, weekStart + day * DAY, [`第 ${day} 天`, '好'])
      await store.writeSummary(OWNER_SCOPE, id, JSON.parse(summaryJson({ gist: `第 ${day} 天的总结。` })), { provider: 'fake', model: 'fake-1', promptVersion: 't', summarizedAt: NOW }, { summary: 40, gist: 30 })
      ids.push(id)
    }
    const index = await store.readIndex(OWNER_SCOPE)
    const plans = service.planRollups(index, 100, budget.gistTokens)
    expect(plans.map(plan => plan.period)).toEqual([{ kind: 'week', key: isoWeekKey(weekStart) }])
    expect(service.planRollups(index, 10_000, budget.gistTokens)).toEqual([])

    await service.buildRollup(OWNER_SCOPE, plans[0]!.period, new AbortController().signal)
    await service.buildRollup(OWNER_SCOPE, plans[0]!.period, new AbortController().signal)
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0]?.messages)).toContain('第 4 天的总结')
    const after = await store.readIndex(OWNER_SCOPE)
    expect(after.rollups).toMatchObject([{ id: isoWeekKey(weekStart), episodeIds: ids, file: `rollups/${isoWeekKey(weekStart)}.md` }])
    expect(await store.readRollup(OWNER_SCOPE, isoWeekKey(weekStart))).toBe('这一周主要在准备搬家和面试。')
  })
})

describe('pack sources', () => {
  it('reads promises and dates from the summary frontmatter and caches them with the tier texts', async () => {
    const { store } = await setup([])
    const id = await sealed(store, OWNER_SCOPE, NOW - DAY, ['明天要面试', '加油'])
    await store.writeSummary(OWNER_SCOPE, id, JSON.parse(summaryJson({ dates: [], promises: [{ what: '寄出报告', who: '用户', due: '2026-12-01' }] })), { provider: 'fake', model: 'fake-1', promptVersion: 't', summarizedAt: NOW }, { summary: 40, gist: 10 })
    let reads = 0
    const loader = createPackSourceLoader({
      readIndex: scope => store.readIndex(scope),
      readTier: (scope, episode, tier) => store.readTier(scope, episode, tier),
      readTierDocument: (scope, episode, tier) => {
        reads += 1
        return store.readTierDocument(scope, episode, tier)
      },
      readRollup: (scope, rollup) => store.readRollup(scope, rollup),
      readProfile: scope => store.readProfile(scope),
    })
    const first = await loader.load(OWNER_SCOPE)
    expect(first.candidates).toHaveLength(1)
    expect(first.candidates[0]).toMatchObject({ summary: expect.stringContaining('面试'), gist: '用户聊到明天的面试。', promises: [{ what: '寄出报告', who: '用户', due: '2026-12-01' }] })
    expect(first.candidates[0]).not.toHaveProperty('dates')
    await loader.load(OWNER_SCOPE)
    expect(reads).toBe(1)
  })
})

describe('takeover state file', () => {
  it('keeps records per profile and tolerates a corrupt file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcb-takeover-'))
    roots.push(root)
    const web = createTakeoverStateFile(root, 'web')
    const desktop = createTakeoverStateFile(root, 'desktop')
    expect(await web.get()).toBeUndefined()
    const record = { entryId: 'preset-standard', presetId: 'standard', inheritedHash: 'a', takeoverHash: 'b', at: NOW }
    await web.set({ 'preset-standard': record })
    expect(await web.get()).toEqual({ 'preset-standard': record })
    expect(await desktop.get()).toBeUndefined()
    await desktop.set({})
    expect(await web.get()).toEqual({ 'preset-standard': record })

    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'takeover.json'), '{not json')
    expect(await web.get()).toBeUndefined()
    await web.set({ 'preset-standard': record })
    expect(await web.get()).toEqual({ 'preset-standard': record })
  })
})
