import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EpisodeId, RollupEntry } from '../../src/contracts.ts'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import { renderTierFile } from '../../src/store/index.ts'
import type { FileMemoryStore } from '../../src/store/index.ts'
import {
  BASE_TIME,
  fakeClock,
  listTree,
  makeStore,
  provenance,
  rawRecord,
  records,
  summaryResult,
  useTempRoots,
} from './helpers.ts'
import type { FakeClock } from './helpers.ts'

const newRoot = useTempRoots()

const rollup: RollupEntry = {
  id: '2026-11',
  scope: OWNER_SCOPE,
  period: { kind: 'month', key: '2026-11' },
  episodeIds: [],
  from: Date.UTC(2026, 10, 1),
  to: Date.UTC(2026, 11, 1),
  tokens: 40,
  file: 'rollups/2026-11.md',
  createdAt: Date.UTC(2026, 10, 23),
}

/** Summarized + pinned, sealed, and open episodes plus a rollup. */
async function populate(store: FileMemoryStore) {
  const summarized = await store.openEpisode(OWNER_SCOPE, { sessionId: 'session-a', startedAt: BASE_TIME, firstSeq: 1 })
  await store.appendRaw(OWNER_SCOPE, summarized.id, records(1, 6))
  await store.sealEpisode(OWNER_SCOPE, summarized.id, { reason: 'compaction', endedAt: BASE_TIME + 1000, lastSeq: 5, rawTokens: 50 })
  await store.writeSummary(OWNER_SCOPE, summarized.id, summaryResult(), provenance(), { summary: 30, gist: 8 })
  await store.updateEpisode(OWNER_SCOPE, summarized.id, { pinned: true, strength: 3, lastRecalledAt: BASE_TIME + 5000 })

  const sealed = await store.openEpisode(OWNER_SCOPE, { sessionId: 'session-a', startedAt: BASE_TIME + 2000, firstSeq: 6 })
  await store.appendRaw(OWNER_SCOPE, sealed.id, records(6, 9))
  await store.sealEpisode(OWNER_SCOPE, sealed.id, { reason: 'idle', endedAt: BASE_TIME + 3000, lastSeq: 9, rawTokens: 20 })
  await store.updateEpisode(OWNER_SCOPE, sealed.id, { status: 'failed', lastError: 'timeout', attempts: 2 })

  const open = await store.openEpisode(OWNER_SCOPE, { sessionId: 'session-b', startedAt: BASE_TIME + 4000, firstSeq: 1 })
  await store.appendRaw(OWNER_SCOPE, open.id, records(1, 3))

  await store.writeRollup(OWNER_SCOPE, rollup, '十一月：咖啡。')
  return { summarized, sealed, open }
}

async function setup(): Promise<{ root: string; clock: FakeClock; store: FileMemoryStore; scopeDir: string; indexPath: string }> {
  const root = await newRoot()
  const clock = fakeClock()
  const store = makeStore(root, clock)
  const scopeDir = join(root, 'scopes', 'owner')
  return { root, clock, store, scopeDir, indexPath: join(scopeDir, 'index.json') }
}

