import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCapture, type CaptureDeps, type CaptureOptions } from '../../src/capture/capture.ts'
import { OWNER_SCOPE, type EpisodeMeta, type RawEventRecord, type ScopeDecision, type ScopeId, type SessionDescriptor } from '../../src/contracts.ts'
import { EventStream, FakeStore, range, seqs } from './fixtures.ts'

const MINUTE = 60_000
const session: SessionDescriptor = { sessionId: 'session-aaaa-1111' }
const ownerDecision: ScopeDecision = { scope: OWNER_SCOPE, capture: true, private: true, reason: 'default' }

interface HarnessOptions {
  readonly store?: FakeStore
  readonly resolveScope?: CaptureDeps['resolveScope']
  readonly onSealed?: CaptureDeps['onSealed']
}

function setup(options: Partial<CaptureOptions> = {}, extra: HarnessOptions = {}) {
  const store = extra.store ?? new FakeStore()
  const sealed: { scope: ScopeId; meta: EpisodeMeta }[] = []
  const warnings: string[] = []
  const capture = createCapture({
    store,
    estimator: { estimate: text => text.length },
    clock: { now: () => 0 },
    resolveScope: extra.resolveScope ?? (() => ownerDecision),
    onSealed: extra.onSealed ?? ((scope, meta) => {
      sealed.push({ scope, meta })
    }),
    options: { idleMinutes: 30, maxEpisodeTokens: 100_000, captureReasoning: true, flushDelayMs: 60_000, ...options },
    logger: { warn: message => warnings.push(message) },
  })
  const feed = (records: readonly RawEventRecord[], descriptor: SessionDescriptor = session) => {
    for (const record of records) capture.handleEvent(descriptor, record)
  }
  return { store, capture, sealed, warnings, feed }
}

