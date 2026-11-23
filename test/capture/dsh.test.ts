import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCapture, type Capture } from '../../src/capture/capture.ts'
import { attachCaptureToDsh, describeSessionHeader, toRawEventRecord } from '../../src/capture/dsh.ts'
import { OWNER_SCOPE, type RawEventRecord } from '../../src/contracts.ts'
import { EventStream, FakeStore, range, seqs } from './fixtures.ts'

type Listener = (...args: unknown[]) => unknown

function fakeContext() {
  const listeners = new Map<string, Listener>()
  const warnings: string[] = []
  const ctx = {
    on(name: string, listener: Listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    effect(execute: () => () => void) {
      const dispose = execute()
      return async () => dispose()
    },
    logger: { warn: (message: string) => warnings.push(message) },
  }
  const emit = (name: string, ...args: unknown[]) => listeners.get(name)?.(...args)
  return { ctx: ctx as unknown as Context, listeners, warnings, emit }
}

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 4, id, createdAt: 0, isSeeded: false, ...extra } as SessionHeader
}

function fakeSession(id: string, extra: Partial<SessionHeader> = {}): Session {
  return { id, header: header(id, extra) } as unknown as Session
}

function asEvent(record: RawEventRecord): SessionEvent {
  return record as unknown as SessionEvent
}

function recordingCapture() {
  return {
    handleEvent: vi.fn<Capture['handleEvent']>(),
    flushSession: vi.fn<Capture['flushSession']>(async () => {}),
    sealIdle: vi.fn<Capture['sealIdle']>(async () => {}),
    sealSession: vi.fn<Capture['sealSession']>(async () => {}),
    rescope: vi.fn<Capture['rescope']>(async () => {}),
    sealStale: vi.fn<Capture['sealStale']>(async () => {}),
    flush: vi.fn<Capture['flush']>(async () => {}),
    settle: vi.fn<Capture['settle']>(async () => {}),
    dispose: vi.fn<Capture['dispose']>(async () => {}),
  } satisfies Capture
}

afterEach(() => {
  vi.useRealTimers()
})

describe('describeSessionHeader', () => {
  it('copies only present header fields', () => {
    expect(describeSessionHeader(header('s1'))).toStrictEqual({ sessionId: 's1' })
    expect(describeSessionHeader(header('s2', { cwd: '/work', agentPreset: 'standard' }))).toStrictEqual({ sessionId: 's2', cwd: '/work', agentPreset: 'standard' })
  })

  it('marks subagent sessions', () => {
    const parent = 'p1' as SessionHeader['id']
    expect(describeSessionHeader(header('c1', { origin: 'subagent', parentSession: parent, delegationDepth: 1 }))).toStrictEqual({
      sessionId: 'c1',
      origin: 'subagent',
      parentSession: 'p1',
      delegationDepth: 1,
    })
  })
})

describe('toRawEventRecord', () => {
  it('keeps the envelope and omits absent optional fields', () => {
    const plain = toRawEventRecord(asEvent({ seq: 3, time: 10, type: 'turn/start', data: { turn: 1 } }))
    expect(plain).toStrictEqual({ seq: 3, time: 10, type: 'turn/start', data: { turn: 1 } })

    const full = toRawEventRecord({ seq: 4, time: 11, type: 'session/title', data: { title: 't' }, ignorable: true, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] } as unknown as SessionEvent)
    expect(full).toStrictEqual({ seq: 4, time: 11, type: 'session/title', data: { title: 't' }, ignorable: true, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] })
  })
})

describe('attachCaptureToDsh', () => {
  it('routes session events, flushes, and disposal to the capture', () => {
    const { ctx, emit } = fakeContext()
    const capture = recordingCapture()
    const describe = vi.fn((session: Session) => describeSessionHeader(session.header))
    attachCaptureToDsh(ctx, capture, { describe })
    const session = fakeSession('s1', { cwd: '/work' })
    const s = new EventStream()
    const [first, second] = [s.turnStart(), s.user('hi')]

    emit('session/event', session, asEvent(first!))
    emit('session/event', session, asEvent(second!))
    emit('session/flush', session)
    emit('session/disposed', session)

    expect(describe).toHaveBeenCalledTimes(2)
    expect(capture.handleEvent).toHaveBeenNthCalledWith(1, { sessionId: 's1', cwd: '/work' }, first)
    expect(capture.handleEvent).toHaveBeenNthCalledWith(2, { sessionId: 's1', cwd: '/work' }, second)
    expect(capture.flushSession).toHaveBeenCalledWith('s1')
    expect(capture.sealSession).toHaveBeenCalledWith('s1', 'end')
  })

  it('contains synchronous throws and rejected promises from the capture', async () => {
    const { ctx, emit, warnings } = fakeContext()
    const capture = recordingCapture()
    capture.handleEvent.mockImplementation(() => {
      throw new Error('handle boom')
    })
    capture.flushSession.mockRejectedValue(new Error('flush boom'))
    capture.sealSession.mockImplementation(() => {
      throw new Error('seal boom')
    })
    attachCaptureToDsh(ctx, capture)
    const session = fakeSession('s1')
    expect(() => emit('session/event', session, asEvent(new EventStream().turnStart()))).not.toThrow()
    expect(() => emit('session/flush', session)).not.toThrow()
    expect(() => emit('session/disposed', session)).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warnings).toHaveLength(3)
    for (const message of ['handle boom', 'flush boom', 'seal boom']) {
      expect(warnings.some(warning => warning.includes(message))).toBe(true)
    }
  })

  it('runs idle checks on an interval until disposed', async () => {
    vi.useFakeTimers()
    const { ctx, listeners } = fakeContext()
    const capture = recordingCapture()
    const dispose = attachCaptureToDsh(ctx, capture, { idleCheckIntervalMs: 60_000 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(capture.sealIdle).toHaveBeenCalledTimes(1)
    await dispose()
    expect(listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(capture.sealIdle).toHaveBeenCalledTimes(1)
  })

  it('captures a real event stream end to end and skips subagents', async () => {
    const { ctx, emit } = fakeContext()
    const store = new FakeStore()
    const sealed: string[] = []
    const capture = createCapture({
      store,
      estimator: { estimate: text => text.length },
      clock: { now: () => 0 },
      resolveScope: () => ({ scope: OWNER_SCOPE, capture: true, private: true, reason: 'default' }),
      onSealed: (_scope, meta) => {
        sealed.push(meta.id)
      },
      options: { idleMinutes: 30, maxEpisodeTokens: 100_000, captureReasoning: true },
      logger: { warn: () => {} },
    })
    attachCaptureToDsh(ctx, capture)
    const main = fakeSession('main-session')
    const child = fakeSession('child-session', { origin: 'subagent', parentSession: 'main-session' as SessionHeader['id'], delegationDepth: 1 })
    const s = new EventStream()
    const turn = s.fullTurn('hello', 'hi')
    for (const record of turn) emit('session/event', main, asEvent(record))
    for (const record of new EventStream().fullTurn('task', 'done')) emit('session/event', child, asEvent(record))
    emit('session/disposed', child)
    emit('session/disposed', main)
    await capture.dispose()

    const episodes = store.list()
    expect(episodes).toHaveLength(1)
    expect(episodes[0]?.meta).toMatchObject({ sessionId: 'main-session', status: 'sealed', sealReason: 'end', seqRange: { first: 0, last: 5 } })
    expect(seqs(episodes[0]?.raw ?? [])).toEqual(range(0, 5))
    expect(sealed).toEqual([episodes[0]?.meta.id])
  })
})
