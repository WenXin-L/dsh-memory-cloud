import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach } from 'vitest'
import type { EpisodeSummaryResult, RawEventRecord, SummaryProvenance } from '../../src/contracts.ts'
import { createFileMemoryStore } from '../../src/store/index.ts'
import type { FileMemoryStore, FileMemoryStoreOptions } from '../../src/store/index.ts'

export const BASE_TIME = Date.UTC(2026, 10, 20, 21, 30)

export interface FakeClock {
  now(): number
  advance(ms: number): void
}

export function fakeClock(start = Date.UTC(2026, 10, 23, 8, 0)): FakeClock {
  let now = start
  return {
    now: () => now,
    advance(ms) {
      now += ms
    },
  }
}

/** Fresh temp roots, removed after each test. */
export function useTempRoots(): () => Promise<string> {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })
  return async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-cloud-store-'))
    roots.push(root)
    return root
  }
}

export function makeStore(root: string, clock: FakeClock, extra: Partial<FileMemoryStoreOptions> = {}): FileMemoryStore {
  return createFileMemoryStore({ root, clock, timeZone: 'UTC', ...extra })
}

export function rawRecord(seq: number, data: unknown = { text: `message ${seq}` }): RawEventRecord {
  return { seq, time: BASE_TIME + seq * 1000, type: 'user/message', data }
}

export function records(first: number, last: number): RawEventRecord[] {
  return Array.from({ length: last - first + 1 }, (_, offset) => rawRecord(first + offset))
}

export function summaryResult(overrides: Partial<EpisodeSummaryResult> = {}): EpisodeSummaryResult {
  return {
    gist: '和小明聊了咖啡。',
    summary: '小明说他每天早上喝一杯手冲咖啡，不喜欢加糖。\n约好周末一起去新开的咖啡馆。',
    ongoing: ['周末去咖啡馆'],
    importance: 7,
    keywords: ['咖啡', '周末'],
    people: ['小明'],
    dates: [{ date: '2026-11-28', what: '去咖啡馆' }],
    promises: [{ what: '周末一起去咖啡馆', who: 'user', due: '2026-11-28' }],
    ...overrides,
  }
}

export function provenance(summarizedAt = Date.UTC(2026, 10, 21, 1, 0)): SummaryProvenance {
  return { provider: 'deepseek', model: 'deepseek-flash', promptVersion: 'companion-v1', summarizedAt }
}

/** Every file under `dir`, relative and sorted. */
export async function listTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)))
    .sort()
}