function textTokens(...texts: string[]): number {
  return texts.reduce((total, text) => total + text.length, 0)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('normal capture', () => {
  it('appends turns losslessly to one open episode, flushes on turn/end, and seals on end', async () => {
    const { store, capture, sealed, warnings, feed } = setup()
    const s = new EventStream()
    const records = [...s.fullTurn('hello there', 'hi, how are you'), ...s.fullTurn('fine thanks', 'great to hear')]
    feed(records)
    await capture.settle()

    const episodes = store.list()
    expect(episodes).toHaveLength(1)
    const [episode] = episodes
    expect(episode?.meta.status).toBe('open')
    expect(episode?.meta.seqRange.first).toBe(0)
    expect(episode?.meta.startedAt).toBe(records[0]?.time)
    expect(episode?.raw).toEqual(records)
    expect(store.state.lastSeq[session.sessionId]).toBe(11)
    expect(sealed).toEqual([])

    await capture.sealSession(session.sessionId, 'end')
    expect(episode?.meta).toMatchObject({
      status: 'sealed',
      sealReason: 'end',
      seqRange: { first: 0, last: 11 },
      endedAt: records[11]?.time,
      tokens: { raw: textTokens('hello there', 'hi, how are you', 'fine thanks', 'great to hear') },
    })
    expect(sealed).toEqual([{ scope: OWNER_SCOPE, meta: episode?.meta }])
    expect(warnings).toEqual([])
  })

  it('buffers records until the debounce delay elapses', async () => {
    vi.useFakeTimers()
    const { store, capture, feed } = setup({ flushDelayMs: 2000 })
    const s = new EventStream()
    feed([s.turnStart(), s.user('hi'), s.stepStart()])
    await capture.settle()
    expect(store.list()).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1999)
    await capture.settle()
    expect(store.list()).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    await capture.settle()
    expect(seqs(store.list()[0]?.raw ?? [])).toEqual([0, 1, 2])
  })

  it('writes on flushSession and coalesces repeated flush requests', async () => {
    const { store, capture, feed } = setup()
    const append = vi.spyOn(store, 'appendRaw')
    const s = new EventStream()
    feed([s.turnStart(), s.user('hi')])
    await Promise.all([capture.flushSession(session.sessionId), capture.flushSession(session.sessionId), capture.flushSession(session.sessionId)])
    expect(append).toHaveBeenCalledTimes(1)
    expect(seqs(store.list()[0]?.raw ?? [])).toEqual([0, 1])
    await capture.flushSession(session.sessionId)
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('never stores memory-cloud messages but keeps every other user message source', async () => {
    const { store, capture, feed } = setup()
    const s = new EventStream()
    feed([
      s.turnStart(),
      s.user('<memory-cloud>old memories</memory-cloud>', { kind: 'memory-cloud' }),
      s.user('hello'),
      s.user('file changed', { kind: 'file-change' }),
      s.user('runtime facts', { kind: 'runtime-context' }),
      s.stepStart(),
      s.assistant('ok'),
      s.stepEnd(),
      s.turnEnd(),
    ])
    await capture.sealSession(session.sessionId, 'end')
    const [episode] = store.list()
    expect(seqs(episode?.raw ?? [])).toEqual([0, 2, 3, 4, 5, 6, 7, 8])
    expect(episode?.meta.tokens.raw).toBe(textTokens('hello', 'file changed', 'ok'))
  })
})

describe('reasoning', () => {
  function reasoningTurn() {
    const s = new EventStream()
    return [s.turnStart(), s.user('q'), s.stepStart(), s.assistant('answer', { reasoning: 'secret chain' }), s.stepEnd(), s.turnEnd()]
  }

  it('strips reasoning blocks and stream records when captureReasoning is false', async () => {
    const records = reasoningTurn()
    const { store, capture, feed } = setup({ captureReasoning: false })
    feed(records)
    await capture.sealSession(session.sessionId, 'end')
    const [episode] = store.list()
    const assistant = episode?.raw[3]
    expect(JSON.stringify(episode?.raw)).not.toContain('secret chain')
    expect(JSON.stringify(episode?.raw)).not.toContain('"reasoning')
    expect(assistant?.data).toMatchObject({
      message: { content: [{ type: 'text', text: 'answer' }] },
      stream: [
        { type: 'text-chunks', texts: ['answer'] },
        { type: 'chunk', chunk: { type: 'finish' } },
      ],
    })
    expect(episode?.meta.tokens.raw).toBe(textTokens('q', 'answer'))
    expect(episode?.raw.filter(record => record.type !== 'assistant/message')).toEqual(records.filter(record => record.type !== 'assistant/message'))
  })

  it('keeps reasoning verbatim when captureReasoning is true', async () => {
    const records = reasoningTurn()
    const { store, capture, feed } = setup({ captureReasoning: true })
    feed(records)
    await capture.sealSession(session.sessionId, 'end')
    expect(store.list()[0]?.raw).toEqual(records)
  })
})

describe('skipped sessions', () => {
  it('ignores subagent sessions without resolving a scope or touching the store', async () => {
    const resolveScope = vi.fn(() => ownerDecision)
    const { store, capture, sealed, feed } = setup({}, { resolveScope })
    const s = new EventStream()
    const child: SessionDescriptor = { sessionId: 'child-1', origin: 'subagent', parentSession: session.sessionId, delegationDepth: 1 }
    feed(s.fullTurn('task', 'done'), child)
    await capture.flush()
    await capture.sealSession(child.sessionId, 'end')
    await capture.sealIdle(Number.MAX_SAFE_INTEGER)
    expect(resolveScope).not.toHaveBeenCalled()
    expect(store.calls).toBe(0)
    expect(sealed).toEqual([])
  })

  it('ignores sessions whose scope decision disables capture, resolving once per turn', async () => {
    const resolveScope = vi.fn((): ScopeDecision => ({ scope: 'guest' as ScopeId, capture: false, private: false, reason: 'rule' }))
    const { store, capture, sealed, feed } = setup({}, { resolveScope })
    const s = new EventStream()
    feed([...s.fullTurn('a', 'b'), ...s.fullTurn('c', 'd')])
    await capture.flush()
    await capture.sealIdle(Number.MAX_SAFE_INTEGER)
    await capture.sealSession(session.sessionId, 'end')
    expect(resolveScope).toHaveBeenCalledTimes(2)
    expect(store.calls).toBe(0)
    expect(sealed).toEqual([])
  })

  it('stores episodes under the resolved scope', async () => {
    const group = 'qq-group-42' as ScopeId
    const { store, capture, sealed, feed } = setup({}, { resolveScope: () => ({ scope: group, capture: true, private: false, reason: 'rule' }) })
    const s = new EventStream()
    feed(s.fullTurn('hi all', 'hello group'))
    await capture.sealSession(session.sessionId, 'end')
    expect(store.list(group)).toHaveLength(1)
    expect(store.list(OWNER_SCOPE)).toHaveLength(0)
    expect(sealed[0]?.scope).toBe(group)
  })
})

describe('compaction sealing', () => {
  it('seals at the last real shadowed seq and moves the retained tail into a fresh episode', async () => {
    const { store, capture, sealed, warnings, feed } = setup()
    const s = new EventStream()
    const turnA = s.fullTurn('user A', 'assistant A')
    const turnB = s.fullTurn('user B', 'assistant B')
    const turnC = s.fullTurn('user C', 'assistant C')
    const turnDStart = [s.turnStart(), s.user('user D')]
    const firstCompaction = s.compaction([1, 3, 7, 9], 4)
    const turnDEnd = [s.stepStart(), s.assistant('assistant D'), s.stepEnd(), s.turnEnd()]
    expect(seqs(firstCompaction)).toEqual([20, 21, 22, 23])
    feed([...turnA, ...turnB, ...turnC, ...turnDStart, ...firstCompaction, ...turnDEnd])
    await capture.settle()

    const [first, second] = store.list()
    expect(first?.meta).toMatchObject({
      status: 'sealed',
      sealReason: 'compaction',
      seqRange: { first: 0, last: 9 },
      shadowedSeqs: [1, 3, 7, 9],
      endedAt: turnB[3]?.time,
      tokens: { raw: textTokens('user A', 'assistant A', 'user B', 'assistant B') },
    })
    expect(seqs(store.owned(first!))).toEqual(range(0, 9))
    expect(second?.meta.status).toBe('open')
    expect(second?.meta.seqRange.first).toBe(10)
    expect(seqs(second?.raw ?? [])).toEqual(range(10, 27))
    expect(sealed.map(entry => entry.meta.id)).toEqual([first?.meta.id])

    const secondCompaction = s.compaction([22, 13, 15, 19])
    feed(secondCompaction)
    await capture.flush()

    const [, again, third] = store.list()
    expect(again?.meta).toMatchObject({
      status: 'sealed',
      sealReason: 'compaction',
      seqRange: { first: 10, last: 19 },
      shadowedSeqs: [22, 13, 15, 19],
      tokens: { raw: textTokens('user C', 'assistant C', 'user D') },
    })
    expect(seqs(store.owned(again!))).toEqual(range(10, 19))
    expect(third?.meta.status).toBe('open')
    expect(seqs(third?.raw ?? [])).toEqual(range(20, 31))

    await capture.sealSession(session.sessionId, 'end')
    expect(third?.meta).toMatchObject({ status: 'sealed', sealReason: 'end', seqRange: { first: 20, last: 31 }, tokens: { raw: textTokens('assistant D') } })
    const owned = store.list().flatMap(episode => seqs(store.owned(episode)))
    expect(owned).toEqual(range(0, 31))
    expect(sealed.map(entry => entry.meta.sealReason)).toEqual(['compaction', 'compaction', 'end'])
    expect(warnings).toEqual([])
  })

  it('does not seal when the shadowed region lies entirely in an earlier episode', async () => {
    const { store, capture, sealed, feed } = setup()
    const s = new EventStream()
    const turnA = s.fullTurn('user A', 'assistant A')
    feed(turnA)
    await capture.sealIdle((turnA[5]?.time ?? 0) + 30 * MINUTE)
    const turnB = s.fullTurn('user B', 'assistant B')
    const compaction = s.compaction([1, 3])
    feed([...turnB, ...compaction])
    await capture.flush()

    const [first, second] = store.list()
    expect(first?.meta).toMatchObject({ status: 'sealed', sealReason: 'idle', seqRange: { first: 0, last: 5 } })
    expect(second?.meta.status).toBe('open')
    expect(seqs(second?.raw ?? [])).toEqual(range(6, 15))
    expect(sealed).toHaveLength(1)

    feed(s.compaction([14, 3, 7, 9]))
    await capture.flush()
    const [, sealedSecond] = store.list()
    expect(sealedSecond?.meta).toMatchObject({ status: 'sealed', sealReason: 'compaction', seqRange: { first: 6, last: 9 }, shadowedSeqs: [14, 3, 7, 9] })
    expect(seqs(store.owned(sealedSecond!))).toEqual(range(6, 9))
    expect(sealed).toHaveLength(2)

    await capture.sealSession(session.sessionId, 'end')
    expect(store.list()).toHaveLength(2)
    expect(sealed).toHaveLength(2)
  })
})

describe('idle sealing', () => {
  it('seals after idleMinutes and starts a new episode afterwards', async () => {
    const { store, capture, sealed, feed } = setup()
    const s = new EventStream()
    const turn = s.fullTurn('morning', 'good morning')
    feed(turn)
    const last = turn[5]?.time ?? 0
    await capture.sealIdle(last + 30 * MINUTE - 1)
    expect(store.list()[0]?.meta.status).toBe('open')

    await capture.sealIdle(last + 30 * MINUTE)
    expect(store.list()[0]?.meta).toMatchObject({ status: 'sealed', sealReason: 'idle', seqRange: { first: 0, last: 5 }, endedAt: last })
    expect(sealed).toHaveLength(1)

    feed(s.fullTurn('evening', 'good evening'))
    await capture.settle()
    const [, next] = store.list()
    expect(next?.meta.status).toBe('open')
    expect(seqs(next?.raw ?? [])).toEqual(range(6, 11))
  })

  it('does not seal inside an open turn', async () => {
    const { store, capture, feed } = setup()
    const s = new EventStream()
    feed([s.turnStart(), s.user('build it'), s.stepStart(), s.assistant('running', { toolCall: 'shell' })])
    await capture.flush()
    await capture.sealIdle(Number.MAX_SAFE_INTEGER)
    expect(store.list()[0]?.meta.status).toBe('open')

    feed([s.toolResult('ok'), s.stepEnd(), s.turnEnd()])
    await capture.sealIdle(Number.MAX_SAFE_INTEGER)
    expect(store.list()[0]?.meta).toMatchObject({ status: 'sealed', sealReason: 'idle', seqRange: { first: 0, last: 6 } })
  })

  it('keeps non-message events pending instead of sealing an empty episode', async () => {
    const { store, capture, sealed, feed } = setup()
    const s = new EventStream()
    const preamble = [s.event('permission/preset', { preset: 'default' }), s.event('sandbox/mode', { mode: 'workspace' })]
    feed(preamble)
    await capture.flush()
    await capture.sealIdle(Number.MAX_SAFE_INTEGER)
    expect(store.list()).toHaveLength(0)

    feed(s.fullTurn('hi', 'hello'))
    await capture.settle()
    expect(seqs(store.list()[0]?.raw ?? [])).toEqual(range(0, 7))
    expect(sealed).toEqual([])
  })
})

describe('size sealing', () => {
  it('splits at the previous turn/end boundary', async () => {
    const { store, capture, sealed, feed } = setup({ maxEpisodeTokens: 50 })
    const s = new EventStream()
    feed(s.fullTurn('a'.repeat(20), 'b'.repeat(20)))
    feed(s.fullTurn('c'.repeat(20), 'd'.repeat(20)))
    await capture.settle()
    const [first, second] = store.list()
    expect(first?.meta).toMatchObject({ status: 'sealed', sealReason: 'size', seqRange: { first: 0, last: 5 }, tokens: { raw: 40 } })
    expect(seqs(store.owned(first!))).toEqual(range(0, 5))
    expect(second?.meta.status).toBe('open')
    expect(seqs(second?.raw ?? [])).toEqual(range(6, 11))
    expect(sealed.map(entry => entry.meta.sealReason)).toEqual(['size'])
  })

  it('falls back to a step/end boundary inside one long turn', async () => {
    const { store, capture, feed } = setup({ maxEpisodeTokens: 50 })
    const s = new EventStream()
    feed([
      s.turnStart(),
      s.user('a'.repeat(20)),
      s.stepStart(),
      s.assistant('b'.repeat(10), { toolCall: 'read' }),
      s.toolResult('c'.repeat(10)),
      s.stepEnd(),
      s.stepStart(),
      s.assistant('d'.repeat(20)),
      s.stepEnd(),
      s.turnEnd(),
    ])
    await capture.settle()
    const [first, second] = store.list()
    expect(first?.meta).toMatchObject({ sealReason: 'size', seqRange: { first: 0, last: 5 }, tokens: { raw: 20 + 18 + 10 } })
    expect(seqs(second?.raw ?? [])).toEqual(range(6, 9))
  })

  it('seals at the current record when no boundary exists', async () => {
    const { store, capture, feed } = setup({ maxEpisodeTokens: 10 })
    const s = new EventStream()
    feed([s.turnStart(), s.user('x'.repeat(20)), s.stepStart(), s.assistant('y'), s.stepEnd(), s.turnEnd()])
    await capture.settle()
    const [first] = store.list()
    expect(first?.meta).toMatchObject({ sealReason: 'size', seqRange: { first: 0, last: 1 } })
  })

  it('treats maxEpisodeTokens 0 as unlimited', async () => {
    const { store, capture, feed } = setup({ maxEpisodeTokens: 0 })
    const s = new EventStream()
    feed([...s.fullTurn('x'.repeat(50), 'y'.repeat(50)), ...s.fullTurn('z', 'w')])
    await capture.settle()
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]?.meta.status).toBe('open')
  })
})

