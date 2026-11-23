import { spawnSync } from 'node:child_process'
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RollupEntry } from '../../src/contracts.ts'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import { currentOwner, episodeOwner, isEpisodeNotOpenError, ownerState } from '../../src/store/index.ts'
import { BASE_TIME, fakeClock, listTree, makeStore, provenance, rawRecord, records, summaryResult, useTempRoots } from './helpers.ts'

const newRoot = useTempRoots()

function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  if (child.pid === undefined) throw new Error('could not spawn a child process')
  return child.pid
}

describe('episode ownership', () => {
  it('records the opening process on open episodes and drops it at seal', async () => {
    const store = makeStore(await newRoot(), fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    expect(episodeOwner(meta)).toEqual(currentOwner())
    expect(ownerState(episodeOwner(meta)!)).toBe('self')
    await store.appendRaw(OWNER_SCOPE, meta.id, records(1, 2))
    const sealed = await store.sealEpisode(OWNER_SCOPE, meta.id, { reason: 'end', endedAt: BASE_TIME, lastSeq: 2, rawTokens: 1 })
    expect(episodeOwner(sealed)).toBeUndefined()
  })

  it('tells this process, live foreign processes and dead owners apart', () => {
    const self = currentOwner()
    const now = Date.now()
    const boot = now - 3_600_000
    expect(ownerState(self, self, boot)).toBe('self')
    expect(ownerState({ pid: self.pid, startedAt: self.startedAt - 60_000 }, self, boot)).toBe('dead')
    expect(ownerState({ pid: process.ppid, startedAt: now }, self, boot)).toBe('alive')
    expect(ownerState({ pid: process.ppid, startedAt: boot - 60_000 }, self, boot)).toBe('dead')
    expect(ownerState({ pid: exitedPid(), startedAt: now }, self, boot)).toBe('dead')
  })
})

describe('raw appends', () => {
  it('rejects appends to an episode that is no longer open with a typed error', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await store.appendRaw(OWNER_SCOPE, meta.id, records(1, 3))
    await store.sealEpisode(OWNER_SCOPE, meta.id, { reason: 'idle', endedAt: BASE_TIME, lastSeq: 3, rawTokens: 1 })
    const failure = await store.appendRaw(OWNER_SCOPE, meta.id, records(4, 5)).catch((error: unknown) => error)
    expect(isEpisodeNotOpenError(failure)).toBe(true)
    const lines = (await readFile(join(root, 'scopes', 'owner', meta.dir, 'raw.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
  })

  it('sees appended records, completed torn lines and replaced files across cached reads', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    const file = join(root, 'scopes', 'owner', meta.dir, 'raw.jsonl')
    const seqsOf = async () => (await store.readRaw(OWNER_SCOPE, meta.id, { offset: 0, limit: 100 })).records.map(record => record.seq)
    await store.appendRaw(OWNER_SCOPE, meta.id, records(1, 3))
    expect(await seqsOf()).toEqual([1, 2, 3])
    expect(await store.readRaw(OWNER_SCOPE, meta.id, { offset: 2, limit: 5 })).toMatchObject({ offset: 2, total: 3 })

    await store.appendRaw(OWNER_SCOPE, meta.id, records(4, 5))
    expect(await seqsOf()).toEqual([1, 2, 3, 4, 5])

    const line = JSON.stringify(rawRecord(6))
    await appendFile(file, line.slice(0, 10))
    expect(await seqsOf()).toEqual([1, 2, 3, 4, 5])
    await appendFile(file, `${line.slice(10)}\n`)
    expect(await seqsOf()).toEqual([1, 2, 3, 4, 5, 6])
    await appendFile(file, JSON.stringify(rawRecord(7)))
    expect(await seqsOf()).toEqual([1, 2, 3, 4, 5, 6, 7])
    await appendFile(file, `\n${JSON.stringify(rawRecord(3))}\n`)
    expect(await seqsOf()).toEqual([1, 2, 3, 4, 5, 6, 7])

    await rm(file)
    await writeFile(file, `${JSON.stringify(rawRecord(9))}\n`)
    expect(await seqsOf()).toEqual([9])
  })
})

describe('atomic episode updates', () => {
  it('applies function patches to the current entry, so concurrent increments are not lost', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await Promise.all(Array.from({ length: 10 }, () => store.updateEpisode(OWNER_SCOPE, meta.id, current => ({ strength: current.strength + 1 }))))
    expect((await store.readIndex(OWNER_SCOPE)).episodes[0]?.strength).toBe(11)

    const indexPath = join(root, 'scopes', 'owner', 'index.json')
    const before = await readFile(indexPath, 'utf8')
    const same = await store.updateEpisode(OWNER_SCOPE, meta.id, () => ({}))
    expect(same.strength).toBe(11)
    expect(await readFile(indexPath, 'utf8')).toBe(before)
  })
})

describe('index format and rebuild', () => {
  it('writes index.json compactly and still reads a pretty-printed one', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    const indexPath = join(root, 'scopes', 'owner', 'index.json')
    const text = await readFile(indexPath, 'utf8')
    expect(text.trimEnd().split('\n')).toHaveLength(1)

    await writeFile(indexPath, `${JSON.stringify(JSON.parse(text), null, 2)}\n`)
    const fresh = makeStore(root, fakeClock())
    expect((await fresh.readIndex(OWNER_SCOPE)).episodes).toHaveLength(1)
  })

  it('treats an open sidecar superseded by a later episode of its session as sealed where the next one starts', async () => {
    const root = await newRoot()
    const clock = fakeClock()
    const store = makeStore(root, clock)
    const first = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await store.appendRaw(OWNER_SCOPE, first.id, records(1, 7))
    const other = await store.openEpisode(OWNER_SCOPE, { sessionId: 's2', startedAt: BASE_TIME, firstSeq: 1 })
    const second = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 6 })
    await store.appendRaw(OWNER_SCOPE, second.id, records(6, 9))
    await rm(join(root, 'scopes', 'owner', 'index.json'))

    const fresh = makeStore(root, clock)
    const episodes = (await fresh.readIndex(OWNER_SCOPE)).episodes
    expect(episodes.find(meta => meta.id === first.id)).toMatchObject({
      status: 'sealed',
      sealReason: 'idle',
      seqRange: { first: 1, last: 5 },
      endedAt: rawRecord(5).time,
    })
    expect(episodes.find(meta => meta.id === first.id)).not.toHaveProperty('owner')
    expect(episodes.find(meta => meta.id === second.id)?.status).toBe('open')
    expect(episodes.find(meta => meta.id === other.id)?.status).toBe('open')
    const sidecar = JSON.parse(await readFile(join(root, 'scopes', 'owner', first.dir, 'meta.json'), 'utf8'))
    expect(sidecar).toMatchObject({ status: 'sealed', seqRange: { first: 1, last: 5 } })
    expect((await fresh.readRaw(OWNER_SCOPE, first.id, { offset: 0, limit: 100 })).records.map(record => record.seq)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('derived text is never deleted', () => {
  it('keeps the previous summary and gist when a re-summarization overwrites them', async () => {
    const root = await newRoot()
    const clock = fakeClock()
    const store = makeStore(root, clock)
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await store.appendRaw(OWNER_SCOPE, meta.id, records(1, 3))
    await store.sealEpisode(OWNER_SCOPE, meta.id, { reason: 'end', endedAt: BASE_TIME, lastSeq: 3, rawTokens: 10 })
    await store.writeSummary(OWNER_SCOPE, meta.id, summaryResult(), provenance(), { summary: 5, gist: 2 })
    await store.writeSummary(OWNER_SCOPE, meta.id, summaryResult(), provenance(), { summary: 5, gist: 2 })
    const dir = join(root, 'scopes', 'owner', meta.dir)
    const firstSummary = await readFile(join(dir, 'summary.md'), 'utf8')
    const firstGist = await readFile(join(dir, 'gist.md'), 'utf8')
    expect((await listTree(dir)).filter(name => name.includes('.prev-'))).toEqual([])

    clock.advance(1000)
    await store.writeSummary(OWNER_SCOPE, meta.id, summaryResult({ summary: '新的摘要。', gist: '新的。' }), provenance(), { summary: 5, gist: 2 })
    expect(await readFile(join(dir, `summary.md.prev-${clock.now()}`), 'utf8')).toBe(firstSummary)
    expect(await readFile(join(dir, `gist.md.prev-${clock.now()}`), 'utf8')).toBe(firstGist)
    expect(await store.readTier(OWNER_SCOPE, meta.id, 'summary')).toBe('新的摘要。')
  })

  it('keeps the previous rollup file when a rollup is rewritten', async () => {
    const root = await newRoot()
    const clock = fakeClock()
    const store = makeStore(root, clock)
    const rollup: RollupEntry = {
      id: '2026-W47',
      scope: OWNER_SCOPE,
      period: { kind: 'week', key: '2026-W47' },
      episodeIds: [],
      from: Date.UTC(2026, 10, 16),
      to: Date.UTC(2026, 10, 23),
      tokens: 30,
      file: 'rollups/2026-W47.md',
      createdAt: Date.UTC(2026, 10, 23),
    }
    await store.writeRollup(OWNER_SCOPE, rollup, '这周聊了咖啡。')
    const file = join(root, 'scopes', 'owner', 'rollups', '2026-W47.md')
    const old = await readFile(file, 'utf8')
    clock.advance(1000)
    await store.writeRollup(OWNER_SCOPE, { ...rollup, tokens: 31 }, '这周聊了咖啡和爬山。')
    expect(await readFile(`${file}.prev-${clock.now()}`, 'utf8')).toBe(old)
    expect(await store.readRollup(OWNER_SCOPE, rollup.id)).toBe('这周聊了咖啡和爬山。')
    await rm(join(root, 'scopes', 'owner', 'index.json'))
    expect((await makeStore(root, clock).readIndex(OWNER_SCOPE)).rollups).toEqual([{ ...rollup, tokens: 31 }])
  })
})
