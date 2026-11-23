import { afterEach, describe, expect, it } from 'vitest'
import { OWNER_SCOPE, type EpisodeId, type EpisodeMeta, type QueuedJob, type RollupPeriod, type ScopeId } from '../../src/contracts.ts'
import { EMPTY_EPISODE_ERROR } from '../../src/runtime/sources.ts'
import {
  createJobRunner,
  JobCancelledError,
  JobDeferredError,
  JobTimeoutError,
  startOfNextLocalDay,
  type JobRunner,
  type JobRunnerDeps,
  type JobRunnerOptions,
  type JobRunnerState,
  type LeasedJob,
} from '../../src/summarize/jobs/index.ts'
import { at, createLogger, createManualTime, createTempDir, createTestStore, deferred, episode, index, type StoreFailures } from './helpers.ts'

const scope = OWNER_SCOPE
const T0 = at(2026, 11, 23, 9)
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const id = (value: string) => value as EpisodeId
const week = (key: string): RollupPeriod => ({ kind: 'week', key })

type Behavior = (signal: AbortSignal) => Promise<void>

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const failing = (message = 'boom'): Behavior => async () => {
  throw new Error(message)
}
const hanging: Behavior = () => new Promise(() => {})

function createHarness(options: JobRunnerOptions = {}, extra: Pick<Partial<JobRunnerDeps>, 'rollupPlanner'> = {}) {
  const temp = createTempDir()
  cleanups.push(temp.cleanup)
  const time = createManualTime(T0)
  const log = createLogger()
  const calls: string[] = []
  const signals = new Map<string, AbortSignal>()
  const behaviors = new Map<string, Behavior>()
  const failures: StoreFailures = { readState: 0, updateState: 0 }
  const db = createTestStore(temp.dir)

  function boot(): JobRunner {
    const store = createTestStore(temp.dir, failures).store
    const runner = createJobRunner({
      store,
      clock: time.clock,
      timers: time.timers,
      logger: log.logger,
      summarizeEpisode: (target: ScopeId, episodeId: EpisodeId, signal: AbortSignal) => {
        calls.push(episodeId)
        signals.set(episodeId, signal)
        const behavior = behaviors.get(episodeId)
        if (behavior) return behavior(signal)
        return store.updateEpisode(target, episodeId, { status: 'summarized' }).then(() => undefined, () => undefined)
      },
      buildRollup: (_target, period, signal) => {
        calls.push(period.key)
        signals.set(period.key, signal)
        return behaviors.get(period.key)?.(signal) ?? Promise.resolve()
      },
      options: { breakerThreshold: 100, ...options },
      ...extra,
    })
    cleanups.push(() => runner.stop())
    return runner
  }

  const seed = (episodes: readonly EpisodeMeta[]) => db.writeIndex(scope, index(scope, episodes))
  const queue = (): readonly QueuedJob[] => db.state().queue
  const job = (key: string) => queue().find(entry => (entry.kind === 'summarize' ? entry.episode : entry.period.key) === key)
  const meta = (key: string) => db.readIndex(scope).episodes.find(entry => entry.id === key)

  return { time, log, calls, signals, behaviors, failures, db, boot, seed, queue, job, meta }
}

