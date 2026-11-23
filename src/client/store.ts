import type { CompactionMode, CompressionLevel } from '../contracts.ts'
import type { SettingWriteResult } from '../runtime/settings.ts'
import type { MemoryCloudStatus, TakeoverActionResult } from '../runtime/status.ts'
import type { HostObservable, MemoryCloudRemoteClient, RemoteFailureLike, RemoteResultLike } from './host.ts'

export type StatusAction = 'takeover' | 'restore' | 'level' | 'mode'

/** Outcome of the last user action, kept until the next one starts. */
export type ActionNotice =
  | { readonly action: 'takeover' | 'restore'; readonly result: TakeoverActionResult }
  | { readonly action: 'level'; readonly level: CompressionLevel; readonly result: SettingWriteResult }
  | { readonly action: 'mode'; readonly mode: CompactionMode; readonly result: SettingWriteResult }
  | { readonly action: StatusAction; readonly failure: RemoteFailureLike }

export interface StatusSnapshot {
  /** `idle` before the first read; `error` only while no status has ever loaded. */
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly status?: MemoryCloudStatus
  /** Failure of the latest status read. */
  readonly failure?: RemoteFailureLike
  readonly refreshing: boolean
  readonly pending?: StatusAction
  readonly notice?: ActionNotice
}

export interface StatusStore extends HostObservable<StatusSnapshot> {
  /** Read the status; overlapping reads resolve with the newest one. */
  refresh(): Promise<void>
  /** Refresh unless an action is pending (its own refresh follows). */
  reload(): void
  takeover(): Promise<void>
  restore(): Promise<void>
  setLevel(level: CompressionLevel): Promise<void>
  setMode(mode: CompactionMode): Promise<void>
}

const CLIENT_ERROR = 'client/error'

/** Await a Remote call, turning a rejection into a `client/error` failure. */
export async function settle<T>(call: () => Promise<RemoteResultLike<T>>): Promise<RemoteResultLike<T>> {
  try {
    return await call()
  } catch (error) {
    return { ok: false, error: { code: CLIENT_ERROR, message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Status and actions of the settings page over `ctx.remote.memoryCloud`. One
 * action runs at a time; each is followed by a status read. Nothing is
 * published after `signal` aborts.
 */
export function createStatusStore(remote: MemoryCloudRemoteClient, signal: AbortSignal): StatusStore {
  let snapshot: StatusSnapshot = { phase: 'idle', refreshing: false }
  const listeners = new Set<() => void>()
  let reads = 0

  const publish = (next: Partial<StatusSnapshot>, drop: readonly (keyof StatusSnapshot)[] = []): void => {
    if (signal.aborted) return
    const merged: Record<string, unknown> = { ...snapshot, ...next }
    for (const key of drop) delete merged[key]
    snapshot = merged as unknown as StatusSnapshot
    for (const listener of [...listeners]) listener()
  }

  const refresh = async (): Promise<void> => {
    const read = ++reads
    publish({ refreshing: true, ...snapshot.status === undefined ? { phase: 'loading' as const } : {} })
    const result = await settle(() => remote.status(undefined, signal))
    if (read !== reads) return
    if (result.ok) publish({ phase: 'ready', status: result.value, refreshing: false }, ['failure'])
    else publish({ phase: snapshot.status === undefined ? 'error' : 'ready', failure: result.error, refreshing: false })
  }

  const run = async <T>(action: StatusAction, call: () => Promise<RemoteResultLike<T>>, notice: (value: T) => ActionNotice): Promise<void> => {
    if (snapshot.pending !== undefined || signal.aborted) return
    publish({ pending: action }, ['notice'])
    const result = await settle(call)
    publish({ notice: result.ok ? notice(result.value) : { action, failure: result.error } })
    await refresh()
    publish({}, ['pending'])
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh,
    reload() {
      if (snapshot.pending === undefined) void refresh()
    },
    takeover: () => run('takeover', () => remote.takeover(undefined, signal), result => ({ action: 'takeover', result })),
    restore: () => run('restore', () => remote.restore(undefined, signal), result => ({ action: 'restore', result })),
    setLevel: level => run('level', () => remote.setLevel(level, signal), result => ({ action: 'level', level, result })),
    setMode: mode => run('mode', () => remote.setMode(mode, signal), result => ({ action: 'mode', mode, result })),
  }
}
