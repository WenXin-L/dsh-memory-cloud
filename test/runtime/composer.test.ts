import { describe, expect, it, vi } from 'vitest'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import type { CheckpointRequest, EpisodeMeta, PackInput } from '../../src/contracts.ts'
import { createCheckpointComposer } from '../../src/runtime/composer.ts'

const OPEN = {
  id: 'ep-open',
  sessionId: 'sess-1',
  status: 'open',
  startedAt: 1,
  seqRange: { first: 1, last: 20 },
  tokens: { raw: 100 },
} as unknown as EpisodeMeta

const OUTCOME = {
  result: { gist: 'gist', summary: 'summary', ongoing: [], importance: 5, keywords: [] },
  provenance: { provider: 'fake', model: 'fake-1' },
}

function setup(synthetic: ReadonlySet<number> = new Set(), outcome: unknown = OUTCOME) {
  const pack = vi.fn((_input: PackInput) => ({ text: '<memory-cloud>block</memory-cloud>' }))
  const composer = createCheckpointComposer({
    store: { readIndex: async () => ({ episodes: [OPEN], rollups: [] }), writeSnapshot: async () => 'snapshot' } as never,
    sources: { load: async () => ({ candidates: [], rollups: [] }) } as never,
    packer: { pack } as never,
    summarizer: { summarize: vi.fn(async () => outcome) } as never,
    estimator: { estimate: (text: string) => text.length } as never,
    clock: { now: () => 1000 },
    flushSession: async () => {},
    halfLifeDays: () => 14,
    log: async () => {},
    syntheticSeq: (_sessionId, seq) => synthetic.has(seq),
  })
  const compose = (regionSeqs?: readonly number[]) => composer.compose({
    sessionId: 'sess-1',
    scope: OWNER_SCOPE,
    ...regionSeqs === undefined ? {} : { regionSeqs },
    regionChars: 1000,
    maxChars: 500,
    replay: { messages: [] },
    budget: { recentSummaryTokens: 100, gistTokens: 20 },
    now: 1000,
  } as unknown as CheckpointRequest)
  return { composer, compose, pack }
}

describe('checkpoint composer cache', () => {
  it('hands a composition only to the seal whose real region bounds match exactly', async () => {
    const { composer, compose } = setup()
    await compose([5, 6, 7])

    expect(composer.takeComposed('sess-1', [5, 6, 7, 8, 9])).toBeUndefined()
    expect(composer.takeComposed('sess-1', [6, 7])).toBeUndefined()
    expect(composer.takeComposed('sess-1', undefined)).toBeUndefined()
    expect(composer.takeComposed('sess-1', [])).toBeUndefined()
    expect(composer.takeComposed('sess-1', [5, 6, 7])).toMatchObject({ episode: 'ep-open', regionSeqs: [5, 6, 7], outcome: OUTCOME })
    expect(composer.takeComposed('sess-1', [5, 6, 7])).toBeUndefined()
  })

  it('ignores synthetic seqs at either end of the region or the shadowed range', async () => {
    const { composer, compose } = setup(new Set([3, 4, 10]))
    await compose([3, 5, 6, 7])
    expect(composer.takeComposed('sess-1', [4, 5, 6, 7, 10])).toMatchObject({ regionSeqs: [3, 5, 6, 7] })
  })

  it('never caches a composition without a recorded region', async () => {
    const { composer, compose } = setup()
    await expect(compose()).resolves.toContain('<memory-cloud>')
    await expect(compose([])).resolves.toContain('<memory-cloud>')
    expect(composer.takeComposed('sess-1', [5, 6, 7])).toBeUndefined()
  })

  it('forgets every composition of a session', async () => {
    const { composer, compose } = setup()
    await compose([5, 6, 7])
    composer.forget('sess-1')
    expect(composer.takeComposed('sess-1', [5, 6, 7])).toBeUndefined()
  })
})

describe('checkpoint composer packing', () => {
  it('passes the fresh summary\'s promises and dates to the packer', async () => {
    const promises = [{ what: 'send the report', who: 'user', due: '2026-12-01' }]
    const dates = [{ date: '2026-12-05', what: 'team dinner' }]
    const { compose, pack } = setup(new Set(), { ...OUTCOME, result: { ...OUTCOME.result, promises, dates } })
    await compose([5, 6, 7])
    const fresh = pack.mock.calls[0]?.[0].candidates.at(-1)
    expect(fresh).toMatchObject({ meta: { id: 'ep-open', status: 'summarized' }, summary: 'summary', promises, dates })
  })
})
