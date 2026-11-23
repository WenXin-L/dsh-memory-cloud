import { describe, expect, it, vi } from 'vitest'
import type { MemoryCloudRemoteClient, RemoteResultLike } from '../../src/client/host.ts'
import { createStatusStore } from '../../src/client/store.ts'
import type { StatusSnapshot } from '../../src/client/store.ts'
import type { MemoryCloudStatus } from '../../src/runtime/status.ts'
import { configView, wireStatus } from './fixtures.ts'

const ok = <T>(value: T): RemoteResultLike<T> => ({ ok: true, value })
const failed = (code: string, message: string): RemoteResultLike<never> => ({ ok: false, error: { code, message } })

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fakeRemote(overrides: Partial<MemoryCloudRemoteClient> = {}): MemoryCloudRemoteClient {
  return {
    status: vi.fn(async () => ok(wireStatus())),
    setLevel: vi.fn(async () => ok({ ok: true, via: 'settings' } as const)),
    setMode: vi.fn(async () => ok({ ok: true, via: 'settings' } as const)),
    takeover: vi.fn(async () => ok({ kind: 'preset', ok: true, action: 'applied' } as const)),
    restore: vi.fn(async () => ok({ kind: 'preset', ok: true, action: 'restored' } as const)),
    getConfig: vi.fn(async () => ok(configView())),
    setConfig: vi.fn(async () => ok({ ok: true, via: 'settings' } as const)),
    ...overrides,
  }
}

function record(store: { getSnapshot(): StatusSnapshot; subscribe(listener: () => void): () => void }): StatusSnapshot[] {
  const seen: StatusSnapshot[] = []
  store.subscribe(() => { seen.push(store.getSnapshot()) })
  return seen
}

describe('status store', () => {
  it('loads the status of the most recent session', async () => {
    const remote = fakeRemote()
    const signal = new AbortController().signal
    const store = createStatusStore(remote, signal)
    expect(store.getSnapshot()).toEqual({ phase: 'idle', refreshing: false })
    const seen = record(store)
    await store.refresh()
    expect(remote.status).toHaveBeenCalledWith(undefined, signal)
    expect(seen.map(snapshot => snapshot.phase)).toEqual(['loading', 'ready'])
    expect(store.getSnapshot()).toEqual({ phase: 'ready', status: wireStatus(), refreshing: false })
  })

  it('reports a failed first read and clears it on success', async () => {
    const status = vi.fn<MemoryCloudRemoteClient['status']>()
      .mockResolvedValueOnce(failed('gateway/invocation-unavailable', 'no active Remote method exports this endpoint'))
      .mockResolvedValueOnce(ok(wireStatus()))
      .mockResolvedValueOnce(failed('gateway/internal', 'boom'))
    const store = createStatusStore(fakeRemote({ status }), new AbortController().signal)
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ phase: 'error', failure: { code: 'gateway/invocation-unavailable' } })
    await store.refresh()
    expect(store.getSnapshot()).toEqual({ phase: 'ready', status: wireStatus(), refreshing: false })
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', status: wireStatus(), failure: { code: 'gateway/internal', message: 'boom' } })
  })

  it('keeps the newest of overlapping reads', async () => {
    const first = deferred<RemoteResultLike<MemoryCloudStatus>>()
    const second = deferred<RemoteResultLike<MemoryCloudStatus>>()
    const status = vi.fn<MemoryCloudRemoteClient['status']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const store = createStatusStore(fakeRemote({ status }), new AbortController().signal)
    const reads = [store.refresh(), store.refresh()]
    second.resolve(ok(wireStatus({ profile: 'newer' })))
    first.resolve(ok(wireStatus({ profile: 'older' })))
    await Promise.all(reads)
    expect(store.getSnapshot().status?.profile).toBe('newer')
  })

  it('runs one action at a time, records its outcome, and refreshes afterwards', async () => {
    const gate = deferred<RemoteResultLike<{ readonly kind: 'preset'; readonly ok: true; readonly action: 'applied' }>>()
    const remote = fakeRemote({ takeover: vi.fn(() => gate.promise) })
    const store = createStatusStore(remote, new AbortController().signal)
    await store.refresh()
    const running = store.takeover()
    expect(store.getSnapshot().pending).toBe('takeover')
    await store.restore()
    await store.setLevel(5)
    store.reload()
    expect(remote.restore).not.toHaveBeenCalled()
    expect(remote.setLevel).not.toHaveBeenCalled()
    expect(remote.status).toHaveBeenCalledTimes(1)
    gate.resolve(ok({ kind: 'preset', ok: true, action: 'applied' }))
    await running
    expect(remote.takeover).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
    expect(remote.status).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot()).toEqual({
      phase: 'ready',
      status: wireStatus(),
      refreshing: false,
      notice: { action: 'takeover', result: { kind: 'preset', ok: true, action: 'applied' } },
    })
  })

  it('records setting writes and replaces the previous notice', async () => {
    const remote = fakeRemote({ setMode: vi.fn(async () => ok({ ok: false, message: 'overridden' } as const)) })
    const store = createStatusStore(remote, new AbortController().signal)
    await store.setLevel(4)
    expect(remote.setLevel).toHaveBeenCalledWith(4, expect.any(AbortSignal))
    expect(store.getSnapshot().notice).toEqual({ action: 'level', level: 4, result: { ok: true, via: 'settings' } })
    await store.setMode('engine')
    expect(store.getSnapshot().notice).toEqual({ action: 'mode', mode: 'engine', result: { ok: false, message: 'overridden' } })
  })

  it('turns Remote failures and rejected calls into failure notices', async () => {
    const remote = fakeRemote({
      restore: vi.fn(async () => failed('remote-access/denied', 'access denied')),
      takeover: vi.fn(async () => { throw new Error('client api: Remote method is no longer mounted') }),
    })
    const store = createStatusStore(remote, new AbortController().signal)
    await store.restore()
    expect(store.getSnapshot().notice).toEqual({ action: 'restore', failure: { code: 'remote-access/denied', message: 'access denied' } })
    await store.takeover()
    expect(store.getSnapshot().notice).toEqual({ action: 'takeover', failure: { code: 'client/error', message: 'client api: Remote method is no longer mounted' } })
    expect(store.getSnapshot().pending).toBeUndefined()
  })

  it('publishes nothing once its lifetime ends', async () => {
    const lifetime = new AbortController()
    const gate = deferred<RemoteResultLike<MemoryCloudStatus>>()
    const store = createStatusStore(fakeRemote({ status: vi.fn(() => gate.promise) }), lifetime.signal)
    const reading = store.refresh()
    const seen = record(store)
    lifetime.abort()
    gate.resolve(ok(wireStatus()))
    await reading
    await store.takeover()
    expect(seen).toEqual([])
    expect(store.getSnapshot().phase).toBe('loading')
  })
})
