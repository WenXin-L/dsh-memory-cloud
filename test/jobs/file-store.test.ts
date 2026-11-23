import { afterEach, describe, expect, it } from 'vitest'
import { OWNER_SCOPE, type EpisodeId, type ScopeId } from '../../src/contracts.ts'
import { createFileMemoryStore } from '../../src/store/index.ts'
import { createJobRunner, type JobRunner, type JobRunnerState } from '../../src/summarize/jobs/index.ts'
import { at, createLogger, createManualTime, createTempDir } from './helpers.ts'

const scope = OWNER_SCOPE
const T0 = at(2026, 11, 23, 9)

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('job runner on the real file store', () => {
  it('keeps the queue, the quota ledger and failure marks across a restart', async () => {
    const temp = createTempDir()
    cleanups.push(temp.cleanup)
    const time = createManualTime(T0)
    const log = createLogger()
    const calls: string[] = []

    const boot = (summarizeEpisode: (scope: ScopeId, episode: EpisodeId) => Promise<void>) => {
      const store = createFileMemoryStore({ root: temp.dir, clock: time.clock })
      const runner: JobRunner = createJobRunner({
        store,
        clock: time.clock,
        timers: time.timers,
        logger: log.logger,
        summarizeEpisode: (target, episode) => {
          calls.push(episode)
          return summarizeEpisode(target, episode)
        },
        buildRollup: async () => {},
        options: { dailyQuota: 1, baseBackoffMs: 30_000 },
      })
      cleanups.push(() => runner.stop())
      return { store, runner }
    }

    const first = boot(async () => {
      throw new Error('model unavailable')
    })
    const opened = await first.store.openEpisode(scope, { sessionId: 'session-a', startedAt: T0 - 60_000, firstSeq: 1 })
    await first.store.sealEpisode(scope, opened.id, { reason: 'idle', endedAt: T0 - 1000, lastSeq: 3, rawTokens: 40 })

    await first.runner.start()
    expect(await first.runner.drain(60_000)).toEqual({ idle: true, queued: 1 })
    expect(calls).toEqual([opened.id])
    const state = (await first.store.readState()) as JobRunnerState
    expect(state.quota).toEqual({ day: '2026-11-23', used: 1 })
    expect(state.queue).toEqual([{ kind: 'summarize', scope, episode: opened.id, notBefore: T0 + 30_000, attempts: 1 }])
    const failed = (await first.store.readIndex(scope)).episodes.find(meta => meta.id === opened.id)
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: 'model unavailable' })
    await first.runner.stop()

    time.set(T0 + 60_000)
    const second = boot(async () => {})
    await second.runner.start()
    expect(await second.runner.drain(60_000)).toEqual({ idle: true, queued: 1 })
    expect(calls).toEqual([opened.id])
    expect(second.runner.stats().quota).toEqual({ day: '2026-11-23', used: 1, limit: 1 })
  })
})
