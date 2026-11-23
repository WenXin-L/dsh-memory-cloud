import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EpisodeId, RollupEntry, ScopeId } from '../../src/contracts.ts'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import { appendLog } from '../../src/store/index.ts'
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

const newRoot = useTempRoots()
const GROUP = 'qq-group-42' as ScopeId

async function openSealed(root: string, last = 8) {
  const clock = fakeClock()
  const store = makeStore(root, clock)
  const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 'ab12cd34-ef56', startedAt: BASE_TIME, firstSeq: 1 })
  await store.appendRaw(OWNER_SCOPE, meta.id, records(1, last))
  const sealed = await store.sealEpisode(OWNER_SCOPE, meta.id, { reason: 'compaction', endedAt: BASE_TIME + 60_000, lastSeq: last, rawTokens: 400 })
  return { clock, store, meta: sealed }
}

describe('episodes', () => {
  it('names episodes YYYYMMDD-HHmm_<sid8>_<n> with n unique per scope', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    const first = await store.openEpisode(OWNER_SCOPE, { sessionId: 'ab12cd34-ef56-7890', startedAt: BASE_TIME, firstSeq: 1 })
    const second = await store.openEpisode(OWNER_SCOPE, { sessionId: 'ses_x/y:z0000', startedAt: Date.UTC(2026, 11, 31, 23, 59), firstSeq: 1 })
    const group = await store.openEpisode(GROUP, { sessionId: '', startedAt: BASE_TIME, firstSeq: 5 })

    expect(first.id).toBe('20261120-2130_ab12cd34_1')
    expect(first.dir).toBe('episodes/2026/11/20261120-2130_ab12cd34_1')
    expect(second.id).toBe('20261231-2359_ses-x-y-_2')
    expect(group.id).toBe('20261120-2130_anon_1')
    expect(first).toEqual({
      id: first.id,
      scope: OWNER_SCOPE,
      sessionId: 'ab12cd34-ef56-7890',
      dir: first.dir,
      seqRange: { first: 1, last: 1 },
      startedAt: BASE_TIME,
      status: 'open',
      tokens: { raw: 0 },
      importance: 5,
      strength: 1,
      pinned: false,
      hidden: false,
      keywords: [],
      owner: { pid: process.pid, startedAt: Math.round(performance.timeOrigin) },
    })
    const sidecar = JSON.parse(await readFile(join(root, 'scopes', 'owner', first.dir, 'meta.json'), 'utf8'))
    expect(sidecar).toEqual(first)
    expect((await store.readIndex(OWNER_SCOPE)).episodes.map(meta => meta.id)).toEqual([first.id, second.id])
    expect(await store.listScopes()).toEqual(['owner', 'qq-group-42'])
  })

  it('tags DSH session ids by the part after their shared session- prefix', async () => {
    const store = makeStore(await newRoot(), fakeClock())
    const dsh = await store.openEpisode(OWNER_SCOPE, { sessionId: 'session-8e06af83-e034-450c-a199-89bdeea39576', startedAt: BASE_TIME, firstSeq: 0 })
    const bare = await store.openEpisode(OWNER_SCOPE, { sessionId: 'session-', startedAt: BASE_TIME, firstSeq: 0 })
    expect(dsh.id).toBe('20261120-2130_8e06af83_1')
    expect(bare.id).toBe('20261120-2130_session-_2')
  })

  it('formats ids and month directories in the configured time zone', async () => {
    const store = makeStore(await newRoot(), fakeClock(), { timeZone: 'Asia/Hong_Kong' })
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 'abcdefgh', startedAt: Date.UTC(2026, 10, 30, 20, 5), firstSeq: 0 })
    expect(meta.id).toBe('20261201-0405_abcdefgh_1')
    expect(meta.dir).toBe('episodes/2026/12/20261201-0405_abcdefgh_1')
  })

  it('returns an empty index for an unknown scope without creating it', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    const index = await store.readIndex(GROUP)
    expect(index).toMatchObject({ version: 1, scope: GROUP, episodes: [], rollups: [] })
    expect(await store.listScopes()).toEqual([])
  })

  it('rejects unsafe scope ids and unknown or malformed episode ids', async () => {
    const store = makeStore(await newRoot(), fakeClock())
    await expect(store.readIndex('../escape' as ScopeId)).rejects.toThrow(/invalid scope id/)
    await expect(store.openEpisode('a/b' as ScopeId, { sessionId: 's', startedAt: BASE_TIME, firstSeq: 1 })).rejects.toThrow(/invalid scope id/)
    await expect(store.withLock('' as ScopeId, async () => 1)).rejects.toThrow(/invalid scope id/)
    await expect(store.readRaw(OWNER_SCOPE, '../../x' as EpisodeId, { offset: 0, limit: 1 })).rejects.toThrow(/invalid episode id/)
    await expect(store.appendRaw(OWNER_SCOPE, '20261120-2130_ab_99' as EpisodeId, [rawRecord(1)])).rejects.toThrow(/unknown episode/)
    await expect(store.openEpisode(OWNER_SCOPE, { sessionId: 's', startedAt: Number.NaN, firstSeq: 1 })).rejects.toThrow(RangeError)
  })

  it('seals once and accepts an identical retry', async () => {
    const { store, meta } = await openSealed(await newRoot())
    expect(meta).toMatchObject({ status: 'sealed', sealReason: 'compaction', seqRange: { first: 1, last: 8 }, endedAt: BASE_TIME + 60_000, tokens: { raw: 400 } })
    const retry = await store.sealEpisode(OWNER_SCOPE, meta.id, { reason: 'compaction', endedAt: BASE_TIME + 99_000, lastSeq: 8, rawTokens: 1 })
    expect(retry).toEqual(meta)
    await expect(store.sealEpisode(OWNER_SCOPE, meta.id, { reason: 'idle', endedAt: BASE_TIME, lastSeq: 9, rawTokens: 1 })).rejects.toThrow(/already sealed/)
  })

  it('records the shadowed seqs of the sealing compaction', async () => {
    const store = makeStore(await newRoot(), fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 8 })
    const sealed = await store.sealEpisode(OWNER_SCOPE, meta.id, { reason: 'compaction', endedAt: BASE_TIME, lastSeq: 18, rawTokens: 10, shadowedSeqs: [8, 9, 10, 15, 18] })
    expect(sealed.shadowedSeqs).toEqual([8, 9, 10, 15, 18])
  })

  it('patches mutable fields, clears fields set to undefined, and ignores identity fields', async () => {
    const root = await newRoot()
    const { store, meta } = await openSealed(root)
    const failed = await store.updateEpisode(OWNER_SCOPE, meta.id, { status: 'failed', lastError: 'timeout', attempts: 1 })
    expect(failed).toMatchObject({ status: 'failed', lastError: 'timeout', attempts: 1 })

    const cleared = await store.updateEpisode(OWNER_SCOPE, meta.id, { lastError: undefined, attempts: undefined })
    expect(cleared).not.toHaveProperty('lastError')
    expect(cleared).not.toHaveProperty('attempts')

    const patch = { pinned: true, strength: 2, lastRecalledAt: BASE_TIME, sessionId: 'hijack', dir: '../../etc' }
    const updated = await store.updateEpisode(OWNER_SCOPE, meta.id, patch as never)
    expect(updated).not.toHaveProperty('lastError')
    expect(updated).toMatchObject({ pinned: true, strength: 2, lastRecalledAt: BASE_TIME, sessionId: meta.sessionId, dir: meta.dir })
    const sidecar = JSON.parse(await readFile(join(root, 'scopes', 'owner', meta.dir, 'meta.json'), 'utf8'))
    expect(sidecar).toEqual(updated)
  })

  it('rejects patches that would make the entry invalid and leaves the index untouched', async () => {
    const { store, meta } = await openSealed(await newRoot())
    const before = await store.readIndex(OWNER_SCOPE)
    await expect(store.updateEpisode(OWNER_SCOPE, meta.id, { status: 'bogus' } as never)).rejects.toThrow(/invalid/)
    await expect(store.updateEpisode(OWNER_SCOPE, meta.id, { importance: undefined } as never)).rejects.toThrow(/invalid/)
    expect(await store.readIndex(OWNER_SCOPE)).toEqual(before)
  })
})

