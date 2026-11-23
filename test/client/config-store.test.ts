import { describe, expect, it, vi } from 'vitest'
import { createConfigStore } from '../../src/client/config-store.ts'
import type { ConfigSnapshot } from '../../src/client/config-store.ts'
import type { ConfigView } from '../../src/client/contract.ts'
import type { MemoryCloudRemoteClient, RemoteResultLike } from '../../src/client/host.ts'
import type { SettingWriteResult } from '../../src/runtime/settings.ts'
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

function record(store: { getSnapshot(): ConfigSnapshot; subscribe(listener: () => void): () => void }): ConfigSnapshot[] {
  const seen: ConfigSnapshot[] = []
  store.subscribe(() => { seen.push(store.getSnapshot()) })
  return seen
}

describe('config store', () => {
  it('loads the live settings and counts successful reads', async () => {
    const remote = fakeRemote()
    const signal = new AbortController().signal
    const store = createConfigStore(remote, signal)
    expect(store.getSnapshot()).toEqual({ phase: 'idle', revision: 0, saving: false })
    const seen = record(store)
    await store.load()
    expect(remote.getConfig).toHaveBeenCalledWith(signal)
    expect(seen.map(snapshot => snapshot.phase)).toEqual(['loading', 'ready'])
    expect(store.getSnapshot()).toEqual({ phase: 'ready', view: configView(), revision: 1, saving: false })
    await store.load()
    expect(store.getSnapshot().revision).toBe(2)
  })

  it('reports read failures and keeps the last settings', async () => {
    const getConfig = vi.fn<MemoryCloudRemoteClient['getConfig']>()
      .mockResolvedValueOnce(failed('gateway/invocation-unavailable', 'no active Remote method exports this endpoint'))
      .mockResolvedValueOnce(ok(configView()))
      .mockRejectedValueOnce(new Error('offline'))
    const store = createConfigStore(fakeRemote({ getConfig }), new AbortController().signal)
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ phase: 'error', revision: 0, failure: { code: 'gateway/invocation-unavailable' } })
    await store.load()
    expect(store.getSnapshot()).toEqual({ phase: 'ready', view: configView(), revision: 1, saving: false })
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', view: configView(), revision: 1, failure: { code: 'client/error', message: 'offline' } })
  })

  it('keeps the newest of overlapping reads', async () => {
    const first = deferred<RemoteResultLike<ConfigView>>()
    const second = deferred<RemoteResultLike<ConfigView>>()
    const getConfig = vi.fn<MemoryCloudRemoteClient['getConfig']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const store = createConfigStore(fakeRemote({ getConfig }), new AbortController().signal)
    const reads = [store.load(), store.load()]
    second.resolve(ok(configView({ idleMinutes: 5 })))
    first.resolve(ok(configView({ idleMinutes: 9 })))
    await Promise.all(reads)
    expect(store.getSnapshot().view?.config.idleMinutes).toBe(5)
  })

  it('saves one patch at a time and re-reads the settings after a successful save', async () => {
    const gate = deferred<RemoteResultLike<SettingWriteResult>>()
    const getConfig = vi.fn(async () => ok(configView({ idleMinutes: 12 })))
    const remote = fakeRemote({ setConfig: vi.fn(() => gate.promise), getConfig })
    const store = createConfigStore(remote, new AbortController().signal)
    const saving = store.save({ idleMinutes: 12 })
    expect(store.getSnapshot().saving).toBe(true)
    await expect(store.save({ idleMinutes: 13 })).resolves.toBe(false)
    expect(remote.setConfig).toHaveBeenCalledTimes(1)
    gate.resolve(ok({ ok: true, via: 'settings' }))
    await expect(saving).resolves.toBe(true)
    expect(remote.setConfig).toHaveBeenCalledWith({ idleMinutes: 12 }, expect.any(AbortSignal))
    expect(getConfig).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toEqual({
      phase: 'ready',
      view: configView({ idleMinutes: 12 }),
      revision: 1,
      saving: false,
      notice: { result: { ok: true, via: 'settings' } },
    })
  })

  it('records rejected and failed saves without re-reading', async () => {
    const setConfig = vi.fn<MemoryCloudRemoteClient['setConfig']>()
      .mockResolvedValueOnce(ok({ ok: false, message: '$.idleMinutes expected number >= 1 but got 0' }))
      .mockResolvedValueOnce(failed('remote-access/denied', 'access denied'))
    const remote = fakeRemote({ setConfig })
    const store = createConfigStore(remote, new AbortController().signal)
    await expect(store.save({ idleMinutes: 0 })).resolves.toBe(false)
    expect(store.getSnapshot().notice).toEqual({ result: { ok: false, message: '$.idleMinutes expected number >= 1 but got 0' } })
    await expect(store.save({ idleMinutes: 2 })).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({ saving: false, notice: { failure: { code: 'remote-access/denied', message: 'access denied' } } })
    expect(remote.getConfig).not.toHaveBeenCalled()
  })

  it('publishes nothing once its lifetime ends', async () => {
    const lifetime = new AbortController()
    const gate = deferred<RemoteResultLike<ConfigView>>()
    const store = createConfigStore(fakeRemote({ getConfig: vi.fn(() => gate.promise) }), lifetime.signal)
    const reading = store.load()
    const seen = record(store)
    lifetime.abort()
    gate.resolve(ok(configView()))
    await reading
    await expect(store.save({ idleMinutes: 3 })).resolves.toBe(false)
    expect(seen).toEqual([])
    expect(store.getSnapshot().phase).toBe('loading')
  })
})
