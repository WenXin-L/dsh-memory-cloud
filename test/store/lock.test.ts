import { execFile, spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import { clearPartialLock, STALE_PARTIAL_LOCK_MS } from '../../src/store/lock.ts'
import { BASE_TIME, fakeClock, listTree, makeStore, records, useTempRoots } from './helpers.ts'

const run = promisify(execFile)
const newRoot = useTempRoots()

function episodeNumbers(ids: readonly string[]): number[] {
  return ids.map(id => Number(id.split('_').at(-1))).sort((left, right) => left - right)
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, offset) => offset + 1)
}

function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  if (child.pid === undefined) throw new Error('could not spawn a child process')
  return child.pid
}

describe('locking', () => {
  it('serializes concurrent writers in one process, across store instances', async () => {
    const root = await newRoot()
    const clock = fakeClock()
    const stores = [makeStore(root, clock), makeStore(root, clock)]
    const opened = await Promise.all(range(40).map(n =>
      stores[n % 2]!.openEpisode(OWNER_SCOPE, { sessionId: `session-${n}`, startedAt: BASE_TIME, firstSeq: n })))
    expect(episodeNumbers(opened.map(meta => meta.id))).toEqual(range(40))
    expect((await stores[0]!.readIndex(OWNER_SCOPE)).episodes).toHaveLength(40)

    await Promise.all(range(50).map(n => stores[n % 2]!.updateState(state => ({
      ...state,
      lastSeq: { ...state.lastSeq, counter: (state.lastSeq.counter ?? 0) + 1 },
    }))))
    expect((await stores[1]!.readState()).lastSeq.counter).toBe(50)
    expect((await listTree(root)).filter(file => file.endsWith('.lock'))).toEqual([])
  })

  it('keeps read-modify-write cycles inside withLock atomic and reentrant', async () => {
    const store = makeStore(await newRoot(), fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await Promise.all(range(30).map(() => store.withLock(OWNER_SCOPE, async () => {
      const current = (await store.readIndex(OWNER_SCOPE)).episodes[0]!
      await new Promise(resolve => setTimeout(resolve, 1))
      await store.updateEpisode(OWNER_SCOPE, meta.id, { strength: current.strength + 1 })
    })))
    expect((await store.readIndex(OWNER_SCOPE)).episodes[0]?.strength).toBe(31)
  })

  it('serializes nested calls made in parallel under one hold', async () => {
    const store = makeStore(await newRoot(), fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    const result = await store.withLock(OWNER_SCOPE, async () => {
      const [pinned, other] = await Promise.all([
        store.updateEpisode(OWNER_SCOPE, meta.id, { pinned: true }),
        store.openEpisode(OWNER_SCOPE, { sessionId: 's2', startedAt: BASE_TIME, firstSeq: 1 }),
        store.withLock(OWNER_SCOPE, () => store.updateEpisode(OWNER_SCOPE, meta.id, { keywords: ['nested'] })),
      ])
      return { pinned, other }
    })
    expect(result.other.id.endsWith('_2')).toBe(true)
    expect((await store.readIndex(OWNER_SCOPE)).episodes[0]).toMatchObject({ pinned: true, keywords: ['nested'] })
  })

  it('takes the lock again for work that outlives the hold', async () => {
    const store = makeStore(await newRoot(), fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    let late: Promise<unknown> = Promise.resolve()
    await store.withLock(OWNER_SCOPE, async () => {
      late = new Promise(resolve => setTimeout(resolve, 20)).then(() => store.updateEpisode(OWNER_SCOPE, meta.id, { hidden: true }))
    })
    await late
    expect((await store.readIndex(OWNER_SCOPE)).episodes[0]?.hidden).toBe(true)
  })

  it('fails a writer when a live foreign process holds the lock past the wait limit', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock(), { lockWaitMs: 150 })
    const lock = join(root, 'scopes', 'owner', 'index.json.lock')
    await mkdir(join(root, 'scopes', 'owner'), { recursive: true })
    await writeFile(lock, `${process.ppid}\n`)
    await expect(store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })).rejects.toThrow(/timed out/)
    await rm(lock)
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    expect(meta.id.endsWith('_1')).toBe(true)
  })

  it('recovers from an empty lock left by a writer killed mid-acquisition, but not a fresh one', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock(), { lockWaitMs: 150 })
    const lock = join(root, 'state.json.lock')
    await mkdir(root, { recursive: true })
    await writeFile(lock, '')
    await expect(store.updateState(state => ({ ...state, lastSeq: { fresh: 1 } }))).rejects.toThrow(/timed out/)

    const past = new Date(Date.now() - STALE_PARTIAL_LOCK_MS - 1000)
    await utimes(lock, past, past)
    await store.updateState(state => ({ ...state, lastSeq: { recovered: 1 } }))
    expect((await store.readState()).lastSeq).toEqual({ recovered: 1 })
    expect((await listTree(root)).filter(file => file.endsWith('.lock'))).toEqual([])

    await writeFile(lock, `${process.ppid}\n`)
    await utimes(lock, past, past)
    expect(await clearPartialLock(lock)).toBe(false)
    await rm(lock)
  })

  it('removes a complete-PID lock written before the last boot, since its PID may have been reused', async () => {
    const root = await newRoot()
    const lock = join(root, 'index.json.lock')
    await mkdir(root, { recursive: true })
    await writeFile(lock, `${process.ppid}\n`)
    const written = new Date(Date.now() - STALE_PARTIAL_LOCK_MS - 60_000)
    await utimes(lock, written, written)
    expect(await clearPartialLock(lock, Date.now(), written.getTime() - 1000)).toBe(false)
    expect(await clearPartialLock(lock, Date.now(), written.getTime() + 1000)).toBe(true)
    expect((await listTree(root)).filter(file => file.includes('.lock'))).toEqual([])
  })

  it('leaves a pre-boot lock of an exited PID to the host takeover, which still acquires it', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock(), { lockWaitMs: 2000 })
    const lock = join(root, 'state.json.lock')
    await mkdir(root, { recursive: true })
    await writeFile(lock, `${exitedPid()}\n`)
    const written = new Date(Date.now() - STALE_PARTIAL_LOCK_MS - 60_000)
    await utimes(lock, written, written)
    expect(await clearPartialLock(lock, Date.now(), written.getTime() + 1000)).toBe(false)
    expect(await readFile(lock, 'utf8')).toMatch(/^\d+\n$/)

    await store.updateState(state => ({ ...state, lastSeq: { taken: 1 } }))
    expect((await store.readState()).lastSeq).toEqual({ taken: 1 })
    expect((await listTree(root)).filter(file => file.includes('.lock'))).toEqual([])
  })

  it('removes a lock naming this process that predates it, since the host never takes over its own PID', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock(), { lockWaitMs: 150 })
    const lock = join(root, 'state.json.lock')
    await mkdir(root, { recursive: true })
    await writeFile(lock, `${process.pid}\n`)
    const boot = performance.timeOrigin - 3_600_000
    expect(await clearPartialLock(lock, Date.now() + STALE_PARTIAL_LOCK_MS + 1000, boot)).toBe(false)
    expect(await readFile(lock, 'utf8')).toBe(`${process.pid}\n`)

    const before = new Date(performance.timeOrigin - 60_000)
    await utimes(lock, before, before)
    expect(await clearPartialLock(lock, Date.now(), boot)).toBe(true)

    await writeFile(lock, `${process.pid}\n`)
    await utimes(lock, before, before)
    await store.updateState(state => ({ ...state, lastSeq: { recovered: 1 } }))
    expect((await store.readState()).lastSeq).toEqual({ recovered: 1 })
    expect((await listTree(root)).filter(file => file.includes('.lock'))).toEqual([])
  })

  it('leaves a stale lock alone while another clearer holds the claim, and expires an abandoned claim', async () => {
    const root = await newRoot()
    const lock = join(root, 'index.json.lock')
    const claim = `${lock}.clear`
    await mkdir(root, { recursive: true })
    await writeFile(lock, '')
    const past = new Date(Date.now() - STALE_PARTIAL_LOCK_MS - 1000)
    await utimes(lock, past, past)
    await writeFile(claim, '1\n')
    expect(await clearPartialLock(lock)).toBe(false)
    expect(await readFile(lock, 'utf8')).toBe('')

    await utimes(claim, past, past)
    expect(await clearPartialLock(lock)).toBe(false)
    expect(await clearPartialLock(lock)).toBe(true)
    expect((await listTree(root)).filter(file => file.includes('.lock'))).toEqual([])
  })

  it('serializes writers in separate processes', async () => {
    const root = await newRoot()
    const workers = 4
    const iterations = 8
    const script = join(root, 'worker.mjs')
    await writeFile(script, [
      'const [storeUrl, root, label, iterations] = process.argv.slice(2)',
      'const { createFileMemoryStore } = await import(storeUrl)',
      'const store = createFileMemoryStore({ root, clock: { now: () => Date.now() }, timeZone: "UTC", lockWaitMs: 30000 })',
      'for (let i = 0; i < Number(iterations); i += 1) {',
      '  await store.updateState(state => ({ ...state, lastSeq: { ...state.lastSeq, counter: (state.lastSeq.counter ?? 0) + 1 } }))',
      '  const meta = await store.openEpisode("owner", { sessionId: label, startedAt: Date.now(), firstSeq: i })',
      '  await store.appendRaw("owner", meta.id, [{ seq: i, time: Date.now(), type: "probe", data: label }])',
      '}',
    ].join('\n'))
    const storeUrl = new URL('../../src/store/index.ts', import.meta.url).href
    const outcomes = await Promise.allSettled(range(workers).map(n =>
      run(process.execPath, [script, storeUrl, root, `worker-${n}`, String(iterations)], { timeout: 50_000 })))
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toEqual([])

    const store = makeStore(root, fakeClock())
    const index = await store.readIndex(OWNER_SCOPE)
    expect(episodeNumbers(index.episodes.map(meta => meta.id))).toEqual(range(workers * iterations))
    expect((await store.readState()).lastSeq.counter).toBe(workers * iterations)
    for (const meta of index.episodes) {
      expect((await store.readRaw(OWNER_SCOPE, meta.id, { offset: 0, limit: 10 })).total).toBe(1)
    }
    const raw = await readFile(join(root, 'scopes', 'owner', index.episodes[0]!.dir, 'raw.jsonl'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1)
    expect((await listTree(root)).filter(file => file.endsWith('.lock') || file.endsWith('.tmp'))).toEqual([])
  }, 60_000)

  it('appends raw batches from concurrent callers without interleaving lines', async () => {
    const root = await newRoot()
    const store = makeStore(root, fakeClock())
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await Promise.all(range(20).map(n => store.appendRaw(OWNER_SCOPE, meta.id, records(n * 10, n * 10 + 9))))
    const page = await store.readRaw(OWNER_SCOPE, meta.id, { offset: 0, limit: 1000 })
    expect(page.total).toBe(200)
  })
})
