import { AsyncLocalStorage } from 'node:async_hooks'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { isProcessAlive, systemBootTime } from './owner.ts'

interface Hold {
  active: boolean
  tail: Promise<void>
}

interface LockRegistry {
  readonly tails: Map<string, Promise<void>>
  readonly holds: AsyncLocalStorage<ReadonlyMap<string, Hold>>
}

export interface PathLockOptions {
  readonly waitMs: number
}

const REGISTRY_KEY = Symbol.for('dsh-memory-cloud-brain/store-locks')

function registry(): LockRegistry {
  const slots = globalThis as unknown as Record<symbol, LockRegistry | undefined>
  return slots[REGISTRY_KEY] ??= { tails: new Map(), holds: new AsyncLocalStorage() }
}

function noop(): void {}

function chain<T>(previous: Promise<void>, operation: () => Promise<T>): { result: Promise<T>; tail: Promise<void> } {
  const result = previous.then(operation)
  return { result, tail: result.then(noop, noop) }
}

/**
 * Run `operation` after every earlier operation queued under the same key in
 * this process. The queue is process-wide, so separate store instances (and
 * separately bundled copies of this module) over one root share it.
 */
export function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const { tails } = registry()
  const { result, tail } = chain(tails.get(key) ?? Promise.resolve(), operation)
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return result
}

/**
 * Hold the writer lock for `file`: queued in-process first, then the
 * cross-process `withFileLock` sibling (`<file>.lock`). Reentrant within the
 * async context of a holder; nested acquisitions run one at a time among
 * themselves while the outer hold stays in place.
 */
export function withPathLock<T>(file: string, operation: () => Promise<T>, options: PathLockOptions): Promise<T> {
  const key = resolve(file)
  const { holds } = registry()
  const current = holds.getStore()
  const parent = current?.get(key)
  const enter = async (): Promise<T> => {
    const hold: Hold = { active: true, tail: Promise.resolve() }
    const next = new Map(current)
    next.set(key, hold)
    try {
      return await holds.run(next, operation)
    } finally {
      hold.active = false
    }
  }
  if (parent?.active) {
    const { result, tail } = chain(parent.tail, enter)
    parent.tail = tail
    return result
  }
  return serialize(key, async () => {
    await mkdir(dirname(key), { recursive: true, mode: 0o700 })
    await clearPartialLock(`${key}.lock`)
    return withFileLock(key, enter, { waitMs: options.waitMs })
  })
}

/**
 * A lock record shorter than `<pid>\n` that has not changed for this long was
 * cut short by a writer that died between creating the lock and writing its
 * PID (DSH exiting mid-write). Writing a PID takes microseconds.
 */
export const STALE_PARTIAL_LOCK_MS = 5000

/**
 * Slack for file systems that store mtimes in whole seconds, so a lock this
 * process wrote just after starting is never taken for one written before it.
 */
const OWN_LOCK_SLACK_MS = 2000

/**
 * Whether a complete `<pid>\n` record written at `mtimeMs` belongs to a holder
 * that is gone although `withFileLock` cannot tell: the PID is now this
 * process's (the host never takes over a lock naming itself) and the record
 * predates this process, or the record predates the last boot and a live
 * process reused the PID. A record whose PID has exited is left to
 * `withFileLock`'s own takeover, so only one kind of remover acts on it.
 */
function isOrphanedRecord(pid: number, mtimeMs: number, bootTime: number): boolean {
  if (pid === process.pid) return mtimeMs < performance.timeOrigin - OWN_LOCK_SLACK_MS
  return mtimeMs < bootTime && isProcessAlive(pid)
}

/**
 * Remove `lockPath` when it is older than {@link STALE_PARTIAL_LOCK_MS} and
 * either holds no complete PID record or holds an orphaned one (see
 * {@link isOrphanedRecord}). `withFileLock` only takes over locks whose
 * recorded PID has exited and treats any other content as "being written", so
 * a torn record, a record naming this process left by an earlier holder of
 * its PID, or the PID of a holder that died before a reboot and was since
 * reused by a live process, would otherwise block every later write until
 * removed by hand. A fresh partial record (a live contender mid-write) is left
 * alone.
 *
 * Removal re-checks the inode and mtime, and that a complete record is still
 * orphaned, while holding a `wx`-created `<lock>.clear` claim, so two clearers
 * cannot both pass the check and the slower one delete a lock a live writer
 * created in between.
 */
export async function clearPartialLock(lockPath: string, now: number = Date.now(), bootTime: number = systemBootTime(now)): Promise<boolean> {
  let seen: Stats
  try {
    seen = await lstat(lockPath)
  } catch {
    return false
  }
  if (now - seen.mtimeMs < STALE_PARTIAL_LOCK_MS) return false
  let record: string
  try {
    record = await readFile(lockPath, 'utf8')
  } catch {
    return false
  }
  const pid = /^\d+\n$/.test(record) ? Number(record.trim()) : undefined
  if (pid !== undefined && !isOrphanedRecord(pid, seen.mtimeMs, bootTime)) return false
  const claim = `${lockPath}.clear`
  if (!await takeClaim(claim, now)) return false
  try {
    const again = await lstat(lockPath)
    if (again.ino !== seen.ino || again.mtimeMs !== seen.mtimeMs) return false
    if (pid !== undefined && !isOrphanedRecord(pid, seen.mtimeMs, bootTime)) return false
    await rm(lockPath, { force: true })
    return true
  } catch {
    return false
  } finally {
    await rm(claim, { force: true }).catch(noop)
  }
}

async function takeClaim(claim: string, now: number): Promise<boolean> {
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') return false
  }
  try {
    const info = await lstat(claim)
    if (now - info.mtimeMs >= STALE_PARTIAL_LOCK_MS) await rm(claim, { force: true })
  } catch {}
  return false
}