describe('index recovery', () => {
  it.each([
    ['truncated JSON', (text: string) => text.slice(0, Math.floor(text.length / 2))],
    ['an empty file', () => ''],
    ['an invalid entry', (text: string) => text.replace('"status":"open"', '"status":"bogus"')],
    ['a foreign scope', (text: string) => text.replace('"scope":"owner"', '"scope":"other"')],
  ])('rebuilds an index with %s from the episode directories and keeps the bad file', async (_label, corrupt) => {
    const { root, clock, store, scopeDir, indexPath } = await setup()
    await populate(store)
    const before = await store.readIndex(OWNER_SCOPE)
    const filesBefore = await listTree(root)
    const bad = corrupt(await readFile(indexPath, 'utf8'))
    await writeFile(indexPath, bad)
    clock.advance(1234)

    const warnings: string[] = []
    const fresh = makeStore(root, clock, { onWarning: message => warnings.push(message) })
    const after = await fresh.readIndex(OWNER_SCOPE)

    expect(after.episodes).toEqual(before.episodes)
    expect(after.rollups).toEqual(before.rollups)
    expect(await readFile(join(scopeDir, `index.json.corrupt-${clock.now()}`), 'utf8')).toBe(bad)
    expect(JSON.parse(await readFile(indexPath, 'utf8')).episodes).toHaveLength(3)
    expect(warnings).toEqual([expect.stringMatching(/index of scope owner was corrupt .*rebuilt 3 episode/)])
    const filesAfter = await listTree(root)
    expect(filesAfter).toEqual(expect.arrayContaining(filesBefore))
  })

  it('notices corruption through its own cache and keeps working afterwards', async () => {
    const { store, indexPath, scopeDir } = await setup()
    const { open } = await populate(store)
    await store.readIndex(OWNER_SCOPE)
    await writeFile(indexPath, '{"version":1,')
    const next = await store.openEpisode(OWNER_SCOPE, { sessionId: 'session-c', startedAt: BASE_TIME, firstSeq: 1 })
    expect(next.id).toBe('20261120-2130_c_4')
    await store.appendRaw(OWNER_SCOPE, open.id, [rawRecord(4)])
    expect((await store.readRaw(OWNER_SCOPE, open.id, { offset: 0, limit: 10 })).total).toBe(4)
    expect((await readdir(scopeDir)).filter(name => name.startsWith('index.json.corrupt-'))).toHaveLength(1)
  })

  it('rebuilds a missing index', async () => {
    const { root, clock, store, indexPath } = await setup()
    await populate(store)
    const before = await store.readIndex(OWNER_SCOPE)
    await rm(indexPath)
    const warnings: string[] = []
    const after = await makeStore(root, clock, { onWarning: message => warnings.push(message) }).readIndex(OWNER_SCOPE)
    expect(after.episodes).toEqual(before.episodes)
    expect(after.rollups).toEqual(before.rollups)
    expect(warnings).toEqual([expect.stringMatching(/was missing; rebuilt 3 episode/)])
  })

  it('adds episodes that a stale but valid index does not list', async () => {
    const { root, clock, store, indexPath } = await setup()
    await populate(store)
    const stale = await readFile(indexPath, 'utf8')
    const extra = await store.openEpisode(OWNER_SCOPE, { sessionId: 'session-c', startedAt: BASE_TIME, firstSeq: 1 })
    await store.updateEpisode(OWNER_SCOPE, extra.id, { hidden: true })
    await writeFile(indexPath, stale)

    const warnings: string[] = []
    const fresh = makeStore(root, clock, { onWarning: message => warnings.push(message) })
    const index = await fresh.readIndex(OWNER_SCOPE)
    expect(index.episodes.map(meta => meta.id).at(-1)).toBe(extra.id)
    expect(index.episodes.at(-1)).toMatchObject({ hidden: true, status: 'open' })
    expect(warnings).toEqual([expect.stringMatching(/lacked 1 episode\(s\) and 0 rollup/)])
    const next = await fresh.openEpisode(OWNER_SCOPE, { sessionId: 'session-d', startedAt: BASE_TIME, firstSeq: 1 })
    expect(next.id.endsWith('_5')).toBe(true)
  })

  it('derives entries for episode directories without meta.json', async () => {
    const { root, clock, scopeDir } = await setup()
    const id = '20261101-0815_legacy01_5' as EpisodeId
    const dir = join(scopeDir, 'episodes', '2026', '11', id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'raw.jsonl'), `${records(3, 8).map(record => JSON.stringify(record)).join('\n')}\n`)
    const front = {
      id,
      scope: OWNER_SCOPE,
      sessionId: 'legacy01-full-session-id',
      seq: { first: 3, last: 7 },
      time: { start: BASE_TIME + 3000, end: BASE_TIME + 7000 },
      provider: 'deepseek',
      model: 'deepseek-flash',
      promptVersion: 'companion-v0',
      summarizedAt: BASE_TIME + 9000,
      importance: 8,
      keywords: ['旧事'],
    }
    await writeFile(join(dir, 'summary.md'), renderTierFile({ ...front, tier: 'summary', tokens: 25 }, '以前的摘要'))
    await writeFile(join(dir, 'gist.md'), renderTierFile({ ...front, tier: 'gist', tokens: 6 }, '以前的总结'))
    const bare = join(scopeDir, 'episodes', '2026', '11', '20261102-0900_bare_6')
    await mkdir(bare, { recursive: true })
    await writeFile(join(bare, 'raw.jsonl'), `${JSON.stringify(rawRecord(1))}\n`)
    await writeFile(join(bare, 'meta.json'), '{"id": "trunc')

    const store = makeStore(root, clock)
    const [legacy, plain] = (await store.readIndex(OWNER_SCOPE)).episodes
    expect(legacy).toMatchObject({
      id,
      sessionId: 'legacy01-full-session-id',
      dir: `episodes/2026/11/${id}`,
      seqRange: { first: 3, last: 7 },
      startedAt: BASE_TIME + 3000,
      endedAt: BASE_TIME + 7000,
      status: 'summarized',
      importance: 8,
      keywords: ['旧事'],
      summarizer: { provider: 'deepseek', model: 'deepseek-flash', promptVersion: 'companion-v0', summarizedAt: BASE_TIME + 9000 },
      pinned: false,
      strength: 1,
    })
    expect(legacy?.tokens.summary).toBe(25)
    expect(legacy?.tokens.gist).toBe(6)
    expect(legacy?.tokens.raw).toBeGreaterThan(0)
    expect(plain).toMatchObject({ id: '20261102-0900_bare_6', sessionId: 'bare', status: 'sealed', seqRange: { first: 1, last: 1 } })
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))).toEqual(legacy)
    expect(JSON.parse(await readFile(join(bare, 'meta.json'), 'utf8'))).toEqual(plain)
    expect(await readFile(join(bare, `meta.json.corrupt-${clock.now()}`), 'utf8')).toBe('{"id": "trunc')
    expect(await readdir(dir)).not.toContain(expect.stringMatching(/corrupt/))
    expect((await store.readRaw(OWNER_SCOPE, id, { offset: 0, limit: 10 })).total).toBe(5)
    const next = await store.openEpisode(OWNER_SCOPE, { sessionId: 'new', startedAt: BASE_TIME, firstSeq: 1 })
    expect(next.id.endsWith('_7')).toBe(true)
  })

  it.each(['rebuilt', 'reconciled'])('ends an episode %s without meta.json where the next one of its session starts, under its real session id', async mode => {
    const { root, clock, store, scopeDir, indexPath } = await setup()
    const sessionId = 'session-1a2b3c4d-full-id'
    const first = await store.openEpisode(OWNER_SCOPE, { sessionId, startedAt: BASE_TIME, firstSeq: 1 })
    await store.appendRaw(OWNER_SCOPE, first.id, records(1, 7))
    await store.sealEpisode(OWNER_SCOPE, first.id, { reason: 'size', endedAt: BASE_TIME + 5000, lastSeq: 5, rawTokens: 50 })
    const second = await store.openEpisode(OWNER_SCOPE, { sessionId, startedAt: BASE_TIME + 6000, firstSeq: 6 })
    await store.appendRaw(OWNER_SCOPE, second.id, records(6, 7))
    await rm(join(scopeDir, first.dir, 'meta.json'))
    if (mode === 'rebuilt') {
      await rm(indexPath)
    } else {
      const index = JSON.parse(await readFile(indexPath, 'utf8')) as { episodes: { id: string }[] }
      await writeFile(indexPath, JSON.stringify({ ...index, episodes: index.episodes.filter(meta => meta.id !== first.id) }))
    }

    const fresh = makeStore(root, clock)
    const recovered = (await fresh.readIndex(OWNER_SCOPE)).episodes.find(meta => meta.id === first.id)
    expect(recovered).toMatchObject({ sessionId, status: 'sealed', seqRange: { first: 1, last: 5 }, endedAt: rawRecord(5).time })
    expect((await fresh.readRaw(OWNER_SCOPE, first.id, { offset: 0, limit: 100 })).records.map(record => record.seq)).toEqual([1, 2, 3, 4, 5])
    expect(JSON.parse(await readFile(join(scopeDir, first.dir, 'meta.json'), 'utf8'))).toMatchObject({ sessionId, seqRange: { first: 1, last: 5 } })
  })

  it('takes the session id of an episode without meta.json from the capture watermarks', async () => {
    const { root, clock, store, scopeDir, indexPath } = await setup()
    const sessionId = 'session-5e6f7a8b-full-id'
    const only = await store.openEpisode(OWNER_SCOPE, { sessionId, startedAt: BASE_TIME, firstSeq: 1 })
    await store.appendRaw(OWNER_SCOPE, only.id, records(1, 3))
    await store.updateState(state => ({ ...state, lastSeq: { [sessionId]: 3, 'session-5e6f7a8c-other': 9 } }))
    await rm(join(scopeDir, only.dir, 'meta.json'))
    await rm(indexPath)
    const [recovered] = (await makeStore(root, clock).readIndex(OWNER_SCOPE)).episodes
    expect(recovered).toMatchObject({ id: only.id, sessionId, seqRange: { first: 1, last: 3 } })
  })

  it('rebuildIndex keeps the previous file', async () => {
    const { clock, store, scopeDir } = await setup()
    await populate(store)
    const previous = await readFile(join(scopeDir, 'index.json'), 'utf8')
    clock.advance(10)
    const rebuilt = await store.rebuildIndex(OWNER_SCOPE)
    expect(rebuilt.episodes).toHaveLength(3)
    expect(await readFile(join(scopeDir, `index.json.prev-${clock.now()}`), 'utf8')).toBe(previous)
  })
})

describe('state recovery', () => {
  it('keeps a corrupt state.json and rebuilds watermarks and the summary queue', async () => {
    const { root, clock, store } = await setup()
    const { sealed } = await populate(store)
    await writeFile(join(root, 'state.json'), '{"version":1,"lastSeq":')
    const warnings: string[] = []
    const fresh = makeStore(root, clock, { onWarning: message => warnings.push(message) })
    const expected = {
      version: 1,
      lastSeq: { 'session-a': 9, 'session-b': 3 },
      queue: [{ kind: 'summarize', scope: OWNER_SCOPE, episode: sealed.id, notBefore: clock.now(), attempts: 2 }],
    }
    expect(await fresh.readState()).toEqual(expected)
    expect(await fresh.updateState(state => state)).toEqual(expected)
    expect(await readFile(join(root, `state.json.corrupt-${clock.now()}`), 'utf8')).toBe('{"version":1,"lastSeq":')
    expect(warnings).toEqual([expect.stringMatching(/state\.json was corrupt/)])
  })
})
