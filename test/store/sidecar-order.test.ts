import { readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import { BASE_TIME, fakeClock, makeStore, records, useTempRoots } from './helpers.ts'

const failIndex = vi.hoisted(() => ({ on: false }))

vi.mock('@deepseek-ai/dsh-atomic-write', async importOriginal => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      if (failIndex.on && basename(args[0]) === 'index.json') throw new Error('injected index write failure')
      return actual.writeFileAtomic(...args)
    },
  }
})

const newRoot = useTempRoots()

describe('meta.json sidecar order', () => {
  it('writes the sidecar before index.json, so a rebuild keeps a seal whose index write failed', async () => {
    const root = await newRoot()
    const clock = fakeClock()
    const store = makeStore(root, clock)
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 's1', startedAt: BASE_TIME, firstSeq: 1 })
    await store.appendRaw(OWNER_SCOPE, meta.id, records(1, 4))

    failIndex.on = true
    try {
      await expect(store.sealEpisode(OWNER_SCOPE, meta.id, { reason: 'end', endedAt: BASE_TIME + 4000, lastSeq: 4, rawTokens: 9 })).rejects.toThrow(/injected/)
    } finally {
      failIndex.on = false
    }
    const sidecar = JSON.parse(await readFile(join(root, 'scopes', 'owner', meta.dir, 'meta.json'), 'utf8'))
    expect(sidecar).toMatchObject({ status: 'sealed', seqRange: { first: 1, last: 4 } })
    expect((await store.readIndex(OWNER_SCOPE)).episodes[0]?.status).toBe('open')

    await rm(join(root, 'scopes', 'owner', 'index.json'))
    const rebuilt = await makeStore(root, clock).readIndex(OWNER_SCOPE)
    expect(rebuilt.episodes[0]).toMatchObject({ status: 'sealed', sealReason: 'end', seqRange: { first: 1, last: 4 }, tokens: { raw: 9 } })
  })
})