describe('restart', () => {
  it('adopts the open episode and skips replayed seqs at or below the watermark', async () => {
    const store = new FakeStore()
    const before = setup({}, { store })
    const s = new EventStream()
    const firstRun = [...s.fullTurn('one', 'uno'), s.turnStart(), s.user('two')]
    before.feed(firstRun)
    await before.capture.dispose()
    expect(store.state.lastSeq[session.sessionId]).toBe(5)
    expect(store.list()[0]?.meta.status).toBe('open')

    const after = setup({}, { store })
    const secondRun = [s.stepStart(), s.assistant('dos'), s.stepEnd(), s.turnEnd()]
    after.feed([...firstRun.slice(4), ...secondRun])
    await after.capture.settle()
    expect(store.list()).toHaveLength(1)
    expect(seqs(store.list()[0]?.raw ?? [])).toEqual(range(0, 11))

    await after.capture.sealSession(session.sessionId, 'end')
    expect(store.list()[0]?.meta).toMatchObject({ status: 'sealed', seqRange: { first: 0, last: 11 }, tokens: { raw: textTokens('one', 'uno', 'two', 'dos') } })
    expect(before.sealed).toEqual([])
    expect(after.sealed).toHaveLength(1)
    expect(after.warnings).toEqual([])
  })

  it('skips replayed seqs of an already sealed episode using the watermark alone', async () => {
    const store = new FakeStore()
    const before = setup({}, { store })
    const s = new EventStream()
    const firstTurn = s.fullTurn('one', 'uno')
    before.feed(firstTurn)
    await before.capture.sealSession(session.sessionId, 'end')
    await before.capture.dispose()

    const after = setup({}, { store })
    after.feed([...firstTurn, ...s.fullTurn('two', 'dos')])
    await after.capture.settle()
    const [first, second] = store.list()
    expect(first?.meta).toMatchObject({ status: 'sealed', seqRange: { first: 0, last: 5 } })
    expect(second?.meta.seqRange.first).toBe(6)
    expect(seqs(second?.raw ?? [])).toEqual(range(6, 11))
  })

  it('waits on dispose for onSealed work started by an end seal, so a process exit cannot cut it short', async () => {
    let finished = false
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const { capture, feed } = setup({}, {
      onSealed: async () => {
        await gate
        finished = true
      },
    })
    feed(new EventStream().fullTurn('hello', 'hi'))
    const ending = capture.sealSession(session.sessionId, 'end')
    await ending
    let disposed = false
    const disposing = capture.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(disposed).toBe(false)
    release()
    await disposing
    expect(finished).toBe(true)
  })

  it('ignores events after dispose', async () => {
    const { store, capture, feed } = setup()
    await capture.dispose()
    feed(new EventStream().fullTurn('late', 'too late'))
    await capture.flush()
    expect(store.calls).toBe(0)
  })
})

