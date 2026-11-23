import { uptime } from 'node:os'
import type { EpisodeMeta, Millis } from '../contracts.ts'

/** The process that opened an episode, recorded as `owner` in its index entry while it is open. */
export interface EpisodeOwner {
  readonly pid: number
  /** Process start time (epoch ms), so a reused PID is not mistaken for the owner. */
  readonly startedAt: Millis
}

export type EpisodeOwnerState = 'self' | 'alive' | 'dead'

/** Thrown by `appendRaw` when the episode is no longer `open` (e.g. another process sealed it). */
export class EpisodeNotOpenError extends Error {
  readonly code = 'EPISODE_NOT_OPEN'
  readonly status: string

  constructor(episode: string, status: string) {
    super(`memory store: episode ${episode} is ${status}, not open; refusing to append`)
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
 * `self` for this process, `alive` for another process that still runs, and
 * `dead` when the PID has exited, belongs to an earlier boot, or is this
 * process's PID reused from an earlier process.
 */
export function ownerState(owner: EpisodeOwner, self: EpisodeOwner = currentOwner(), bootTime: Millis = systemBootTime()): EpisodeOwnerState {
  if (owner.pid === self.pid) return Math.abs(owner.startedAt - self.startedAt) <= START_TOLERANCE_MS ? 'self' : 'dead'
  if (owner.startedAt < bootTime - BOOT_SLACK_MS) return 'dead'
  return isProcessAlive(owner.pid) ? 'alive' : 'dead'
}

/** An open episode whose recorded owner is another process that is still running. */
export function isOwnedByLiveForeignProcess(meta: EpisodeMeta): boolean {
  const owner = episodeOwner(meta)
  return owner !== undefined && ownerState(owner) === 'alive'
}
