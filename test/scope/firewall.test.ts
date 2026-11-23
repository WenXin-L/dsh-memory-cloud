import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EpisodeSummaryResult, MemoryStore, ScopeId } from '../../src/contracts.ts'
import { MEMORY_SOURCE_KIND, OWNER_SCOPE } from '../../src/contracts.ts'
import { createCheckpointComposer } from '../../src/runtime/composer.ts'
import type { CheckpointComposerDeps } from '../../src/runtime/composer.ts'
import { createHarness, MODEL, PROVIDER, userMessage } from '../integration/harness.ts'
import type { Harness } from '../integration/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function setVolatile(h: Harness, path: 'scopeRules' | 'unmatchedSessions', value: unknown): void {
  ;(h.config[path] as unknown as Record<symbol, (value: unknown) => void>)[VOLATILE_WRITE]?.(value)
}

function memoryTexts(messages: readonly UserMessage[]): string[] {
  return messages
    .filter(message => message.source.kind === MEMORY_SOURCE_KIND)
    .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

async function seedOwnerEpisode(store: MemoryStore): Promise<void> {
  const startedAt = Date.UTC(2026, 9, 1, 2)
  const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: 'old-owner-session', startedAt, firstSeq: 1 })
  await store.appendRaw(OWNER_SCOPE, meta.id, [
    { seq: 1, time: startedAt, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '我的银行卡密码提示是猫的名字' }], source: { kind: 'user' } } },
  ])
  await store.sealEpisode(OWNER_SCOPE, meta.id, { reason: 'end', endedAt: startedAt + 1000, lastSeq: 1, rawTokens: 20 })
  const result: EpisodeSummaryResult = {
    gist: '主人的私密总结：猫的名字。',
    summary: '主人的私密摘要：密码提示是猫的名字。',
    ongoing: [],
    importance: 9,
    keywords: ['私密'],
    people: [],
    dates: [],
    promises: [],
  }
  await store.writeSummary(OWNER_SCOPE, meta.id, result, { provider: PROVIDER, model: MODEL, promptVersion: 'test', summarizedAt: startedAt + 2000 }, { summary: 0, gist: 0 })
}

describe('privacy firewall for untagged sessions', () => {
  it('keeps owner memory out of untagged sessions once a chat bridge is loaded, unless a rule maps them to owner', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    await seedOwnerEpisode(h.runtime.store)
    h.ctx.provide('loader', { entries: () => [{ options: { id: 'qq', name: '@tencent-connect/dsh-qqbot' } }] })
    expect(h.config.unmatchedSessions.get()).toBe('auto')

    const group = await h.conversation('sess-qq-group')
    const decision = h.runtime.service.scopeFor(group.agent)
    expect(decision.scope).toMatch(/^session-[0-9a-f]{8}$/)
    expect(decision.private).toBe(false)
    expect(decision.reason).toContain('dsh-qqbot')
    const step = await h.preStep(group.agent, [userMessage('大家好')])
    expect(memoryTexts(step.kind === 'enter' ? step.messages : []).join('')).not.toContain('私密')
    await expect(h.tool('memory_search', { query: '私密' }, group.agent)).resolves.toMatchObject({ total: 0 })

    setVolatile(h, 'scopeRules', [{ match: 'session:sess-mine*', scope: 'owner' }])
    const mine = await h.conversation('sess-mine-1')
    expect(h.runtime.service.scopeFor(mine.agent)).toMatchObject({ scope: OWNER_SCOPE, private: true })
    const own = await h.preStep(mine.agent, [userMessage('早上好')])
    expect(memoryTexts(own.kind === 'enter' ? own.messages : []).join('')).toContain('私密')
  })

  it('detects a chat bridge that is only declared inside a preset composition', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    h.ctx.provide('agentPresets', {
      inspectCompositions: () => [],
      compositionInventory: async () => [{ id: 'standard', isDefault: true, rows: [{ entryId: 'qq', moduleName: 'dsh-qq-rooms', enabled: true }] }],
    })
    const session = await h.conversation('sess-nested-bridge')
    h.runtime.service.scopeFor(session.agent)
    await vi.waitFor(() => {
      const decision = h.runtime.service.scopeFor(session.agent)
      expect(decision.private).toBe(false)
      expect(decision.reason).toContain('dsh-qq-rooms')
    })
  })

  it('isolates untagged sessions when unmatchedSessions is isolated, and keeps owner when it is owner', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    await seedOwnerEpisode(h.runtime.store)
    setVolatile(h, 'unmatchedSessions', 'isolated')
    const guest = await h.conversation('sess-guest')
    expect(h.runtime.service.scopeFor(guest.agent)).toMatchObject({ private: false })
    const step = await h.preStep(guest.agent, [userMessage('你好')])
    expect(memoryTexts(step.kind === 'enter' ? step.messages : [])).toEqual([])

    setVolatile(h, 'unmatchedSessions', 'owner')
    const owner = await h.conversation('sess-owner')
    expect(h.runtime.service.scopeFor(owner.agent)).toMatchObject({ scope: OWNER_SCOPE, private: true })
  })
})

describe('checkpoint composer guard', () => {
  function deps(mayRead: CheckpointComposerDeps['mayRead']): CheckpointComposerDeps & { flushSession: ReturnType<typeof vi.fn> } {
    return {
      store: { readIndex: vi.fn(async () => { throw new Error('index read') }), writeSnapshot: vi.fn() },
      sources: { load: vi.fn() } as unknown as CheckpointComposerDeps['sources'],
      packer: { pack: vi.fn() } as unknown as CheckpointComposerDeps['packer'],
      summarizer: { summarize: vi.fn() },
      estimator: { estimate: () => 1 } as unknown as CheckpointComposerDeps['estimator'],
      clock: { now: () => 0 },
      flushSession: vi.fn(async () => {}),
      halfLifeDays: () => 14,
      log: async () => {},
      ...mayRead === undefined ? {} : { mayRead },
    }
  }

  const request = (scope: string) => ({
    sessionId: 's1',
    scope: scope as ScopeId,
    regionChars: 1000,
    maxChars: 500,
    replay: { messages: [] },
    budget: {} as never,
    now: 0,
  })

  it('rejects before touching the store when the session may not read the scope', async () => {
    const mayRead = vi.fn(() => false)
    const d = deps(mayRead)
    await expect(createCheckpointComposer(d).compose(request('owner'))).rejects.toThrow('may not read memory scope owner')
    expect(mayRead).toHaveBeenCalledWith('s1', 'owner')
    expect(d.flushSession).not.toHaveBeenCalled()
  })

  it('proceeds when the guard allows the scope', async () => {
    const d = deps(() => true)
    await expect(createCheckpointComposer(d).compose(request('qq-group-1'))).rejects.toThrow('index read')
    expect(d.flushSession).toHaveBeenCalledWith('s1')
  })
})