describe('stale episodes', () => {
  it('seals episodes left open by an earlier process once they are older than idleMinutes', async () => {
    const store = new FakeStore()
    const before = setup({}, { store })
    const s = new EventStream()
    const turn = s.fullTurn('left open', 'indeed')
    before.feed(turn)
    await before.capture.dispose()
    const last = turn[5]?.time ?? 0

    const after = setup({}, { store })
    await after.capture.sealStale(last + 10 * MINUTE)
    expect(store.list()[0]?.meta.status).toBe('open')

    await after.capture.sealStale(last + 30 * MINUTE)
    expect(store.list()[0]?.meta).toMatchObject({ status: 'sealed', sealReason: 'idle', seqRange: { first: 0, last: 5 }, endedAt: last, tokens: { raw: textTokens('left open', 'indeed') } })
    expect(after.sealed).toHaveLength(1)
  })

  it('leaves episodes of sessions this process is capturing alone', async () => {
    const store = new FakeStore()
    const before = setup({}, { store })
    const s = new EventStream()
    before.feed(s.fullTurn('left open', 'indeed'))
    await before.capture.dispose()

    const after = setup({}, { store })
    after.feed([s.turnStart()])
    await after.capture.settle()
    await after.capture.sealStale(Number.MAX_SAFE_INTEGER)
    expect(store.list()[0]?.meta.status).toBe('open')
    expect(after.sealed).toEqual([])
  })
})