describe('createJobRunner', () => {
  it('runs queued jobs, summaries before rollups, and removes them from the queue', async () => {
    const h = createHarness()
    h.seed([episode(scope, 'e1', { status: 'sealed' }), episode(scope, 'e2', { status: 'sealed' })])
    const runner = h.boot()
    await runner.enqueueRollup(scope, week('2026-W45'))
    await runner.enqueueSummarize(scope, id('e1'))
    await runner.enqueueSummarize(scope, id('e2'))
    expect(h.calls).toEqual([])

    await runner.start()
    await h.time.flush()

    expect(h.calls).toEqual(['e1', 'e2', '2026-W45'])
    expect(h.queue()).toEqual([])
    expect(h.meta('e1')?.status).toBe('summarized')
    expect(runner.stats()).toMatchObject({ started: true, queue: [], totals: { succeeded: 3, failed: 0 } })
  })

  it('runs one job at a time', async () => {
    const h = createHarness()
    const first = deferred()
    h.behaviors.set('e1', () => first.promise)
    const runner = h.boot()
    await runner.start()
    await runner.enqueueSummarize(scope, id('e1'))
    await runner.enqueueSummarize(scope, id('e2'))
    await h.time.flush()

    expect(h.calls).toEqual(['e1'])
    expect(runner.stats().running?.job).toMatchObject({ kind: 'summarize', episode: 'e1' })
    first.resolve()
    await h.time.flush()
    expect(h.calls).toEqual(['e1', 'e2'])
    expect(runner.stats().running).toBeUndefined()
  })

  it('dedupes summaries by episode and rollups by period, including while running', async () => {
    const h = createHarness()
    const gate = deferred()
    h.behaviors.set('e1', () => gate.promise)
    const runner = h.boot()

    expect(await runner.enqueueSummarize(scope, id('e1'))).toBe(true)
    expect(await runner.enqueueSummarize(scope, id('e1'))).toBe(false)
    expect(await runner.enqueueRollup(scope, week('2026-W45'))).toBe(true)
    expect(await runner.enqueueRollup(scope, { kind: 'week', key: '2026-W45' })).toBe(false)
    expect(await runner.enqueueRollup(scope, { kind: 'month', key: '2026-11' })).toBe(true)
    expect(await runner.enqueueSummarize('qq-group-1' as ScopeId, id('e1'))).toBe(true)
    expect(h.queue()).toHaveLength(4)

    await runner.start()
    await h.time.flush()
    expect(h.calls).toEqual(['e1'])
    expect(await runner.enqueueSummarize(scope, id('e1'))).toBe(false)
    gate.resolve()
    await h.time.flush()
    expect(h.calls).toEqual(['e1', 'e1', '2026-W45', '2026-11'])
    expect(h.queue()).toEqual([])
  })

  it('backs off exponentially, marks the episode failed, and gives up after maxAttempts', async () => {
    const h = createHarness({ maxAttempts: 4, baseBackoffMs: 30 * SECOND, maxBackoffMs: MINUTE })
    h.seed([episode(scope, 'e1', { status: 'sealed' })])
    h.behaviors.set('e1', failing('provider said no'))
    const runner = h.boot()
    await runner.enqueueSummarize(scope, id('e1'))
    await runner.start()
    await h.time.flush()

    expect(h.calls).toHaveLength(1)
    expect(h.job('e1')).toMatchObject({ attempts: 1, notBefore: T0 + 30 * SECOND })
    expect(h.meta('e1')).toMatchObject({ status: 'failed', attempts: 1, lastError: 'provider said no' })
    expect(runner.stats().nextWakeAt).toBe(T0 + 30 * SECOND)

    await h.time.advance(29 * SECOND)
    expect(h.calls).toHaveLength(1)
    await h.time.advance(SECOND)
    expect(h.calls).toHaveLength(2)
    expect(h.job('e1')).toMatchObject({ attempts: 2, notBefore: T0 + 30 * SECOND + MINUTE })

    await h.time.advance(MINUTE)
    expect(h.calls).toHaveLength(3)
    expect(h.job('e1')).toMatchObject({ attempts: 3, notBefore: T0 + 30 * SECOND + 2 * MINUTE })

    await h.time.advance(MINUTE)
    expect(h.calls).toHaveLength(4)
    expect(h.queue()).toEqual([])
    expect(h.meta('e1')).toMatchObject({ status: 'failed', attempts: 4, lastError: 'provider said no' })
    expect(h.log.warnings().some(line => line.includes('giving up'))).toBe(true)

    await h.time.advance(60 * MINUTE)
    expect(h.calls).toHaveLength(4)
    expect(runner.stats()).toMatchObject({ totals: { failed: 4 }, lastError: { job: 'summarize:owner:e1', message: 'provider said no' } })
  })

  it('re-queues a deferred job unchanged without counting an attempt or a failure', async () => {
    const h = createHarness({ maxAttempts: 2, baseBackoffMs: 30 * SECOND, breakerThreshold: 1 })
    h.seed([episode(scope, 'e1', { status: 'sealed' }), episode(scope, 'e2', { status: 'sealed' })])
    h.behaviors.set('e1', async () => {
      throw new JobDeferredError('host is shutting down')
    })
    h.behaviors.set('e2', async () => {
      throw new JobDeferredError('no route yet', { retryAfterMs: 5 * SECOND })
    })
    const runner = h.boot()
    await runner.enqueueSummarize(scope, id('e1'))
    await runner.enqueueSummarize(scope, id('e2'))
    await runner.start()
    await h.time.flush()

    expect(h.calls).toEqual(['e1', 'e2'])
    expect(h.job('e1')).toEqual({ kind: 'summarize', scope, episode: 'e1', notBefore: T0 + 30 * SECOND, attempts: 0 })
    expect(h.job('e2')).toEqual({ kind: 'summarize', scope, episode: 'e2', notBefore: T0 + 5 * SECOND, attempts: 0 })
    expect(h.meta('e1')?.status).toBe('sealed')
    expect(runner.stats()).toMatchObject({ breaker: { open: false, consecutiveFailures: 0 }, totals: { deferred: 2, failed: 0 } })
    expect(h.log.warnings()).toEqual([])

    h.behaviors.delete('e1')
    h.behaviors.delete('e2')
    await h.time.advance(30 * SECOND)
    expect(h.calls).toEqual(['e1', 'e2', 'e2', 'e1'])
    expect(h.queue()).toEqual([])
    expect(h.meta('e1')?.status).toBe('summarized')
  })

  it('times out a hung job, aborts its signal, and moves on', async () => {
    const h = createHarness({ jobTimeoutMs: 10 * SECOND })
    h.seed([episode(scope, 'e1', { status: 'sealed' }), episode(scope, 'e2', { status: 'sealed' })])
    h.behaviors.set('e1', hanging)
    const runner = h.boot()
    await runner.enqueueSummarize(scope, id('e1'))
    await runner.enqueueSummarize(scope, id('e2'))
    await runner.start()
    await h.time.flush()
    expect(h.calls).toEqual(['e1'])

    await h.time.advance(10 * SECOND)
    const signal = h.signals.get('e1')
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBeInstanceOf(JobTimeoutError)
    expect(h.calls).toEqual(['e1', 'e2'])
    expect(h.job('e1')).toMatchObject({ attempts: 1, notBefore: T0 + 10 * SECOND + 30 * SECOND })
    expect(h.meta('e1')).toMatchObject({ status: 'failed', attempts: 1, lastError: 'timed out after 10000 ms' })
    expect(runner.stats().totals).toMatchObject({ timedOut: 1, failed: 1, succeeded: 1 })
  })

  it('opens the circuit breaker after consecutive failures and closes it after a successful trial', async () => {
    const h = createHarness({ breakerThreshold: 3, breakerCooldownMs: 10 * MINUTE, baseBackoffMs: SECOND, maxAttempts: 10 })
    let healthy = false
    for (const key of ['e1', 'e2', 'e3', 'e4']) {
      h.behaviors.set(key, async () => {
        if (!healthy) throw new Error('provider down')
      })
    }
    const runner = h.boot()
    for (const key of ['e1', 'e2', 'e3', 'e4']) await runner.enqueueSummarize(scope, id(key))
    await runner.start()
    await h.time.flush()

    expect(h.calls).toEqual(['e1', 'e2', 'e3'])
    expect(runner.stats().breaker).toEqual({ open: true, consecutiveFailures: 3, until: T0 + 10 * MINUTE })
    expect(runner.stats().nextWakeAt).toBe(T0 + 10 * MINUTE)

    await h.time.advance(10 * MINUTE - SECOND)
    expect(h.calls).toHaveLength(3)

    await h.time.advance(SECOND)
    expect(h.calls).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(runner.stats().breaker).toEqual({ open: true, consecutiveFailures: 4, until: T0 + 20 * MINUTE })

    healthy = true
    await h.time.advance(10 * MINUTE)
    expect(h.calls.slice(4).sort()).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(runner.stats().breaker).toEqual({ open: false, consecutiveFailures: 0 })
    expect(h.queue()).toEqual([])
  })

  it('persists the daily quota so a restart does not reset it', async () => {
    const h = createHarness({ dailyQuota: 2 })
    const first = h.boot()
    for (const key of ['e1', 'e2', 'e3']) await first.enqueueSummarize(scope, id(key))
    await first.start()
    await h.time.flush()

    expect(h.calls).toEqual(['e1', 'e2'])
    expect(first.stats().quota).toEqual({ day: '2026-11-23', used: 2, limit: 2 })
    expect((h.db.state() as JobRunnerState).quota).toEqual({ day: '2026-11-23', used: 2 })
    expect(h.log.lines.some(line => line.level === 'info' && line.text.includes('quota'))).toBe(true)
    await first.stop()

    await h.time.advance(2 * HOUR)
    const second = h.boot()
    await second.start()
    await h.time.flush()
    expect(h.calls).toEqual(['e1', 'e2'])
    expect(second.stats().quota.used).toBe(2)
    expect(second.stats().nextWakeAt).toBe(startOfNextLocalDay(T0))

    await h.time.advance(startOfNextLocalDay(T0) - h.time.clock.now())
    expect(h.calls).toEqual(['e1', 'e2', 'e3'])
    expect(second.stats().quota).toEqual({ day: '2026-11-24', used: 1, limit: 2 })
  })

  it('drains the running job and every due job, and gives up at the timeout', async () => {
    const h = createHarness({ jobTimeoutMs: 10 * MINUTE })
    const gate = deferred()
    h.behaviors.set('e1', () => gate.promise)
    const runner = h.boot()
    await runner.enqueueSummarize(scope, id('e1'))
    await runner.enqueueSummarize(scope, id('e2'))
    await runner.start()
    await h.time.flush()

    const drained = runner.drain(MINUTE)
    gate.resolve()
    await h.time.flush()
    await expect(drained).resolves.toEqual({ idle: true, queued: 0 })
    expect(h.calls).toEqual(['e1', 'e2'])

    h.behaviors.set('e3', hanging)
    await runner.enqueueSummarize(scope, id('e3'))
    await h.time.flush()
    expect(await runner.drain(0)).toEqual({ idle: false, queued: 1 })
    const timedOut = runner.drain(5 * SECOND)
    await h.time.advance(5 * SECOND)
    await expect(timedOut).resolves.toEqual({ idle: false, queued: 1 })
  })

  it('stop aborts the running job and re-queues it unchanged for the next start', async () => {
    const h = createHarness()
    h.seed([episode(scope, 'e1', { status: 'sealed' })])
    h.behaviors.set('e1', signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const first = h.boot()
    await first.enqueueSummarize(scope, id('e1'))
    await first.start()
    await h.time.flush()
    expect(h.job('e1')?.attempts).toBe(1)

    await first.stop()
    expect(h.signals.get('e1')?.reason).toBeInstanceOf(JobCancelledError)
    expect(h.job('e1')).toEqual({ kind: 'summarize', scope, episode: 'e1', notBefore: T0, attempts: 0 })
    expect(h.meta('e1')?.status).toBe('sealed')
    expect(first.stats()).toMatchObject({ stopped: true, totals: { cancelled: 1, failed: 0 } })
    expect(await first.enqueueSummarize(scope, id('e2'))).toBe(true)
    await h.time.flush()
    expect(h.calls).toEqual(['e1'])

    h.behaviors.delete('e1')
    const second = h.boot()
    await second.start()
    await h.time.flush()
    expect(h.calls).toEqual(['e1', 'e1', 'e2'])
    expect(h.meta('e1')?.status).toBe('summarized')
  })

  it('resumes persisted jobs and rescans for sealed and retryable failed episodes', async () => {
    const h = createHarness({ maxAttempts: 3 })
    h.seed([
      episode(scope, 'sealed', { status: 'sealed' }),
      episode(scope, 'retry', { status: 'failed', attempts: 2, lastError: 'x' }),
      episode(scope, 'exhausted', { status: 'failed', attempts: 3, lastError: 'x' }),
      episode(scope, 'done', { status: 'summarized' }),
      episode(scope, 'open', { status: 'open' }),
    ])
    h.db.writeState({ version: 1, lastSeq: { s: 4 }, queue: [{ kind: 'rollup', scope, period: week('2026-W44'), notBefore: T0 - MINUTE, attempts: 1 }] })
    const runner = h.boot()
    await runner.start()
    await h.time.flush()

    expect(h.calls.slice(0, 2).sort()).toEqual(['retry', 'sealed'])
    expect(h.calls.slice(2)).toEqual(['2026-W44'])
    expect(h.db.state().lastSeq).toEqual({ s: 4 })

    expect(await runner.rescan()).toBe(0)
    expect(await runner.rescan({ retryExhausted: true })).toBe(1)
    await h.time.flush()
    expect(h.calls.at(-1)).toBe('exhausted')
    expect(h.meta('exhausted')?.status).toBe('summarized')
  })

  it('never re-queues empty episodes, even with retryExhausted', async () => {
    const h = createHarness({ maxAttempts: 3 })
    h.seed([
      episode(scope, 'empty', { status: 'failed', attempts: 3, lastError: `${EMPTY_EPISODE_ERROR}: no conversation content` }),
      episode(scope, 'empty-early', { status: 'failed', attempts: 1, lastError: `${EMPTY_EPISODE_ERROR}: no conversation content` }),
      episode(scope, 'exhausted', { status: 'failed', attempts: 3, lastError: 'x' }),
    ])
    const runner = h.boot()
    await runner.start()
    await h.time.flush()
    expect(h.calls).toEqual([])

    expect(await runner.rescan({ retryExhausted: true })).toBe(1)
    await h.time.flush()
    expect(h.calls).toEqual(['exhausted'])
    expect(runner.stats().quota.used).toBe(1)
    expect(h.meta('empty')).toMatchObject({ status: 'failed', attempts: 3 })
  })

  it('leases a running job so another runner sharing the store skips it', async () => {
    const h = createHarness({ jobTimeoutMs: 2 * MINUTE, leaseGraceMs: MINUTE })
    const gate = deferred()
    h.behaviors.set('e1', () => gate.promise)
    const first = h.boot()
    await first.enqueueSummarize(scope, id('e1'))
    await first.start()
    await h.time.flush()
    expect(h.job('e1')).toMatchObject({ attempts: 1, notBefore: T0 + 3 * MINUTE })

    const second = h.boot()
    await second.start()
    await h.time.flush()
    expect(h.calls).toEqual(['e1'])
    expect(second.stats().nextWakeAt).toBe(T0 + 3 * MINUTE)

    gate.resolve()
    await h.time.flush()
    expect(h.queue()).toEqual([])
    await h.time.advance(3 * MINUTE)
    expect(h.calls).toEqual(['e1'])
  })

  it('kick({ force: true }) does not take over a job another runner is running', async () => {
    const h = createHarness({ jobTimeoutMs: 2 * MINUTE, leaseGraceMs: MINUTE })
    const gate = deferred()
    h.behaviors.set('e1', () => gate.promise)
    const first = h.boot()
    await first.enqueueSummarize(scope, id('e1'))
    await first.start()
    await h.time.flush()
    const lease = h.job('e1') as LeasedJob
    expect(lease).toMatchObject({ attempts: 1, notBefore: T0 + 3 * MINUTE, leasedUntil: T0 + 3 * MINUTE, lease: expect.any(String) })

    const second = h.boot()
    await second.start()
    second.kick({ force: true })
    await h.time.flush()
    expect(h.calls).toEqual(['e1'])
    expect(h.job('e1')).toEqual(lease)
    expect(second.stats().nextWakeAt).toBe(T0 + 3 * MINUTE)

    gate.resolve()
    await h.time.flush()
    expect(h.queue()).toEqual([])
    expect((h.db.state() as JobRunnerState).quota).toEqual({ day: '2026-11-23', used: 1 })
    expect(first.stats().totals.succeeded).toBe(1)
  })

  it('re-claims the lease of a runner that died once the lease expires, even when forced earlier', async () => {
    const h = createHarness({ jobTimeoutMs: 2 * MINUTE, leaseGraceMs: MINUTE })
    h.seed([episode(scope, 'e1', { status: 'sealed' })])
    const dead: LeasedJob = { kind: 'summarize', scope, episode: id('e1'), attempts: 1, notBefore: T0 + MINUTE, lease: 'dead-claim', leasedUntil: T0 + MINUTE }
    h.db.writeState({ version: 1, lastSeq: {}, queue: [dead] })
    const runner = h.boot()
    await runner.start()
    runner.kick({ force: true })
    await h.time.flush()
    expect(h.calls).toEqual([])
    expect(h.job('e1')).toEqual(dead)

    await h.time.advance(MINUTE)
    expect(h.calls).toEqual(['e1'])
    expect(h.queue()).toEqual([])
    expect(h.meta('e1')?.status).toBe('summarized')
  })

  it('keeps a quota refund made by another runner sharing the store', async () => {
    const h = createHarness({ baseBackoffMs: 30 * SECOND })
    const gate = deferred()
    h.behaviors.set('e1', async () => {
      await gate.promise
      throw new JobDeferredError('host busy')
    })
    const first = h.boot()
    await first.enqueueSummarize(scope, id('e1'))
    await first.start()
    await h.time.flush()

    const second = h.boot()
    await second.start()
    await second.enqueueSummarize(scope, id('e2'))
    await h.time.flush()
    expect(h.calls).toEqual(['e1', 'e2'])
    expect(second.stats().quota.used).toBe(2)

    gate.resolve()
    await h.time.flush()
    expect((h.db.state() as JobRunnerState).quota).toEqual({ day: '2026-11-23', used: 1 })

    await second.enqueueSummarize(scope, id('e3'))
    await h.time.flush()
    expect(h.calls).toEqual(['e1', 'e2', 'e3'])
    expect((h.db.state() as JobRunnerState).quota).toEqual({ day: '2026-11-23', used: 2 })
    expect(second.stats().quota.used).toBe(2)
  })

  it('queues planned rollups after a success without looping on a rollup that writes nothing', async () => {
    const plannerCalls: string[] = []
    const h = createHarness({}, {
      rollupPlanner: (target, current) => {
        plannerCalls.push(`${target}:${current.episodes.length}`)
        return [{ period: week('2026-W45') }]
      },
    })
    h.seed([episode(scope, 'e1', { status: 'sealed' })])
    const runner = h.boot()
    await runner.start()
    await h.time.flush()

    expect(h.calls).toEqual(['e1', '2026-W45'])
    expect(plannerCalls.length).toBeGreaterThanOrEqual(3)
    expect(h.queue()).toEqual([])
    expect(h.log.lines.some(line => line.text.includes('already built'))).toBe(true)
    expect(await runner.enqueueRollup(scope, week('2026-W45'))).toBe(true)
  })

  it('plans rollups after a later success when the planner had nothing at start-up', async () => {
    let ready = false
    const h = createHarness({}, { rollupPlanner: () => (ready ? [{ period: week('2026-W45') }] : []) })
    h.seed([episode(scope, 'e1', { status: 'sealed' })])
    h.behaviors.set('e1', async () => {
      ready = true
    })
    const runner = h.boot()
    await runner.start()
    await h.time.flush()
    expect(h.calls).toEqual(['e1', '2026-W45'])
    expect(h.queue()).toEqual([])
  })

  it('stops planning a rollup that used up its attempts until rescan({ retryExhausted: true })', async () => {
    const h = createHarness({ maxAttempts: 2, baseBackoffMs: SECOND, maxBackoffMs: SECOND }, {
      rollupPlanner: () => [{ period: week('2026-W40') }],
    })
    const gaveUp = () => (h.db.state() as JobRunnerState).exhaustedRollups
    const rollupCalls = () => h.calls.filter(call => call === '2026-W40').length
    h.seed([episode(scope, 'e1', { status: 'sealed' })])
    h.behaviors.set('2026-W40', failing('rollup timed out'))
    const first = h.boot()
    await first.start()
    await h.time.advance(SECOND)
    expect(rollupCalls()).toBe(2)
    expect(h.queue()).toEqual([])
    expect(gaveUp()).toEqual(['rollup:owner:week:2026-W40'])

    await first.enqueueSummarize(scope, id('e2'))
    await h.time.advance(MINUTE)
    expect(h.calls).toContain('e2')
    expect(rollupCalls()).toBe(2)
    expect(await first.rescan()).toBe(0)
    await first.stop()

    const second = h.boot()
    await second.start()
    await h.time.advance(MINUTE)
    expect(rollupCalls()).toBe(2)
    expect(await second.enqueueRollup(scope, week('2026-W41'))).toBe(true)

    expect(await second.rescan({ retryExhausted: true })).toBe(1)
    expect(gaveUp()).toBeUndefined()
    await h.time.advance(SECOND)
    expect(rollupCalls()).toBe(4)
    expect(gaveUp()).toEqual(['rollup:owner:week:2026-W40'])
  })

  it('kick({ force: true }) skips backoff and closes the breaker', async () => {
    const h = createHarness({ breakerThreshold: 1, breakerCooldownMs: 60 * MINUTE })
    let attempts = 0
    h.behaviors.set('e1', async () => {
      attempts += 1
      if (attempts === 1) throw new Error('flaky')
    })
    const runner = h.boot()
    await runner.enqueueSummarize(scope, id('e1'))
    await runner.start()
    await h.time.flush()
    expect(runner.stats().breaker.open).toBe(true)

    runner.kick({ force: true })
    await h.time.flush()
    expect(h.calls).toEqual(['e1', 'e1'])
    expect(h.queue()).toEqual([])
    expect(runner.stats().breaker.open).toBe(false)
  })

  it('survives store and callback failures without unhandled rejections', async () => {
    const h = createHarness({ baseBackoffMs: 30 * SECOND })
    h.behaviors.set('sync', (() => {
      throw new Error('thrown synchronously')
    }) as Behavior)
    const runner = h.boot()
    h.failures.updateState = 1
    expect(await runner.enqueueSummarize(scope, id('lost'))).toBe(false)
    expect(h.log.warnings().some(line => line.includes('could not queue 1 job(s): state.json locked'))).toBe(true)
    await runner.enqueueSummarize(scope, id('sync'))
    await runner.enqueueSummarize(scope, id('e1'))

    h.failures.readState = 1
    await runner.start()
    await h.time.flush()
    expect(h.calls).toEqual([])
    expect(h.log.warnings().some(line => line.includes('state.json unreadable'))).toBe(true)
    expect(runner.stats().nextWakeAt).toBe(T0 + 30 * SECOND)

    await h.time.advance(30 * SECOND)
    expect(h.calls).toEqual(['sync', 'e1'])
    expect(h.job('sync')).toMatchObject({ attempts: 1 })
    expect(runner.stats().lastError?.message).toBe('thrown synchronously')
  })
})

describe('job settlement', () => {
  it('refunds the daily quota for deferred and cancelled jobs', async () => {
    const h = createHarness({ dailyQuota: 1, baseBackoffMs: 30 * SECOND })
    h.seed([episode(scope, 'e1', { status: 'sealed' })])
    h.behaviors.set('e1', async () => {
      throw new JobDeferredError('host busy')
    })
    const runner = h.boot()
    await runner.enqueueSummarize(scope, id('e1'))
    await runner.start()
    await h.time.flush()
    expect(h.calls).toEqual(['e1'])
    expect((h.db.state() as JobRunnerState).quota).toEqual({ day: '2026-11-23', used: 0 })
    expect(runner.stats().quota.used).toBe(0)

    h.behaviors.set('e2', signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    await runner.enqueueSummarize(scope, id('e2'))
    await h.time.flush()
    expect(h.calls).toEqual(['e1', 'e2'])
    await runner.stop()
    expect((h.db.state() as JobRunnerState).quota).toEqual({ day: '2026-11-23', used: 0 })

    h.behaviors.clear()
    const second = h.boot()
    await second.start()
    await h.time.advance(30 * SECOND)
    expect(h.calls).toEqual(['e1', 'e2', 'e2'])
    expect(second.stats().quota.used).toBe(1)
  })

  it('leaves a lease that another process re-claimed in the queue', async () => {
    const h = createHarness({ jobTimeoutMs: 2 * MINUTE, leaseGraceMs: MINUTE })
    const gate = deferred()
    h.behaviors.set('e1', () => gate.promise)
    const runner = h.boot()
    await runner.enqueueSummarize(scope, id('e1'))
    await runner.start()
    await h.time.flush()
    const foreign: QueuedJob = { kind: 'summarize', scope, episode: id('e1'), attempts: 2, notBefore: T0 + 10 * MINUTE }
    h.db.writeState({ ...h.db.state(), queue: [foreign] })

    gate.resolve()
    await h.time.flush()
    expect(h.queue()).toEqual([foreign])
  })

  it('does not mark an episode failed that another process summarized meanwhile', async () => {
    const h = createHarness({ baseBackoffMs: 30 * SECOND })
    h.seed([episode(scope, 'e1', { status: 'sealed' })])
    h.behaviors.set('e1', async () => {
      h.seed([episode(scope, 'e1', { status: 'summarized' })])
      throw new Error('late failure')
    })
    const runner = h.boot()
    await runner.enqueueSummarize(scope, id('e1'))
    await runner.start()
    await h.time.flush()
    expect(h.calls).toEqual(['e1'])
    expect(h.meta('e1')).toMatchObject({ status: 'summarized' })
    expect(h.meta('e1')?.lastError).toBeUndefined()
  })
})
