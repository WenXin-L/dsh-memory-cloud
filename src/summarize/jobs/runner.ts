import type { Clock, EpisodeId, EpisodeMeta, JobQuota, MemoryIndex, MemoryStore, Millis, QueuedJob, RollupPeriod, ScopeId, StoreState } from '../../contracts.ts'
import { localDayKey, periodId, startOfNextLocalDay } from './periods.ts'
import { systemTimers, type JobTimers } from './timers.ts'

/** Printf-style logger; a Cordis `ctx.logger('…')` satisfies it. */
export interface JobLogger {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

export type JobStore = Pick<MemoryStore, 'listScopes' | 'readIndex' | 'readState' | 'updateState' | 'updateEpisode'>

/** Jobs started on one local day, persisted beside the queue so restarts keep counting. */
export type JobQuotaLedger = JobQuota

/** `state.json` as this module writes it, including the quota ledger. */
export type JobRunnerState = StoreState

export interface JobRunnerOptions {
  /** Per-attempt limit; the job's signal is aborted when it elapses. */
  readonly jobTimeoutMs?: number
  /** Extra time on top of the timeout before another process may reclaim a running job. */
  readonly leaseGraceMs?: number
  /** First retry delay; doubles per attempt up to `maxBackoffMs`. */
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
  /** Attempts before a job is dropped and its episode left `failed`. */
  readonly maxAttempts?: number
  /** Consecutive failures (any job) that open the circuit breaker. */
  readonly breakerThreshold?: number
  readonly breakerCooldownMs?: number
  /** Job attempts allowed per local day; `Infinity` disables the quota. */
  readonly dailyQuota?: number
}

export const DEFAULT_JOB_RUNNER_OPTIONS: Readonly<Required<JobRunnerOptions>> = {
  jobTimeoutMs: 5 * 60_000,
  leaseGraceMs: 60_000,
  baseBackoffMs: 30_000,
  maxBackoffMs: 30 * 60_000,
  maxAttempts: 8,
  breakerThreshold: 5,
  breakerCooldownMs: 30 * 60_000,
  dailyQuota: 200,
}

export interface JobRunnerDeps {
  readonly store: JobStore
  /** Must be idempotent: resolve without work when the episode is already summarized or gone. */
  readonly summarizeEpisode: (scope: ScopeId, episode: EpisodeId, signal: AbortSignal) => Promise<void>
  /** Must be idempotent; resolving without writing a rollup stops that period being re-planned this run. */
  readonly buildRollup: (scope: ScopeId, period: RollupPeriod, signal: AbortSignal) => Promise<void>
  readonly clock: Clock
  readonly logger: JobLogger
  readonly timers?: JobTimers
  /** Called on rescan and after every successful job for that scope; returned periods are queued (deduped). */
  readonly rollupPlanner?: (scope: ScopeId, index: MemoryIndex) => readonly { readonly period: RollupPeriod }[]
  readonly options?: JobRunnerOptions
}

export interface KickOptions {
  /** Make every queued job due now and close the circuit breaker (the daily quota still applies). */
  readonly force?: boolean
}

export interface RescanOptions {
  /** Also re-queue `failed` episodes that used up their attempts, with a fresh attempt budget. */
  readonly retryExhausted?: boolean
}

export interface DrainResult {
  /** Nothing is running and no queued job is runnable (remaining jobs wait on backoff, quota or the breaker). */
  readonly idle: boolean
  readonly queued: number
}

export interface JobRunnerStats {
  readonly started: boolean
  readonly stopped: boolean
  readonly running?: { readonly job: QueuedJob; readonly startedAt: Millis }
  /** Queue as last read from or written to the store. */
  readonly queue: readonly QueuedJob[]
  readonly nextWakeAt?: Millis
  readonly quota: { readonly day: string; readonly used: number; readonly limit: number }
  readonly breaker: { readonly open: boolean; readonly consecutiveFailures: number; readonly until?: Millis }
  /** Counts since this runner was created. */
  readonly totals: { readonly succeeded: number; readonly failed: number; readonly timedOut: number; readonly cancelled: number; readonly deferred: number }
  readonly lastError?: { readonly job: string; readonly message: string; readonly at: Millis }
}

export interface JobRunner {
  /** Resume the persisted queue and rescan every scope for unsummarized episodes. Never rejects. */
  start(): Promise<void>
  /** Queue a summary job; resolves `true` if newly queued, `false` if already queued or the store failed. Never rejects. */
  enqueueSummarize(scope: ScopeId, episode: EpisodeId): Promise<boolean>
  /** Queue a rollup job; same contract as {@link JobRunner.enqueueSummarize}. */
  enqueueRollup(scope: ScopeId, period: RollupPeriod): Promise<boolean>
  /** Queue `sealed` and retryable `failed` episodes plus planned rollups; resolves the number queued. Never rejects. */
  rescan(options?: RescanOptions): Promise<number>
  /** Schedule a pass now (no-op before `start()` or after `stop()`). */
  kick(options?: KickOptions): void
  /** Wait up to `timeoutMs` for the running job and every runnable job to finish. Never rejects. */
  drain(timeoutMs: number): Promise<DrainResult>
  /** Abort the running job (re-queued unchanged), cancel timers, and wait for a pending start-up rescan and the loop to exit. Never rejects. */
  stop(): Promise<void>
  stats(): JobRunnerStats
}

export class JobTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms`)
    this.name = 'JobTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class JobCancelledError extends Error {
  constructor() {
    super('job runner stopped')
    this.name = 'JobCancelledError'
  }
}

/**
 * Thrown by a job callback when it cannot run right now for a reason outside
 * the job itself (e.g. the host's model services are shutting down). The job
 * is re-queued unchanged after `retryAfterMs` (default: the base backoff)
 * without counting an attempt, marking the episode failed, or tripping the
 * circuit breaker.
 */
export class JobDeferredError extends Error {
  readonly retryAfterMs: number | undefined

  constructor(message: string, options?: ErrorOptions & { readonly retryAfterMs?: number }) {
    super(message, options)
    this.name = 'JobDeferredError'
    this.retryAfterMs = options?.retryAfterMs
  }
}

type Outcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'deferred'; readonly error: JobDeferredError }
  | { readonly kind: 'failure'; readonly error: unknown; readonly timedOut: boolean }

type Step = { readonly kind: 'ran' } | { readonly kind: 'idle' } | { readonly kind: 'wait'; readonly at: Millis }

interface Claim {
  readonly original: QueuedJob
  readonly leased: QueuedJob
  /** Quota day the claim was counted against. */
  readonly day: string
}

const CLAIM_RETRY_MS = 1000
const MAX_ERROR_LENGTH = 500

/** Dedupe identity: one queued job per episode or per rollup period, within a scope. */
export function jobKey(job: QueuedJob): string {
  return job.kind === 'summarize' ? `summarize:${job.scope}:${job.episode}` : `rollup:${job.scope}:${periodId(job.period)}`
}

/** Retry delay after the given number of failed attempts. */
export function backoffDelay(attempts: number, options: Pick<Required<JobRunnerOptions>, 'baseBackoffMs' | 'maxBackoffMs'>): number {
  return Math.min(options.maxBackoffMs, options.baseBackoffMs * 2 ** Math.max(0, attempts - 1))
}

function isQueuedJob(value: unknown): value is QueuedJob {
  if (typeof value !== 'object' || value === null) return false
  const job = value as Record<string, unknown>
  if (typeof job['scope'] !== 'string' || typeof job['notBefore'] !== 'number' || typeof job['attempts'] !== 'number') return false
  if (job['kind'] === 'summarize') return typeof job['episode'] === 'string'
  if (job['kind'] !== 'rollup' || typeof job['period'] !== 'object' || job['period'] === null) return false
  const period = job['period'] as Record<string, unknown>
  return (period['kind'] === 'week' || period['kind'] === 'month' || period['kind'] === 'year') && typeof period['key'] === 'string'
}

function isLedger(value: unknown): value is JobQuotaLedger {
  if (typeof value !== 'object' || value === null) return false
  const ledger = value as Record<string, unknown>
  return typeof ledger['day'] === 'string' && typeof ledger['used'] === 'number' && Number.isFinite(ledger['used'])
}

function validJobs(queue: unknown): readonly QueuedJob[] {
  return Array.isArray(queue) ? queue.filter(isQueuedJob) : []
}

function pickDue(queue: readonly QueuedJob[], now: Millis): QueuedJob | undefined {
  let best: QueuedJob | undefined
  for (const job of queue) {
    if (job.notBefore > now) continue
    if (!best) {
      best = job
      continue
    }
    const rank = (job.kind === 'summarize' ? 0 : 1) - (best.kind === 'summarize' ? 0 : 1)
    if (rank < 0 || (rank === 0 && job.notBefore < best.notBefore)) best = job
  }
  return best
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text
}

function resolveOptions(options: JobRunnerOptions = {}): Required<JobRunnerOptions> {
  const defaults = DEFAULT_JOB_RUNNER_OPTIONS
  const pick = (value: number | undefined, fallback: number, min: number): number =>
    value !== undefined && Number.isFinite(value) ? Math.max(min, value) : fallback
  const baseBackoffMs = pick(options.baseBackoffMs, defaults.baseBackoffMs, 0)
  return {
    jobTimeoutMs: pick(options.jobTimeoutMs, defaults.jobTimeoutMs, 1),
    leaseGraceMs: pick(options.leaseGraceMs, defaults.leaseGraceMs, 0),
    baseBackoffMs,
    maxBackoffMs: Math.max(baseBackoffMs, pick(options.maxBackoffMs, defaults.maxBackoffMs, 0)),
    maxAttempts: Math.floor(pick(options.maxAttempts, defaults.maxAttempts, 1)),
    breakerThreshold: Math.floor(pick(options.breakerThreshold, defaults.breakerThreshold, 1)),
    breakerCooldownMs: pick(options.breakerCooldownMs, defaults.breakerCooldownMs, 0),
    dailyQuota: options.dailyQuota === Infinity ? Infinity : Math.floor(pick(options.dailyQuota, defaults.dailyQuota, 0)),
  }
}

/**
 * Background runner for summary and rollup jobs (design §3.5). The queue and
 * the daily quota live in `state.json` through `store.updateState`; a claimed
 * job is leased (its `notBefore` pushed past the timeout and `attempts`
 * incremented) so a second DSH process sharing the store skips it and a crash
 * mid-job still counts the attempt. One job runs at a time.
 */
export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const { store, clock, logger } = deps
  const timers = deps.timers ?? systemTimers
  const limits = resolveOptions(deps.options)
  const leaseMs = limits.jobTimeoutMs + limits.leaseGraceMs

  let started = false
  let stopped = false
  let stopping: Promise<void> | undefined
  let starting: Promise<void> | undefined
  let loop: Promise<void> | undefined
  let again = false
  let forceRequested = false
  let wake: { readonly handle: unknown; readonly at: Millis } | undefined
  let current: { readonly job: QueuedJob; readonly controller: AbortController; readonly startedAt: Millis } | undefined
  let consecutiveFailures = 0
  let breakerUntil: Millis | undefined
  let ledger: JobQuotaLedger = { day: '', used: 0 }
  let quotaNoticeDay: string | undefined
  let snapshot: readonly QueuedJob[] = []
  let lastError: JobRunnerStats['lastError']
  const builtRollups = new Set<string>()
  const totals = { succeeded: 0, failed: 0, timedOut: 0, cancelled: 0, deferred: 0 }

  function mergeLedger(persisted: unknown, now: Millis): JobQuotaLedger {
    const day = localDayKey(now)
    const stored = isLedger(persisted) && persisted.day === day ? persisted.used : 0
    const remembered = ledger.day === day ? ledger.used : 0
    return { day, used: Math.max(stored, remembered) }
  }

  function observe(state: StoreState, now: Millis): readonly QueuedJob[] {
    ledger = mergeLedger(state.quota, now)
    snapshot = validJobs(state.queue)
    return snapshot
  }

  function clearWake(): void {
    if (!wake) return
    timers.clearTimeout(wake.handle)
    wake = undefined
  }

  function scheduleWake(at: Millis): void {
    clearWake()
    const handle = timers.setTimeout(() => {
      if (wake?.handle === handle) wake = undefined
      try {
        kick()
      } catch (error) {
        logger.warn('job runner wake-up failed: %s', describe(error))
      }
    }, Math.max(0, at - clock.now()))
    wake = { handle, at }
  }

  async function addJobs(jobs: readonly QueuedJob[]): Promise<number> {
    if (jobs.length === 0) return 0
    let added = 0
    try {
      const next = await store.updateState(state => {
        added = 0
        const keys = new Set(validJobs(state.queue).map(jobKey))
        const fresh: QueuedJob[] = []
        for (const job of jobs) {
          const key = jobKey(job)
          if (keys.has(key)) continue
          keys.add(key)
          fresh.push(job)
        }
        added = fresh.length
        return added === 0 ? state : { ...state, queue: [...state.queue, ...fresh] }
      })
      observe(next, clock.now())
    } catch (error) {
      logger.warn('could not queue %d job(s): %s', jobs.length, describe(error))
      return 0
    }
    if (added > 0) kick()
    return added
  }

  function plannedRollups(scope: ScopeId, index: MemoryIndex, now: Millis): QueuedJob[] {
    if (!deps.rollupPlanner) return []
    let plans: readonly { readonly period: RollupPeriod }[]
    try {
      plans = deps.rollupPlanner(scope, index)
    } catch (error) {
      logger.warn('rollup planning failed for scope %s: %s', scope, describe(error))
      return []
    }
    const jobs: QueuedJob[] = []
    for (const { period } of plans) {
      const job: QueuedJob = { kind: 'rollup', scope, period: { kind: period.kind, key: period.key }, notBefore: now, attempts: 0 }
      if (builtRollups.has(jobKey(job))) {
        logger.debug('rollup %s was already built this run but is still planned; skipping', jobKey(job))
        continue
      }
      jobs.push(job)
    }
    return jobs
  }

  function recoveredJob(scope: ScopeId, meta: EpisodeMeta, now: Millis, retryExhausted: boolean): QueuedJob | undefined {
    if (meta.status !== 'sealed' && meta.status !== 'failed') return undefined
    const attempts = Math.max(0, meta.attempts ?? 0)
    const exhausted = attempts >= limits.maxAttempts
    if (exhausted && !retryExhausted) return undefined
    return { kind: 'summarize', scope, episode: meta.id, notBefore: now, attempts: exhausted ? 0 : attempts }
  }

  async function rescan(options: RescanOptions = {}): Promise<number> {
    const now = clock.now()
    let scopes: readonly ScopeId[]
    try {
      scopes = await store.listScopes()
    } catch (error) {
      logger.warn('rescan could not list scopes: %s', describe(error))
      return 0
    }
    const jobs: QueuedJob[] = []
    for (const scope of scopes) {
      let index: MemoryIndex
      try {
        index = await store.readIndex(scope)
      } catch (error) {
        logger.warn('rescan could not read the index of scope %s: %s', scope, describe(error))
        continue
      }
      for (const meta of index.episodes) {
        const job = recoveredJob(scope, meta, now, options.retryExhausted === true)
        if (job) jobs.push(job)
      }
      jobs.push(...plannedRollups(scope, index, now))
    }
    return addJobs(jobs)
  }

  async function applyForce(): Promise<void> {
    forceRequested = false
    const now = clock.now()
    const next = await store.updateState(state => ({
      ...state,
      queue: state.queue.map(job => (isQueuedJob(job) && job.notBefore > now ? { ...job, notBefore: now } : job)),
    }))
    observe(next, now)
  }

  async function claim(now: Millis): Promise<Claim | undefined> {
    let claimed: Claim | undefined
    const next = await store.updateState(state => {
      claimed = undefined
      const quota = mergeLedger(state.quota, now)
      const job = pickDue(validJobs(state.queue), now)
      if (!job || quota.used >= limits.dailyQuota) return state
      const leased: QueuedJob = { ...job, attempts: job.attempts + 1, notBefore: now + leaseMs }
      claimed = { original: job, leased, day: quota.day }
      const update: StoreState = {
        ...state,
        queue: state.queue.map(entry => (entry === job ? leased : entry)),
        quota: { day: quota.day, used: quota.used + 1 },
      }
      return update
    })
    observe(next, now)
    return claimed
  }

  async function execute(job: QueuedJob, controller: AbortController): Promise<Outcome> {
    const { signal } = controller
    let rejectAborted: (reason: unknown) => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject
    })
    aborted.catch(() => {})
    const onAbort = (): void => rejectAborted(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = timers.setTimeout(() => controller.abort(new JobTimeoutError(limits.jobTimeoutMs)), limits.jobTimeoutMs)
    try {
      if (signal.aborted) throw signal.reason
      const work = (async () => {
        if (job.kind === 'summarize') await deps.summarizeEpisode(job.scope, job.episode, signal)
        else await deps.buildRollup(job.scope, job.period, signal)
      })()
      await Promise.race([work, aborted])
      return { kind: 'success' }
    } catch (error) {
      const reason: unknown = signal.aborted ? signal.reason : undefined
      if (reason instanceof JobCancelledError) return { kind: 'cancelled' }
      if (reason instanceof JobTimeoutError) return { kind: 'failure', error: reason, timedOut: true }
      if (error instanceof JobDeferredError) return { kind: 'deferred', error }
      return { kind: 'failure', error, timedOut: false }
    } finally {
      timers.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Replace or remove this runner's lease, matched by key, attempts and
   * `notBefore`: a lease another process re-claimed after ours expired is
   * theirs to settle. Deferred and cancelled jobs did not use their quota slot.
   */
  async function settle(claimed: Claim, outcome: Outcome, now: Millis): Promise<void> {
    const key = jobKey(claimed.leased)
    const refund = outcome.kind === 'deferred' || outcome.kind === 'cancelled'
    let refunded = false
    const exhausted = outcome.kind === 'failure' && claimed.leased.attempts >= limits.maxAttempts
    const replacement: QueuedJob | undefined = outcome.kind === 'success' || exhausted
      ? undefined
      : outcome.kind === 'cancelled'
        ? claimed.original
        : outcome.kind === 'deferred'
          ? { ...claimed.original, notBefore: now + Math.max(0, outcome.error.retryAfterMs ?? limits.baseBackoffMs) }
          : { ...claimed.leased, notBefore: now + backoffDelay(claimed.leased.attempts, limits) }
    try {
      const next = await store.updateState(state => {
        const quota = refund && isLedger(state.quota) && state.quota.day === claimed.day && state.quota.used > 0
          ? { day: state.quota.day, used: state.quota.used - 1 }
          : undefined
        refunded = quota !== undefined
        const at = state.queue.findIndex(entry => isQueuedJob(entry)
          && jobKey(entry) === key
          && entry.attempts === claimed.leased.attempts
          && entry.notBefore === claimed.leased.notBefore)
        const queue = at < 0 ? state.queue : replacement ? state.queue.toSpliced(at, 1, replacement) : state.queue.toSpliced(at, 1)
        if (at < 0 && quota === undefined) return state
        return { ...state, queue, ...quota === undefined ? {} : { quota } }
      })
      if (refunded && ledger.day === claimed.day) ledger = { day: ledger.day, used: Math.max(0, ledger.used - 1) }
      observe(next, clock.now())
    } catch (error) {
      logger.warn('could not record the result of job %s: %s', key, describe(error))
    }
  }

  async function onSuccess(job: QueuedJob): Promise<void> {
    totals.succeeded += 1
    consecutiveFailures = 0
    breakerUntil = undefined
    logger.debug('job %s done', jobKey(job))
    if (job.kind === 'rollup') builtRollups.add(jobKey(job))
    if (!deps.rollupPlanner) return
    try {
      const index = await store.readIndex(job.scope)
      await addJobs(plannedRollups(job.scope, index, clock.now()))
    } catch (error) {
      logger.warn('could not plan rollups for scope %s: %s', job.scope, describe(error))
    }
  }

  async function onFailure(job: QueuedJob, error: unknown, timedOut: boolean, now: Millis): Promise<void> {
    const key = jobKey(job)
    const message = describe(error)
    totals.failed += 1
    if (timedOut) totals.timedOut += 1
    lastError = { job: key, message, at: now }
    if (job.attempts >= limits.maxAttempts) {
      logger.warn('job %s failed %d time(s), giving up: %s', key, job.attempts, message)
    } else {
      logger.warn('job %s failed (attempt %d/%d), retrying in %d s: %s', key, job.attempts, limits.maxAttempts, Math.round(backoffDelay(job.attempts, limits) / 1000), message)
    }
    consecutiveFailures += 1
    if (consecutiveFailures >= limits.breakerThreshold) {
      breakerUntil = now + limits.breakerCooldownMs
      logger.warn('%d consecutive job failures; pausing background jobs for %d s', consecutiveFailures, Math.round(limits.breakerCooldownMs / 1000))
    }
    if (job.kind !== 'summarize') return
    try {
      await store.updateEpisode(job.scope, job.episode, meta => meta.status === 'summarized' ? {} : { status: 'failed', lastError: message, attempts: job.attempts })
    } catch (failure) {
      logger.warn('could not mark episode %s failed: %s', job.episode, describe(failure))
    }
  }

  async function runClaimed(claimed: Claim): Promise<void> {
    const job = claimed.leased
    const controller = new AbortController()
    current = { job, controller, startedAt: clock.now() }
    if (stopped) controller.abort(new JobCancelledError())
    let outcome: Outcome
    try {
      outcome = await execute(job, controller)
    } finally {
      current = undefined
    }
    const now = clock.now()
    await settle(claimed, outcome, now)
    if (outcome.kind === 'success') await onSuccess(job)
    else if (outcome.kind === 'failure') await onFailure(job, outcome.error, outcome.timedOut, now)
    else if (outcome.kind === 'deferred') {
      totals.deferred += 1
      logger.debug('job %s deferred: %s', jobKey(job), describe(outcome.error))
    } else totals.cancelled += 1
  }

  async function step(): Promise<Step> {
    if (forceRequested) await applyForce()
    const now = clock.now()
    if (breakerUntil !== undefined && breakerUntil > now) return { kind: 'wait', at: breakerUntil }
    const queue = observe(await store.readState(), now)
    if (!pickDue(queue, now)) {
      if (queue.length === 0) return { kind: 'idle' }
      return { kind: 'wait', at: queue.reduce((earliest, job) => Math.min(earliest, job.notBefore), Infinity) }
    }
    if (ledger.used >= limits.dailyQuota) {
      if (quotaNoticeDay !== ledger.day) {
        quotaNoticeDay = ledger.day
        logger.info('daily job quota (%d) used up; %d job(s) wait for tomorrow', limits.dailyQuota, queue.length)
      }
      return { kind: 'wait', at: startOfNextLocalDay(now) }
    }
    const claimed = await claim(now)
    if (!claimed) return { kind: 'wait', at: now + CLAIM_RETRY_MS }
    await runClaimed(claimed)
    return { kind: 'ran' }
  }

  async function runLoop(): Promise<void> {
    while (!stopped) {
      again = false
      clearWake()
      let next: Step
      try {
        next = await step()
      } catch (error) {
        logger.warn('job runner pass failed: %s', describe(error))
        next = { kind: 'wait', at: clock.now() + limits.baseBackoffMs }
      }
      if (stopped) return
      if (next.kind === 'ran' || again) continue
      if (next.kind === 'wait') scheduleWake(next.at)
      return
    }
  }

  function kick(options: KickOptions = {}): void {
    if (options.force) {
      forceRequested = true
      consecutiveFailures = 0
      breakerUntil = undefined
    }
    if (!started || stopped) return
    if (loop) {
      again = true
      return
    }
    loop = runLoop()
      .catch(error => logger.warn('job runner loop failed: %s', describe(error)))
      .finally(() => {
        loop = undefined
        if (again && !stopped) kick()
      })
  }

  function start(): Promise<void> {
    if (started || stopped) return starting ?? Promise.resolve()
    started = true
    starting = (async () => {
      await rescan()
      kick()
    })()
    return starting
  }

  async function drain(timeoutMs: number): Promise<DrainResult> {
    kick()
    if (loop && timeoutMs > 0) {
      let handle: unknown
      const expired = new Promise<void>(resolve => {
        handle = timers.setTimeout(resolve, timeoutMs)
      })
      const finished = (async () => {
        while (loop) await loop
      })()
      await Promise.race([finished, expired])
      timers.clearTimeout(handle)
    }
    return { idle: loop === undefined, queued: snapshot.length }
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      stopped = true
      clearWake()
      current?.controller.abort(new JobCancelledError())
      await starting
      while (loop) await loop
    })()
    return stopping
  }

  function stats(): JobRunnerStats {
    const now = clock.now()
    const day = localDayKey(now)
    const breakerOpen = breakerUntil !== undefined && breakerUntil > now
    return {
      started,
      stopped,
      ...(current ? { running: { job: current.job, startedAt: current.startedAt } } : {}),
      queue: snapshot,
      ...(wake ? { nextWakeAt: wake.at } : {}),
      quota: { day, used: ledger.day === day ? ledger.used : 0, limit: limits.dailyQuota },
      breaker: { open: breakerOpen, consecutiveFailures, ...(breakerOpen && breakerUntil !== undefined ? { until: breakerUntil } : {}) },
      totals: { ...totals },
      ...(lastError ? { lastError } : {}),
    }
  }

  return {
    start,
    enqueueSummarize: (scope, episode) => addJobs([{ kind: 'summarize', scope, episode, notBefore: clock.now(), attempts: 0 }]).then(added => added > 0),
    enqueueRollup: (scope, period) => addJobs([{ kind: 'rollup', scope, period: { kind: period.kind, key: period.key }, notBefore: clock.now(), attempts: 0 }]).then(added => added > 0),
    rescan,
    kick,
    drain,
    stop,
    stats,
  }
}