describe('empty episodes', () => {
  it('drops an episode without user or assistant messages on end', async () => {
    const { store, capture, sealed, feed } = setup()
    const s = new EventStream()
    feed([
      s.event('permission/preset', { preset: 'default' }),
      s.user('<compacted-summary>x</compacted-summary>', { kind: 'compact-checkpoint' }),
      s.user('runtime', { kind: 'runtime-context' }),
      s.turnStart(),
      s.turnEnd(),
    ])
    await capture.sealSession(session.sessionId, 'end')
    expect(store.list()).toHaveLength(0)
    expect(sealed).toEqual([])
  })
})

describe('resilience', () => {
  it('logs store failures and retries buffered records on the next flush', async () => {
    const { store, capture, warnings, feed } = setup()
    store.failNext.set('appendRaw', 1)
    const s = new EventStream()
    feed(s.fullTurn('hi', 'hello'))
    await capture.settle()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('injected appendRaw failure')
    expect(store.list()[0]?.raw).toEqual([])

    await capture.flush()
    expect(seqs(store.list()[0]?.raw ?? [])).toEqual(range(0, 5))
  })

  it('contains synchronous and asynchronous onSealed failures', async () => {
    let calls = 0
    const { store, capture, warnings, feed } = setup({}, {
      onSealed: () => {
        calls++
        if (calls === 1) throw new Error('sync boom')
        return Promise.reject(new Error('async boom'))
      },
    })
    const s = new EventStream()
    feed(s.fullTurn('one', 'uno'))
    await capture.sealIdle(Number.MAX_SAFE_INTEGER)
    feed(s.fullTurn('two', 'dos'))
    await capture.sealSession(session.sessionId, 'end')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(2)
    expect(store.list().map(episode => episode.meta.status)).toEqual(['sealed', 'sealed'])
    expect(warnings.some(message => message.includes('sync boom'))).toBe(true)
    expect(warnings.some(message => message.includes('async boom'))).toBe(true)
  })

  it('does not seal or notify twice when another process already sealed the episode', async () => {
    const { store, capture, sealed, warnings, feed } = setup()
    const s = new EventStream()
    feed(s.fullTurn('hi', 'hello'))
    await capture.settle()
    const [episode] = store.list()
    await store.sealEpisode(OWNER_SCOPE, episode!.meta.id, { reason: 'idle', endedAt: 1, lastSeq: 5, rawTokens: 7 })

    await capture.sealIdle(Number.MAX_SAFE_INTEGER)
    expect(sealed).toEqual([])
    expect(warnings.some(message => message.includes('no longer open'))).toBe(true)
  })

  it('contains scope resolver and estimator exceptions', async () => {
    let fail = true
    const store = new FakeStore()
    const warnings: string[] = []
    const capture = createCapture({
      store,
      estimator: {
        estimate: () => {
          throw new Error('estimator boom')
        },
      },
      clock: { now: () => 0 },
      resolveScope: () => {
        if (fail) {
          fail = false
          throw new Error('resolver boom')
        }
        return ownerDecision
      },
      onSealed: () => {},
      options: { idleMinutes: 30, maxEpisodeTokens: 100_000, captureReasoning: true },
      logger: { warn: message => warnings.push(message) },
    })
    const s = new EventStream()
    const records = s.fullTurn('abcd', 'efgh')
    for (const record of records) capture.handleEvent(session, record)
    await capture.sealSession(session.sessionId, 'end')
    expect(warnings.some(message => message.includes('resolver boom'))).toBe(true)
    expect(warnings.some(message => message.includes('estimator boom'))).toBe(true)
    const [episode] = store.list()
    expect(seqs(episode?.raw ?? [])).toEqual(range(1, 5))
    expect(episode?.meta.tokens.raw).toBe(2)
  })
})

