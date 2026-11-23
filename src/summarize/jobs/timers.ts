import { clearTimeout, setTimeout } from 'node:timers'

/** Timer seam so the runner can be driven by a fake clock in tests. */
export interface JobTimers {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** Node timers, unref'd so pending background work never keeps DSH alive. */
export const systemTimers: JobTimers = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS))
    handle.unref()
    return handle
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}
