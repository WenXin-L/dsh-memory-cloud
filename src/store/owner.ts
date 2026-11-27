import { spawnSync } from 'node:child_process'
import { uptime } from 'node:os'
import type { EpisodeMeta, Millis } from '../contracts.ts'

/** The process that opened or adopted an episode, recorded as `owner` in its index entry while it is open. */
export interface EpisodeOwner {
  readonly pid: number
  /** Process start time (epoch ms), so a reused PID is not mistaken for the owner (see {@link ownerState}). */
  readonly startedAt: Millis
}

export type EpisodeOwnerState = 'self' | 'alive' | 'dead'

/** Thrown by `appendRaw` when the episode is no longer `open` (e.g. another process sealed it). */
export class EpisodeNotOpenError extends Error {
  readonly code = 'EPISODE_NOT_OPEN'
  readonly status: string

  constructor(episode: string, status: string) {
    super(`memory store: 只有 open 状态的片段可以追加记录。 / Only open episodes accept new records. Episode ${episode}: ${status}.`)
    this.name = 'EpisodeNotOpenError'
    this.status = status
  }
}

/** Matches by `code` so separately bundled copies of the store are recognized too. */
export function isEpisodeNotOpenError(error: unknown): error is EpisodeNotOpenError {
  return error instanceof Error && (error as { code?: unknown }).code === 'EPISODE_NOT_OPEN'
}

const START_TOLERANCE_MS = 1
const BOOT_SLACK_MS = 2000
/**
 * How much later than the recorded owner the process now holding its PID may
 * have started and still count as the owner. Generous, because a wrong `dead`
 * lets another process seal a live episode, while a PID is practically never
 * reused this soon.
 */
const PID_REUSE_SLACK_MS = 5 * 60_000
const PS_TIMEOUT_MS = 2000
const ELAPSED = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/

export function currentOwner(): EpisodeOwner {
  return { pid: process.pid, startedAt: Math.round(performance.timeOrigin) }
}

/** Wall-clock time of the last system boot. */
export function systemBootTime(now: Millis = Date.now()): Millis {
  return now - uptime() * 1000
}

export function episodeOwner(meta: EpisodeMeta): EpisodeOwner | undefined {
  const owner = (meta as { readonly owner?: unknown }).owner
  if (typeof owner !== 'object' || owner === null) return undefined
  const { pid, startedAt } = owner as Record<string, unknown>
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined
  return { pid, startedAt }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

/**
 * Start time (epoch ms, to the second) of the running process `pid`, from its
 * elapsed time in `ps -o etime=` (macOS, Linux, BSD); undefined when `ps` is
 * unavailable, fails, or knows no such process.
 */
export function processStartTime(pid: number): Millis | undefined {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    const result = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS })
    const now = Date.now()
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
    const match = ELAPSED.exec(result.stdout.trim())
    if (match === null) return undefined
    const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match
    return now - (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
  } catch {
    return undefined
  }
}

/**
 * `self` for this process, `alive` for another process that still runs, and
 * `dead` when the PID has exited, belongs to an earlier boot, is this
 * process's PID reused from an earlier process, or is held by a process that
 * started more than {@link PID_REUSE_SLACK_MS} after the owner (a reused PID).
 * The last check is best effort: where `startTimeOf` cannot tell (no `ps`, as
 * on Windows), a live PID counts as the owner.
 */
export function ownerState(
  owner: EpisodeOwner,
  self: EpisodeOwner = currentOwner(),
  bootTime: Millis = systemBootTime(),
  startTimeOf: (pid: number) => Millis | undefined = processStartTime,
): EpisodeOwnerState {
  if (owner.pid === self.pid) return Math.abs(owner.startedAt - self.startedAt) <= START_TOLERANCE_MS ? 'self' : 'dead'
  if (owner.startedAt < bootTime - BOOT_SLACK_MS) return 'dead'
  if (!isProcessAlive(owner.pid)) return 'dead'
  const started = startTimeOf(owner.pid)
  return started !== undefined && started - owner.startedAt > PID_REUSE_SLACK_MS ? 'dead' : 'alive'
}

/** An open episode whose recorded owner is another process that is still running. */
export function isOwnedByLiveForeignProcess(meta: EpisodeMeta): boolean {
  const owner = episodeOwner(meta)
  return owner !== undefined && ownerState(owner) === 'alive'
}