describe('transactional seals', () => {
  it.each(['openEpisode', 'appendRaw', 'readIndex', 'sealEpisode'])('keeps every record when %s fails during a size split, and retries the seal', async method => {
    const { store, capture, sealed, warnings, feed } = setup({ maxEpisodeTokens: 50 })
    const s = new EventStream()
    feed([s.turnStart(), s.user('a'.repeat(20)), s.stepStart(), s.assistant('b'.repeat(20)), s.stepEnd(), s.stepStart()])
    await capture.settle()
    store.failNext.set(method, 1)
    feed([s.assistant('c'.repeat(20))])
    await capture.settle()
    expect(warnings.some(message => message.includes(`injected ${method} failure`))).toBe(true)
    expect(sealed).toEqual([])

    feed([s.stepEnd(), s.turnEnd()])
    await capture.settle()
    await capture.sealSession(session.sessionId, 'end')
    const episodes = store.list()
    expect(episodes.map(episode => [episode.meta.status, episode.meta.sealReason, episode.meta.seqRange])).toEqual([
      ['sealed', 'size', { first: 0, last: 4 }],
      ['sealed', 'end', { first: 5, last: 8 }],
    ])
    expect(episodes.flatMap(episode => seqs(store.owned(episode)))).toEqual(range(0, 8))
    expect(sealed.map(entry => entry.meta.sealReason)).toEqual(['size', 'end'])
  })

  it('keeps the compaction boundary and shadowed seqs when the compaction seal fails once', async () => {
    const { store, capture, sealed, feed } = setup()
    const s = new EventStream()
    feed([...s.fullTurn('user A', 'assistant A'), ...s.fullTurn('user B', 'assistant B')])
    await capture.settle()
    store.failNext.set('sealEpisode', 1)
    feed(s.compaction([1, 3], 2))
    await capture.settle()
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]?.meta.status).toBe('open')

    feed(s.fullTurn('user C', 'assistant C'))
    await capture.sealSession(session.sessionId, 'end')
    const episodes = store.list()
    expect(episodes[0]?.meta).toMatchObject({ status: 'sealed', sealReason: 'compaction', seqRange: { first: 0, last: 3 }, shadowedSeqs: [1, 3] })
    expect(episodes[1]?.meta).toMatchObject({ status: 'sealed', sealReason: 'end', seqRange: { first: 4, last: 21 } })
    expect(episodes.flatMap(episode => seqs(store.owned(episode)))).toEqual(range(0, 21))
    expect(sealed.map(entry => entry.meta.sealReason)).toEqual(['compaction', 'end'])
  })

  it('retries a failed end seal on the next flush instead of forgetting the episode', async () => {
    const { store, capture, sealed, feed } = setup()
    feed(new EventStream().fullTurn('hi', 'hello'))
    await capture.settle()
    store.failNext.set('sealEpisode', 1)
    await capture.sealSession(session.sessionId, 'end')
    await capture.sealStale(Number.MAX_SAFE_INTEGER, 0)
    expect(store.list()[0]?.meta.status).toBe('open')
    expect(sealed).toEqual([])

    await capture.flush()
    expect(store.list()[0]?.meta).toMatchObject({ status: 'sealed', sealReason: 'end', seqRange: { first: 0, last: 5 } })
    expect(sealed).toHaveLength(1)
  })
})

