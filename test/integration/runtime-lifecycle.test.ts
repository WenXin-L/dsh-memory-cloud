import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import type { ScopeId } from '../../src/contracts.ts'
import { createHarness, longText } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.dispose()
  harness = undefined
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function chat(h: Harness, id: string, turns = 4) {
  const conversation = await h.conversation(id)
  conversation.route()
  for (let turn = 0; turn < turns; turn++) {
    conversation.exchange(longText(`用户问题 ${turn}`, 1500), longText(`助手回答 ${turn}`, 1500))
  }
  await h.runtime.capture.flush()
  return conversation
}

describe('mode decisions', () => {
  it('recomputes the cached mode when a preset rebind swaps the compaction service, and on agent-preset/selected', async () => {
    const h = harness = await createHarness({ engine: 'memory' })
    const conversation = await h.conversation('sess-preset')
    expect(h.runtime.modes.modeFor(conversation.agent)).toMatchObject({ mode: 'engine', engineActive: true })

    let presetService: unknown = { compactNow: async () => null }
    h.ctx.provide('agentPresets', { serviceFor: () => presetService })
    expect(h.runtime.modes.modeFor(conversation.agent)).toMatchObject({ mode: 'assist', engineActive: false })
    presetService = undefined
    expect(h.runtime.modes.modeFor(conversation.agent)).toMatchObject({ mode: 'engine', engineActive: true })

    const refresh = vi.spyOn(h.runtime.modes, 'refresh')
    h.ctx.emit('agent-preset/selected', conversation.session.id, 'minimal')
    expect(refresh).toHaveBeenCalledWith(conversation.agent)
  })

  it('re-evaluates cached auto decisions when /memory status finds a new compaction plugin', async () => {
    const h = harness = await createHarness({ engine: 'memory', mode: 'auto' })
    const rows: unknown[] = []
    h.ctx.provide('loader', { entries: () => rows })
    const conversation = await h.conversation('sess-coexist')
    expect(h.runtime.modes.modeFor(conversation.agent)).toMatchObject({ mode: 'engine' })

    rows.push({ id: 'maid', disabled: false, options: { name: 'dsh-context-maid' } })
    expect(h.runtime.modes.modeFor(conversation.agent)).toMatchObject({ mode: 'engine' })

    const status = await h.runtime.service.api.status()
    expect(status.coexistence.compactionPlugins.map(plugin => plugin.id)).toEqual(['dsh-context-maid'])
    const decision = h.runtime.modes.modeFor(conversation.agent)
    expect(decision).toMatchObject({ mode: 'assist', engineActive: true })
    expect(decision.reason).toContain('dsh-context-maid')
  })
})

describe('privacy firewall status', () => {
  it('reports how unmatched sessions are scoped from the setting and the loaded chat bridges', async () => {
    const h = harness = await createHarness({ engine: 'memory' })
    const rows: unknown[] = []
    h.ctx.provide('loader', { entries: () => rows })

    const plain = await h.runtime.service.api.status()
    expect(plain.configured.unmatchedSessions).toBe('auto')
    expect(plain.firewall).toMatchObject({ setting: 'auto', mode: 'owner', bridges: [] })

    rows.push({ id: 'qq', disabled: false, options: { name: 'dsh-qqbot' } })
    expect((await h.runtime.service.api.status()).firewall).toMatchObject({ setting: 'auto', mode: 'isolated', bridges: ['dsh-qqbot'] })

    ;(h.setVolatile as (path: string, value: unknown) => void)('unmatchedSessions', 'owner')
    const owner = await h.runtime.service.api.status()
    expect(owner.configured.unmatchedSessions).toBe('owner')
    expect(owner.firewall).toMatchObject({ setting: 'owner', mode: 'owner', bridges: [] })
  })
})

describe('engine fallbacks', () => {
  it('counts routine hand-backs separately so they never push real failures out of the list', async () => {
    const h = harness = await createHarness({ engine: 'memory' })
    const { notifyFallback } = h.runtime.service
    notifyFallback({ kind: 'compose-error', stage: 'summarize', sessionId: 'sess-a' })
    for (let index = 0; index < 30; index++) notifyFallback({ kind: 'region-too-small', stage: 'summarize', sessionId: 'sess-a' })
    notifyFallback({ kind: 'subagent', stage: 'summarize', sessionId: 'sess-b' })
    notifyFallback({ kind: 'no-capture', stage: 'threshold', sessionId: 'sess-c' })

    const status = await h.runtime.service.api.status()
    expect(status.fallbacks).toMatchObject([{ kind: 'compose-error', sessionId: 'sess-a' }])
    expect(status.routineFallbacks).toEqual({ 'region-too-small': 30, subagent: 1, 'no-capture': 1 })
  })
})