describe('raw archive', () => {
  it('pages by record offset and limit and reports the true total', async () => {
    const store = makeStore(await newRoot(), fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await store.appendRaw(OWNER_SCOPE, meta.id, records(1, 10))
    await store.appendRaw(OWNER_SCOPE, meta.id, [])
    await store.appendRaw(OWNER_SCOPE, meta.id, records(11, 25))

    const pages = await Promise.all([0, 10, 20].map(offset => store.readRaw(OWNER_SCOPE, meta.id, { offset, limit: 10 })))
    expect(pages.map(page => page.total)).toEqual([25, 25, 25])
    expect(pages.map(page => page.offset)).toEqual([0, 10, 20])
    expect(pages.flatMap(page => page.records.map(record => record.seq))).toEqual(records(1, 25).map(record => record.seq))
    expect(pages[0]?.records[0]).toEqual(rawRecord(1))
  })

  it('stores the event envelope losslessly', async () => {
    const store = makeStore(await newRoot(), fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 3 })
    const event = {
      seq: 3,
      time: BASE_TIME,
      type: 'user/message',
      data: { content: [{ type: 'text', text: '你好 <b>"quoted"</b>\n' }] },
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      sourceEventSeqs: [1, 2],
      ignorable: true as const,
    }
    await store.appendRaw(OWNER_SCOPE, meta.id, [event])
    expect((await store.readRaw(OWNER_SCOPE, meta.id, { offset: 0, limit: 5 })).records).toEqual([event])
  })

  it('hides records beyond lastSeq once sealed without removing them from the file', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await store.appendRaw(OWNER_SCOPE, meta.id, records(1, 12))
    expect((await store.readRaw(OWNER_SCOPE, meta.id, { offset: 0, limit: 100 })).total).toBe(12)

    await store.sealEpisode(OWNER_SCOPE, meta.id, { reason: 'compaction', endedAt: BASE_TIME, lastSeq: 8, rawTokens: 100 })
    const page = await store.readRaw(OWNER_SCOPE, meta.id, { offset: 5, limit: 100 })
    expect(page.total).toBe(8)
    expect(page.records.map(record => record.seq)).toEqual([6, 7, 8])
    const lines = (await readFile(join(root, 'scopes', 'owner', meta.dir, 'raw.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(12)
  })

  it('survives a torn trailing line and ignores a re-appended seq', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await store.appendRaw(OWNER_SCOPE, meta.id, records(1, 3))
    const file = join(root, 'scopes', 'owner', meta.dir, 'raw.jsonl')
    await appendFile(file, '{"seq":4,"ti')
    await store.appendRaw(OWNER_SCOPE, meta.id, records(4, 5))
    await store.appendRaw(OWNER_SCOPE, meta.id, [rawRecord(5, 'retry')])

    const page = await store.readRaw(OWNER_SCOPE, meta.id, { offset: 0, limit: 10 })
    expect(page.records).toEqual(records(1, 5))
    expect(page.total).toBe(5)
    expect(await readFile(file, 'utf8')).toContain('{"seq":4,"ti\n{"seq":4,')
  })

  it('clamps page arguments', async () => {
    const { store, meta } = await openSealed(await newRoot())
    expect(await store.readRaw(OWNER_SCOPE, meta.id, { offset: -3, limit: 2 })).toMatchObject({ offset: 0, total: 8 })
    expect((await store.readRaw(OWNER_SCOPE, meta.id, { offset: 0, limit: Number.NaN })).records).toEqual([])
    expect(await store.readRaw(OWNER_SCOPE, meta.id, { offset: 50, limit: 5 })).toEqual({ records: [], offset: 50, total: 8 })
    expect((await store.readRaw(OWNER_SCOPE, meta.id, { offset: 6, limit: Number.POSITIVE_INFINITY })).records).toHaveLength(2)
  })

  it('rejects malformed records before writing any of them', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await expect(store.appendRaw(OWNER_SCOPE, meta.id, [rawRecord(1), { seq: 'x' } as never])).rejects.toThrow(/raw record 1/)
    expect((await store.readRaw(OWNER_SCOPE, meta.id, { offset: 0, limit: 10 })).total).toBe(0)
  })
})

