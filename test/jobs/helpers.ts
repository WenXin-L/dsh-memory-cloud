import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock, EpisodeId, EpisodeMeta, EpisodeMetaPatch, MemoryIndex, Millis, RollupEntry, ScopeId, StoreState } from '../../src/contracts.ts'
import type { JobLogger, JobStore, JobTimers } from '../../src/summarize/jobs/index.ts'

export const at = (year: number, month: number, day: number, hour = 12, minute = 0): Millis =>
  new Date(year, month - 1, day, hour, minute).getTime()

export function createTempDir(): { readonly dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'memory-cloud-jobs-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

interface ManualTimer {
  readonly at: Millis
  readonly order: number
  readonly callback: () => void
}

/** Clock plus timers that only move when the test calls `advance`. */
export function createManualTime(start: Millis) {
  let now = start
  let order = 0
  const pending = new Map<number, ManualTimer>()
  const clock: Clock = { now: () => now }
  const timers: JobTimers = {
    setTimeout(callback, delayMs) {
      order += 1
      pending.set(order, { at: now + Math.max(0, delayMs), order, callback })
      return order
    },
    clearTimeout(handle) {
      pending.delete(handle as number)
    },
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve))
  }

  async function advance(ms: number): Promise<void> {
    const target = now + ms
    await flush()
    for (;;) {
      let next: [number, ManualTimer] | undefined
      for (const entry of pending) {
        const timer = entry[1]
        if (timer.at > target) continue
        if (!next || timer.at < next[1].at || (timer.at === next[1].at && timer.order < next[1].order)) next = entry
      }
      if (!next) break
      pending.delete(next[0])
      now = Math.max(now, next[1].at)
      next[1].callback()
      await flush()
    }
    now = target
    await flush()
  }

  return {
    clock,
    timers,
    flush,
    advance,
    set: (time: Millis) => {
      now = time
    },
    pendingTimers: () => [...pending.values()].map(timer => timer.at).sort((a, b) => a - b),
  }
}

export function episode(scope: ScopeId, id: string, overrides: Partial<EpisodeMeta> = {}): EpisodeMeta {
  const startedAt = overrides.startedAt ?? at(2026, 11, 2)
  return {
    id: id as EpisodeId,
    scope,
    sessionId: 'session-1',
    dir: `episodes/${id}`,
    seqRange: { first: 1, last: 10 },
    startedAt,
    endedAt: startedAt + 30 * 60_000,
    status: 'summarized',
    tokens: { raw: 1000, summary: 200, gist: 50 },
    importance: 5,
    strength: 1,
    pinned: false,
    hidden: false,
    keywords: [],
    ...overrides,
  }
}

export function index(scope: ScopeId, episodes: readonly EpisodeMeta[], rollups: readonly RollupEntry[] = []): MemoryIndex {
  return { version: 1, scope, episodes, rollups, updatedAt: 0 }
}

/**
 * File-backed stand-in for the store's job-related surface. Synchronous fs
 * keeps every operation inside microtasks so manual time stays deterministic;
 * a second instance on the same directory models a process restart.
 */
export interface StoreFailures {
  readState: number
  updateState: number
}

export function createTestStore(dir: string, failures: StoreFailures = { readState: 0, updateState: 0 }) {
  const statePath = join(dir, 'state.json')
  const indexPath = (scope: ScopeId) => join(dir, 'scopes', scope, 'index.json')
  let stateWrites = 0

  const readStateSync = (): StoreState => {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8')) as StoreState
    } catch {
      return { version: 1, lastSeq: {}, queue: [] }
    }
  }
  const readIndexSync = (scope: ScopeId): MemoryIndex => JSON.parse(readFileSync(indexPath(scope), 'utf8')) as MemoryIndex

  const store: JobStore = {
    async listScopes() {
      try {
        return JSON.parse(readFileSync(join(dir, 'scopes.json'), 'utf8')) as ScopeId[]
      } catch {
        return []
      }
    },
    async readIndex(scope) {
      return readIndexSync(scope)
    },
    async readState() {
      if (failures.readState > 0) {
        failures.readState -= 1
        throw new Error('state.json unreadable')
      }
      return readStateSync()
    },
    async updateState(change) {
      if (failures.updateState > 0) {
        failures.updateState -= 1
        throw new Error('state.json locked')
      }
      const next = change(readStateSync())
      writeFileSync(statePath, JSON.stringify(next))
      stateWrites += 1
      return next
    },
    async updateEpisode(scope, id, patch: EpisodeMetaPatch | ((meta: EpisodeMeta) => EpisodeMetaPatch)) {
      const current = readIndexSync(scope)
      const target = current.episodes.find(meta => meta.id === id)
      if (!target) throw new Error(`unknown episode ${id}`)
      const updated = { ...target, ...typeof patch === 'function' ? patch(target) : patch } as EpisodeMeta
      writeIndex(scope, { ...current, episodes: current.episodes.map(meta => (meta.id === id ? updated : meta)) })
      return updated
    },
  }

  function writeIndex(scope: ScopeId, value: MemoryIndex): void {
    mkdirSync(join(dir, 'scopes', scope), { recursive: true })
    writeFileSync(indexPath(scope), JSON.stringify(value))
    const scopes = new Set<string>(JSON.parse((() => {
      try {
        return readFileSync(join(dir, 'scopes.json'), 'utf8')
      } catch {
        return '[]'
      }
    })()) as string[])
    scopes.add(scope)
    writeFileSync(join(dir, 'scopes.json'), JSON.stringify([...scopes]))
  }

  return {
    store,
    failures,
    writeIndex,
    readIndex: readIndexSync,
    state: readStateSync,
    writeState: (state: StoreState) => writeFileSync(statePath, JSON.stringify(state)),
    stateWrites: () => stateWrites,
  }
}

export function createLogger() {
  const lines: { readonly level: 'debug' | 'info' | 'warn'; readonly text: string }[] = []
  const format = (template: string, args: unknown[]) => {
    let i = 0
    return template.replace(/%[sd]/g, () => String(args[i++]))
  }
  const logger: JobLogger = {
    debug: (template, ...args) => void lines.push({ level: 'debug', text: format(template, args) }),
    info: (template, ...args) => void lines.push({ level: 'info', text: format(template, args) }),
    warn: (template, ...args) => void lines.push({ level: 'warn', text: format(template, args) }),
  }
  return { logger, lines, warnings: () => lines.filter(line => line.level === 'warn').map(line => line.text) }
}

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