describe('foreign seals', () => {
  it('continues in a fresh episode when another capture seals the open episode under a live session', async () => {
    const store = new FakeStore()
    const live = setup({}, { store })
    const sweeper = setup({}, { store })
    const s = new EventStream()
    live.feed([...s.fullTurn('one', 'uno'), s.turnStart(), s.user('two')])
    await live.capture.settle()
    await sweeper.capture.sealStale(Number.MAX_SAFE_INTEGER, 0)
    expect(store.list()[0]?.meta).toMatchObject({ status: 'sealed', seqRange: { first: 0, last: 5 } })

    live.feed([s.stepStart(), s.assistant('dos'), s.stepEnd(), s.turnEnd()])
    await live.capture.settle()
    await live.capture.sealSession(session.sessionId, 'end')
    const episodes = store.list()
    expect(episodes.map(episode => [episode.meta.status, episode.meta.seqRange])).toEqual([
      ['sealed', { first: 0, last: 5 }],
      ['sealed', { first: 6, last: 11 }],
    ])
    expect(episodes.flatMap(episode => seqs(store.owned(episode)))).toEqual(range(0, 11))
    expect(sweeper.sealed).toHaveLength(1)
    expect(live.sealed.map(entry => entry.meta.id)).toEqual([episodes[1]?.meta.id])
    expect(live.warnings.some(message => message.includes('no longer open'))).toBe(true)
  })

  it('seals the unwritten remainder in a new episode when the split finds its episode sealed', async () => {
    const store = new FakeStore()
    const live = setup({}, { store })
    const sweeper = setup({}, { store })
    const s = new EventStream()
    live.feed([...s.fullTurn('one', 'uno'), s.turnStart(), s.user('two')])
    await live.capture.settle()
    await sweeper.capture.sealStale(Number.MAX_SAFE_INTEGER, 0)

    await live.capture.sealSession(session.sessionId, 'end')
    const episodes = store.list()
    expect(episodes.map(episode => [episode.meta.status, episode.meta.sealReason, episode.meta.seqRange])).toEqual([
      ['sealed', 'idle', { first: 0, last: 5 }],
      ['sealed', 'end', { first: 6, last: 7 }],
    ])
    expect(episodes.flatMap(episode => seqs(store.owned(episode)))).toEqual(range(0, 7))
  })
})