describe('summaries', () => {
  it('writes summary.md and gist.md with frontmatter and marks the episode summarized', async () => {
    const root = await newRoot()
    const { store, meta } = await openSealed(root)
    await store.updateEpisode(OWNER_SCOPE, meta.id, { status: 'failed', lastError: 'timeout', attempts: 2 })
    expect(await store.readTier(OWNER_SCOPE, meta.id, 'summary')).toBeUndefined()

    const result = summaryResult()
    const updated = await store.writeSummary(OWNER_SCOPE, meta.id, result, provenance(), { summary: 60, gist: 12 })
    expect(updated).toMatchObject({
      status: 'summarized',
      tokens: { raw: 400, summary: 60, gist: 12 },
      importance: 7,
      keywords: ['咖啡', '周末'],
      summarizer: provenance(),
    })
    expect(updated).not.toHaveProperty('lastError')
    expect(updated).not.toHaveProperty('attempts')
    expect(await store.readTier(OWNER_SCOPE, meta.id, 'summary')).toBe(result.summary)
    expect(await store.readTier(OWNER_SCOPE, meta.id, 'gist')).toBe(result.gist)

    const summary = await store.readTierDocument(OWNER_SCOPE, meta.id, 'summary')
    expect(summary?.frontmatter).toEqual({
      id: meta.id,
      scope: OWNER_SCOPE,
      sessionId: meta.sessionId,
      tier: 'summary',
      seq: { first: 1, last: 8 },
      time: { start: BASE_TIME, end: BASE_TIME + 60_000 },
      provider: 'deepseek',
      model: 'deepseek-flash',
      promptVersion: 'companion-v1',
      summarizedAt: provenance().summarizedAt,
      tokens: 60,
      importance: 7,
      keywords: result.keywords,
      people: result.people,
      dates: result.dates,
      promises: result.promises,
      ongoing: result.ongoing,
    })
    const gist = await store.readTierDocument(OWNER_SCOPE, meta.id, 'gist')
    expect(gist?.frontmatter).toMatchObject({ tier: 'gist', tokens: 12, seq: { first: 1, last: 8 } })
    expect(gist?.frontmatter).not.toHaveProperty('people')
    const file = await readFile(join(root, 'scopes', 'owner', meta.dir, 'summary.md'), 'utf8')
    expect(file.startsWith(`---\nid: ${meta.id}\nscope: owner\n`)).toBe(true)
  })

  it('refuses to summarize an open episode', async () => {
    const store = makeStore(await newRoot(), fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await expect(store.writeSummary(OWNER_SCOPE, meta.id, summaryResult(), provenance(), { summary: 1, gist: 1 })).rejects.toThrow(/still open/)
    expect(await store.readTier(OWNER_SCOPE, meta.id, 'gist')).toBeUndefined()
  })
})

describe('rollups, snapshots, and the profile', () => {
  const rollup: RollupEntry = {
    id: '2026-W47',
    scope: OWNER_SCOPE,
    period: { kind: 'week', key: '2026-W47' },
    episodeIds: ['20261120-2130_ab12cd34_1' as EpisodeId],
    from: Date.UTC(2026, 10, 16),
    to: Date.UTC(2026, 10, 23),
    tokens: 30,
    file: 'rollups/2026-W47.md',
    createdAt: Date.UTC(2026, 10, 23),
  }

  it('writes rollups through the index and reads their body back', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    await store.writeRollup(OWNER_SCOPE, rollup, '这周聊了咖啡。')
    await store.writeRollup(OWNER_SCOPE, { ...rollup, tokens: 31 }, '这周聊了咖啡和爬山。')
    expect((await store.readIndex(OWNER_SCOPE)).rollups).toEqual([{ ...rollup, tokens: 31 }])
    expect(await store.readRollup(OWNER_SCOPE, rollup.id)).toBe('这周聊了咖啡和爬山。')
    expect(await store.readRollup(OWNER_SCOPE, 'missing')).toBeUndefined()
    expect(await readFile(join(root, 'scopes', 'owner', 'rollups', '2026-W47.md'), 'utf8')).toMatch(/^---\nid: 2026-W47\n/)
  })

  it('rejects rollups for another scope, unsafe files, and file clashes', async () => {
    const store = makeStore(await newRoot(), fakeClock())
    await expect(store.writeRollup(GROUP, rollup, 'x')).rejects.toThrow(/belongs to scope owner/)
    await expect(store.writeRollup(OWNER_SCOPE, { ...rollup, file: 'rollups/../index.json' }, 'x')).rejects.toThrow(/invalid rollup/)
    await store.writeRollup(OWNER_SCOPE, rollup, 'x')
    await expect(store.writeRollup(OWNER_SCOPE, { ...rollup, id: 'other' }, 'y')).rejects.toThrow(/already holds rollup/)
  })

  it('never overwrites a snapshot', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    const first = await store.writeSnapshot(OWNER_SCOPE, { sessionId: 'ses/1:a', n: 1 }, '<memory-cloud>A</memory-cloud>')
    const again = await store.writeSnapshot(OWNER_SCOPE, { sessionId: 'ses/1:a', n: 1 }, '<memory-cloud>A</memory-cloud>')
    const changed = await store.writeSnapshot(OWNER_SCOPE, { sessionId: 'ses/1:a', n: 1 }, '<memory-cloud>B</memory-cloud>')
    expect([first, again, changed]).toEqual(['snapshots/ses_1_a-1.md', 'snapshots/ses_1_a-1.md', 'snapshots/ses_1_a-1.1.md'])
    expect(await readFile(join(root, 'scopes', 'owner', first), 'utf8')).toBe('<memory-cloud>A</memory-cloud>')
    expect(await readFile(join(root, 'scopes', 'owner', changed), 'utf8')).toBe('<memory-cloud>B</memory-cloud>')
    await expect(store.writeSnapshot(OWNER_SCOPE, { sessionId: 's', n: -1 }, 'x')).rejects.toThrow(RangeError)
  })

  it('reads the user-editable profile when present', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    expect(await store.readProfile(OWNER_SCOPE)).toBeUndefined()
    await mkdir(join(root, 'scopes', 'owner'), { recursive: true })
    await writeFile(join(root, 'scopes', 'owner', 'profile.md'), '称呼：小明\n')
    expect(await store.readProfile(OWNER_SCOPE)).toBe('称呼：小明\n')
  })
})

