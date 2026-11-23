import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCapture } from '../../src/capture/capture.ts'
import { OWNER_SCOPE, type EpisodeMeta, type SessionDescriptor } from '../../src/contracts.ts'
import { createFileMemoryStore, type EpisodeOwner, type FileMemoryStore } from '../../src/store/index.ts'
import { EventStream, T0, range, seqs } from './fixtures.ts'

const session: SessionDescriptor = { sessionId: 'session-ffff-2222' }

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'memory-cloud-capture-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function openStore(owner?: EpisodeOwner): FileMemoryStore {
  return createFileMemoryStore({ root, clock: { now: () => T0 }, timeZone: 'UTC', ...owner === undefined ? {} : { owner } })
}

function start(store: FileMemoryStore) {
  const sealed: EpisodeMeta[] = []
  const warnings: string[] = []
  const capture = createCapture({
    store,
    estimator: { estimate: text => text.length },
    clock: { now: () => T0 },
    resolveScope: () => ({ scope: OWNER_SCOPE, capture: true, private: true, reason: 'default' }),
    onSealed: (_scope, meta) => {
      sealed.push(meta)
    },
    options: { idleMinutes: 30, maxEpisodeTokens: 100_000, captureReasoning: true, flushDelayMs: 60_000 },
    logger: { warn: message => warnings.push(message) },
  })
  return { capture, sealed, warnings }
}

async function rawSeqs(store: FileMemoryStore, meta: EpisodeMeta): Promise<number[]> {
  const page = await store.readRaw(OWNER_SCOPE, meta.id, { offset: 0, limit: 1000 })
  return seqs(page.records)
}

describe('capture on the file store', () => {
  it('splits on compaction, survives a restart, and seals on end', async () => {
    const s = new EventStream()
    const first = start(openStore())
    const opening = [...s.fullTurn('user A', 'assistant A'), ...s.fullTurn('user B', 'assistant B'), s.turnStart(), s.user('user C')]
    for (const record of opening) first.capture.handleEvent(session, record)
    for (const record of s.compaction([1, 3], 3)) first.capture.handleEvent(session, record)
    await first.capture.dispose()

    const store = openStore()
    let episodes = (await store.readIndex(OWNER_SCOPE)).episodes
    expect(episodes.map(meta => [meta.status, meta.sealReason, meta.seqRange])).toEqual([
      ['sealed', 'compaction', { first: 0, last: 3 }],
      ['open', undefined, { first: 4, last: 4 }],
    ])
    expect(episodes[0]?.shadowedSeqs).toEqual([1, 3])
    expect(await rawSeqs(store, episodes[0]!)).toEqual(range(0, 3))
    expect(await rawSeqs(store, episodes[1]!)).toEqual(range(4, 17))
    expect((await store.readState()).lastSeq[session.sessionId]).toBe(11)

    const second = start(store)
    const resumed = [...opening.slice(-3), s.stepStart(), s.assistant('assistant C'), s.stepEnd(), s.turnEnd()]
    for (const record of resumed) second.capture.handleEvent(session, record)
    await second.capture.settle()
    await second.capture.sealSession(session.sessionId, 'end')
    await second.capture.dispose()

    episodes = (await store.readIndex(OWNER_SCOPE)).episodes
    expect(episodes).toHaveLength(2)
    expect(episodes[1]).toMatchObject({ status: 'sealed', sealReason: 'end', seqRange: { first: 4, last: 21 } })
    expect(episodes[1]?.tokens.raw).toBe('user B'.length + 'assistant B'.length + 'user C'.length + 'assistant C'.length)
    expect(await rawSeqs(store, episodes[1]!)).toEqual(range(4, 21))
    expect(first.sealed.map(meta => meta.id)).toEqual([episodes[0]?.id])
    expect(second.sealed.map(meta => meta.id)).toEqual([episodes[1]?.id])
    expect([...first.warnings, ...second.warnings]).toEqual([])
  })

  it('seals an orphaned open episode with sealStale', async () => {
    const s = new EventStream()
    const first = start(openStore())
    const turn = s.fullTurn('left', 'open')
    for (const record of turn) first.capture.handleEvent(session, record)
    await first.capture.dispose()

    const store = openStore()
    const second = start(store)
    await second.capture.sealStale((turn.at(-1)?.time ?? 0) + 31 * 60_000)
    const [meta] = (await store.readIndex(OWNER_SCOPE)).episodes
    expect(meta).toMatchObject({ status: 'sealed', sealReason: 'idle', seqRange: { first: 0, last: 5 }, tokens: { raw: 'left'.length + 'open'.length } })
    expect(second.sealed.map(sealed => sealed.id)).toEqual([meta?.id])
    expect(second.warnings).toEqual([])
  })

  it('leaves episodes opened by a live foreign process alone in sealStale, but seals those of exited ones', async () => {
    const child = spawnSync(process.execPath, ['-e', ''])
    const owners: EpisodeOwner[] = [
      { pid: process.ppid, startedAt: Date.now() },
      { pid: child.pid!, startedAt: Date.now() },
    ]
    for (const [position, owner] of owners.entries()) {
      const s = new EventStream()
      const foreign = start(openStore(owner))
      for (const record of s.fullTurn('left', 'open')) foreign.capture.handleEvent({ sessionId: `session-${position}` }, record)
      await foreign.capture.dispose()
    }

    const store = openStore()
    const sweeper = start(store)
    await sweeper.capture.sealStale(Number.MAX_SAFE_INTEGER, 0)
    const episodes = (await store.readIndex(OWNER_SCOPE)).episodes
    expect(episodes.map(meta => [meta.sessionId, meta.status])).toEqual([
      ['session-0', 'open'],
      ['session-1', 'sealed'],
    ])
    expect(sweeper.sealed.map(meta => meta.sessionId)).toEqual(['session-1'])
  })
})