describe('checkpoint cache', () => {
  it('drops cached compositions of a session when a compaction ends with an error', async () => {
    const h = harness = await createHarness({ engine: 'memory' })
    const conversation = await h.conversation('sess-end')
    const forget = vi.spyOn(h.runtime.composer, 'forget')
    conversation.session.append('compaction/end', { compactionId: 'c-1', turn: null } as never)
    expect(forget).not.toHaveBeenCalled()
    conversation.session.append('compaction/end', { compactionId: 'c-2', turn: null, error: 'summary failed' } as never)
    expect(forget).toHaveBeenCalledWith('sess-end')
  })
})

describe('session tags', () => {
  it('moves a session that is re-tagged after capture started into its new scope and drops its caches', async () => {
    const h = harness = await createHarness({ engine: 'memory' })
    ;(h.setVolatile as (path: string, value: unknown) => void)('scopeRules', [{ match: 'qqbot:*', scope: 'qq-test' }])
    const conversation = await chat(h, 'sess-tags', 1)
    expect((await h.runtime.store.readIndex(OWNER_SCOPE)).episodes).toMatchObject([{ status: 'open', sessionId: 'sess-tags' }])
    const injectorForget = vi.spyOn(h.runtime.injector, 'forget')
    const composerForget = vi.spyOn(h.runtime.composer, 'forget')
    const rescope = vi.spyOn(h.runtime.capture, 'rescope')

    h.runtime.service.setSessionTags('sess-tags', ['qqbot:42'])

    expect(h.runtime.service.scopeFor(conversation.agent as Agent).scope).toBe('qq-test')
    expect(injectorForget).toHaveBeenCalledWith('sess-tags')
    expect(composerForget).toHaveBeenCalledWith('sess-tags')
    expect(rescope).toHaveBeenCalledWith('sess-tags')
    await h.settle()
    expect((await h.runtime.store.readIndex(OWNER_SCOPE)).episodes.find(meta => meta.sessionId === 'sess-tags')?.status).not.toBe('open')

    conversation.exchange(longText('新的问题', 600), longText('新的回答', 600))
    await h.runtime.capture.flush()
    expect((await h.runtime.store.readIndex('qq-test' as ScopeId)).episodes).toMatchObject([{ status: 'open', sessionId: 'sess-tags' }])

    injectorForget.mockClear()
    rescope.mockClear()
    h.runtime.service.setSessionTags('sess-tags', ['qqbot:42'])
    expect(injectorForget).not.toHaveBeenCalled()
    expect(rescope).not.toHaveBeenCalled()
  })
})

describe('idle consolidation', () => {
  it('waits for a quiet delay after idle, and a new turn cancels it', async () => {
    const h = harness = await createHarness({ engine: 'memory', idleQuietMs: 40 })
    const conversation = await chat(h, 'sess-quiet')
    h.meter.pressure.set('sess-quiet', { pressureTokens: 100_000, contextWindow: 128 * 1024 })
    const compactNow = vi.spyOn(h.compaction!, 'compactNow')

    h.ctx.emit('agent/status', { agent: conversation.agent, status: 'idle' })
    expect(compactNow).not.toHaveBeenCalled()
    h.ctx.emit('agent/status', { agent: conversation.agent, status: 'running' })
    await sleep(80)
    expect(compactNow).not.toHaveBeenCalled()

    h.ctx.emit('agent/status', { agent: conversation.agent, status: 'idle' })
    await expect.poll(() => compactNow.mock.calls.length).toBe(1)
  })

  it('cancels a pending consolidation when the plugin is disposed', async () => {
    const h = await createHarness({ engine: 'memory', idleQuietMs: 40 })
    const conversation = await chat(h, 'sess-dispose')
    h.meter.pressure.set('sess-dispose', { pressureTokens: 100_000, contextWindow: 128 * 1024 })
    const compactNow = vi.spyOn(h.compaction!, 'compactNow')
    h.ctx.emit('agent/status', { agent: conversation.agent, status: 'idle' })
    await h.dispose()
    await sleep(80)
    expect(compactNow).not.toHaveBeenCalled()
  })
})