describe('state', () => {
  it('starts empty and persists updates', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    expect(await store.readState()).toEqual({ version: 1, lastSeq: {}, queue: [] })
    const job = { kind: 'summarize', scope: OWNER_SCOPE, episode: '20261120-2130_ab12cd34_1' as EpisodeId, notBefore: 5, attempts: 0 } as const
    const next = await store.updateState(state => ({ ...state, lastSeq: { s1: 12 }, queue: [job] }))
    expect(next).toEqual({ version: 1, lastSeq: { s1: 12 }, queue: [job] })
    expect(await makeStore(root, fakeClock()).readState()).toEqual(next)
  })

  it('derives watermarks from the indexes when state.json is missing', async () => {
    const root = await newRoot()
    const { store } = await openSealed(root, 9)
    const open = await store.openEpisode(GROUP, { sessionId: 'group-session', startedAt: BASE_TIME, firstSeq: 20 })
    await store.appendRaw(GROUP, open.id, records(20, 24))
    expect(await store.readState()).toEqual({ version: 1, lastSeq: { 'ab12cd34-ef56': 9, 'group-session': 24 }, queue: [] })
  })

  it('rejects an invalid next state without writing it', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    await store.updateState(state => ({ ...state, lastSeq: { s1: 1 } }))
    await expect(store.updateState(state => ({ ...state, lastSeq: { s1: 'x' } }) as never)).rejects.toThrow(/invalid state/)
    await expect(store.updateState(() => {
      throw new Error('change failed')
    })).rejects.toThrow('change failed')
    expect((await store.readState()).lastSeq).toEqual({ s1: 1 })
  })
})

describe('appendLog', () => {
  it('appends JSON lines under logs/ and serializes concurrent writers', async () => {
    const root = await newRoot()
    await Promise.all(Array.from({ length: 20 }, (_, n) => appendLog(root, 'summarizer', { n, text: '总结\n完成' })))
    await appendLog(root, 'summarizer.jsonl', { n: 20 })
    const lines = (await readFile(join(root, 'logs', 'summarizer.jsonl'), 'utf8')).trim().split('\n')
    expect(lines.map(line => JSON.parse(line).n).sort((left, right) => left - right)).toEqual(Array.from({ length: 21 }, (_, n) => n))
  })

  it('rejects unsafe names and unserializable records', async () => {
    const root = await newRoot()
    await expect(appendLog(root, '../escape', {})).rejects.toThrow(/invalid log name/)
    await expect(appendLog(root, 'x', undefined)).rejects.toThrow(/not JSON-serializable/)
    expect(await listTree(root)).toEqual([])
  })
})
