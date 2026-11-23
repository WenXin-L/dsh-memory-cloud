import { join } from 'node:path'
import type { TakeoverRecords, TakeoverStateStore } from '../engine/index.ts'
import { readTextIfExists, writeJsonAtomic } from '../store/files.ts'
import { withPathLock } from '../store/lock.ts'

/** `<root>/takeover.json`: preset takeover records per DSH profile (each profile has its own patch). */
export const TAKEOVER_FILE = 'takeover.json'

const LOCK_WAIT_MS = 10_000

interface TakeoverFile {
  readonly version: 1
  readonly profiles: Readonly<Record<string, TakeoverRecords>>
}

async function readFile(file: string): Promise<TakeoverFile> {
  const text = await readTextIfExists(file)
  if (text === undefined) return { version: 1, profiles: {} }
  try {
    const parsed = JSON.parse(text) as Partial<TakeoverFile> | null
    const profiles = parsed !== null && typeof parsed === 'object' && typeof parsed.profiles === 'object' && parsed.profiles !== null ? parsed.profiles : {}
    return { version: 1, profiles }
  } catch {
    return { version: 1, profiles: {} }
  }
}

/** Takeover controller state kept beside the store, keyed by DSH profile name. */
export function createTakeoverStateFile(root: string, profile: string): TakeoverStateStore {
  const file = join(root, TAKEOVER_FILE)
  return {
    async get() {
      return (await readFile(file)).profiles[profile]
    },
    async set(records) {
      await withPathLock(file, async () => {
        const current = await readFile(file)
        await writeJsonAtomic(file, { version: 1, profiles: { ...current.profiles, [profile]: records } } satisfies TakeoverFile)
      }, { waitMs: LOCK_WAIT_MS })
    },
  }
}
