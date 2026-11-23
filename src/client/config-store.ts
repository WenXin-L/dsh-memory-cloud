import type { SettingWriteResult } from '../runtime/settings.ts'
import type { ConfigPatch, ConfigView } from './contract.ts'
import type { HostObservable, MemoryCloudRemoteClient, RemoteFailureLike } from './host.ts'
import { settle } from './store.ts'

/** Outcome of the last save, kept until the next one starts. */
export type ConfigNotice =
  | { readonly result: SettingWriteResult }
  | { readonly failure: RemoteFailureLike }

export interface ConfigSnapshot {
  /** `idle` before the first read; `error` only while no settings have ever loaded. */
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly view?: ConfigView
  /** Counts successful reads, so the page can re-seed its form after each one. */
  readonly revision: number
  /** Failure of the latest read. */
  readonly failure?: RemoteFailureLike
  readonly saving: boolean
  readonly notice?: ConfigNotice
}

export interface ConfigStore extends HostObservable<ConfigSnapshot> {
  /** Read the live settings; overlapping reads resolve with the newest one. */
  load(): Promise<void>
  /** Write `patch`, then read the settings again; resolves whether the host saved it. */
  save(patch: ConfigPatch): Promise<boolean>
}

/**
 * Live settings of the Advanced section over `ctx.remote.memoryCloud`. One
 * save runs at a time. Nothing is published after `signal` aborts.
 */
export function createConfigStore(remote: MemoryCloudRemoteClient, signal: AbortSignal): ConfigStore {
  let snapshot: ConfigSnapshot = { phase: 'idle', revision: 0, saving: false }
  const listeners = new Set<() => void>()
  let reads = 0

  const publish = (next: Partial<ConfigSnapshot>, drop: readonly (keyof ConfigSnapshot)[] = []): void => {
    if (signal.aborted) return
    const merged: Record<string, unknown> = { ...snapshot, ...next }
    for (const key of drop) delete merged[key]
    snapshot = merged as unknown as ConfigSnapshot
    for (const listener of [...listeners]) listener()
  }

  const load = async (): Promise<void> => {
    const read = ++reads
    if (snapshot.view === undefined) publish({ phase: 'loading' })
    const result = await settle(() => remote.getConfig(signal))
    if (read !== reads) return
    if (result.ok) publish({ phase: 'ready', view: result.value, revision: snapshot.revision + 1 }, ['failure'])
    else publish({ phase: snapshot.view === undefined ? 'error' : 'ready', failure: result.error })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load,
    async save(patch) {
      if (snapshot.saving || signal.aborted) return false
      publish({ saving: true }, ['notice'])
      const result = await settle(() => remote.setConfig(patch, signal))
      publish({ notice: result.ok ? { result: result.value } : { failure: result.error } })
      const saved = result.ok && result.value.ok
      if (saved) await load()
      publish({ saving: false })
      return saved
    },
  }
}