describe('rescoping', () => {
  const group = 'qq-group-42' as ScopeId

  function switchable() {
    const current = { scope: OWNER_SCOPE, capture: true }
    const resolveScope = vi.fn((descriptor: SessionDescriptor): ScopeDecision => {
      const scope = descriptor.tags?.includes('group') === true ? group : current.scope
      return { scope, capture: current.capture, private: scope === OWNER_SCOPE, reason: 'rule' }
    })
    return { current, resolveScope }
  }

  it('rescope seals the episode and resolves the scope again on the next event', async () => {
    const { current, resolveScope } = switchable()
    const { store, capture, sealed, feed } = setup({}, { resolveScope })
    const s = new EventStream()
    feed([...s.fullTurn('private', 'secret'), s.turnStart(), s.user('still private')])
    await capture.settle()
    current.scope = group
    await capture.rescope(session.sessionId)
    expect(store.list(OWNER_SCOPE).map(episode => [episode.meta.status, episode.meta.sealReason, episode.meta.seqRange])).toEqual([
      ['sealed', 'end', { first: 0, last: 7 }],
    ])

    feed([s.stepStart(), s.assistant('public'), s.stepEnd(), s.turnEnd()])
    await capture.sealSession(session.sessionId, 'end')
    expect(store.list(group).flatMap(episode => seqs(store.owned(episode)))).toEqual(range(8, 11))
    expect(store.list(OWNER_SCOPE).flatMap(episode => seqs(store.owned(episode)))).toEqual(range(0, 7))
    expect(sealed.map(entry => entry.scope)).toEqual([OWNER_SCOPE, group])
  })

  it('re-resolves at each turn start and moves the next turn to the new scope', async () => {
    const { current, resolveScope } = switchable()
    const { store, capture, feed } = setup({}, { resolveScope })
    const s = new EventStream()
    feed(s.fullTurn('one', 'uno'))
    await capture.settle()
    current.scope = group
    feed(s.fullTurn('two', 'dos'))
    await capture.settle()
    expect(store.list(OWNER_SCOPE).map(episode => [episode.meta.status, episode.meta.seqRange])).toEqual([['sealed', { first: 0, last: 5 }]])
    expect(store.list(group).map(episode => episode.meta.status)).toEqual(['open'])
    expect(seqs(store.list(group)[0]?.raw ?? [])).toEqual(range(6, 11))
  })

  it('re-resolves when the session descriptor changes mid-turn', async () => {
    const { resolveScope } = switchable()
    const { store, capture, feed } = setup({}, { resolveScope })
    const s = new EventStream()
    feed([s.turnStart(), s.user('before the tag')])
    feed([s.stepStart(), s.assistant('after the tag'), s.stepEnd(), s.turnEnd()], { ...session, tags: ['group'] })
    await capture.settle()
    expect(store.list(OWNER_SCOPE).map(episode => [episode.meta.status, episode.meta.seqRange])).toEqual([['sealed', { first: 0, last: 1 }]])
    expect(seqs(store.list(group)[0]?.raw ?? [])).toEqual(range(2, 5))
  })

  it('stops capturing once the rules disable capture for the session', async () => {
    const { current, resolveScope } = switchable()
    const { store, capture, feed } = setup({}, { resolveScope })
    const s = new EventStream()
    feed(s.fullTurn('one', 'uno'))
    await capture.settle()
    current.capture = false
    feed(s.fullTurn('two', 'dos'))
    await capture.flush()
    await capture.dispose()
    expect(store.list().map(episode => [episode.meta.status, episode.meta.seqRange])).toEqual([['sealed', { first: 0, last: 5 }]])
    expect(store.list().flatMap(episode => episode.raw).map(record => record.seq)).toEqual(range(0, 5))
  })
})

describe('watermark and shutdown', () => {
  it('records the watermark at turn/end and seals, not on every flush', async () => {
    const { store, capture, feed } = setup()
    const s = new EventStream()
    feed([s.turnStart(), s.user('hi')])
    await capture.flushSession(session.sessionId)
    expect(seqs(store.list()[0]?.raw ?? [])).toEqual([0, 1])
    expect(store.state.lastSeq[session.sessionId]).toBeUndefined()

    feed([s.stepStart(), s.assistant('hello'), s.stepEnd(), s.turnEnd()])
    await capture.settle()
    expect(store.state.lastSeq[session.sessionId]).toBe(5)
  })

  it('writes trailing non-message events at dispose, so the next process adopts them', async () => {
    const store = new FakeStore()
    const before = setup({}, { store })
    const s = new EventStream()
    before.feed(s.fullTurn('one', 'uno'))
    await before.capture.sealIdle(Number.MAX_SAFE_INTEGER)
    before.feed([s.event('session/title', { title: 'greeting' }), s.event('permission/preset', { preset: 'default' })])
    await before.capture.dispose()
    expect(store.list().map(episode => [episode.meta.status, seqs(episode.raw)])).toEqual([
      ['sealed', range(0, 5)],
      ['open', [6, 7]],
    ])

    const after = setup({}, { store })
    after.feed(s.fullTurn('two', 'dos'))
    await after.capture.sealSession(session.sessionId, 'end')
    expect(store.list()[1]?.meta).toMatchObject({ status: 'sealed', sealReason: 'end', seqRange: { first: 6, last: 13 } })
    expect(store.list().flatMap(episode => seqs(store.owned(episode)))).toEqual(range(0, 13))
  })
})
