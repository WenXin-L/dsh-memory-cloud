import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import type { MemoryStore, ScopeId } from '../../src/contracts.ts'
import { DEFAULT_ENGINE_HEADROOM_TOKENS } from '../../src/engine/index.ts'
import { resolveBudget } from '../../src/pack/index.ts'
import { FALLBACK_CONTEXT_WINDOW, MEMORY_SHARE } from '../../src/runtime/budget.ts'
import { createFileMemoryStore } from '../../src/store/index.ts'
import { periodRange, rollupPeriodOf } from '../../src/summarize/jobs/index.ts'
import { createHarness, longText, MODEL, PROVIDER, summaryReply, userMessage } from './harness.ts'
import type { Conversation, Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.dispose()
  harness = undefined
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const DAY = 86_400_000
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function setScopeRules(h: Harness, rules: readonly { match: string; scope: string }[]): void {
  ;(h.config.scopeRules as unknown as Record<symbol, (value: unknown) => void>)[VOLATILE_WRITE]?.(rules)
}

async function chat(h: Harness, id: string, turns = 4) {
  const conversation = await h.conversation(id)
  conversation.route()
  for (let turn = 0; turn < turns; turn++) {
    conversation.exchange(longText(`用户问题 ${turn}`, 1500), longText(`助手回答 ${turn}`, 1500))
  }
  await h.runtime.capture.flush()
  return conversation
}

/** Summarized episodes in one ISO week two months ago, each with `gistTokens` gist tokens. */
async function seedOldWeek(store: MemoryStore, episodes: number, gistTokens: number): Promise<void> {
  const week = periodRange(rollupPeriodOf('week', Date.now() - 60 * DAY))!
  for (let index = 0; index < episodes; index++) {
    const startedAt = week.from + DAY + index * 60_000
    const meta = await store.openEpisode(OWNER_SCOPE, { sessionId: `old-${index}`, startedAt, firstSeq: 1 })
    await store.appendRaw(OWNER_SCOPE, meta.id, [{ seq: 1, time: startedAt, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: `第 ${index} 次聊天` }], source: { kind: 'user' } } }])
    await store.sealEpisode(OWNER_SCOPE, meta.id, { reason: 'end', endedAt: startedAt + 1000, lastSeq: 1, rawTokens: 10 })
    await store.writeSummary(OWNER_SCOPE, meta.id, JSON.parse(summaryReply()), { provider: PROVIDER, model: MODEL, promptVersion: 'test', summarizedAt: startedAt + 2000 }, { summary: 40, gist: gistTokens })
  }
}

/** Run a pre-step and commit what it admitted, like the agent loop. */
async function step(h: Harness, conversation: Conversation, text: string): Promise<void> {
  const decision = await h.preStep(conversation.agent, [userMessage(text)])
  if (decision.kind !== 'enter') return
  for (const message of decision.messages) conversation.session.append('user/message', message as never, { surfaceOp: 'append' })
}

function warnings(h: Harness, text: string): unknown[] {
  return h.ctx.logger.buffer.filter(message => message.type === 'warn' && String(message.args[0]).includes(text))
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
    const injectorRescope = vi.spyOn(h.runtime.injector, 'rescope')
    const composerForget = vi.spyOn(h.runtime.composer, 'forget')
    const rescope = vi.spyOn(h.runtime.capture, 'rescope')

    h.runtime.service.setSessionTags('sess-tags', ['qqbot:42'])

    expect(h.runtime.service.scopeFor(conversation.agent as Agent).scope).toBe('qq-test')
    expect(injectorRescope).toHaveBeenCalledWith('sess-tags')
    expect(composerForget).toHaveBeenCalledWith('sess-tags')
    expect(rescope).toHaveBeenCalledWith('sess-tags')
    await h.settle()
    expect((await h.runtime.store.readIndex(OWNER_SCOPE)).episodes.find(meta => meta.sessionId === 'sess-tags')?.status).not.toBe('open')

    conversation.exchange(longText('新的问题', 600), longText('新的回答', 600))
    await h.runtime.capture.flush()
    expect((await h.runtime.store.readIndex('qq-test' as ScopeId)).episodes).toMatchObject([{ status: 'open', sessionId: 'sess-tags' }])

    injectorRescope.mockClear()
    rescope.mockClear()
    h.runtime.service.setSessionTags('sess-tags', ['qqbot:42'])
    expect(injectorRescope).not.toHaveBeenCalled()
    expect(rescope).not.toHaveBeenCalled()
  })

  it('compares the new decision of a session without a live agent before re-scoping it', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    setScopeRules(h, [{ match: 'qqbot:*', scope: 'qq-test' }])
    h.ctx.sessions.create(SessionId('sess-agentless'))
    const injectorRescope = vi.spyOn(h.runtime.injector, 'rescope')
    const rescope = vi.spyOn(h.runtime.capture, 'rescope')

    h.runtime.service.setSessionTags('sess-agentless', ['room:lobby'])
    expect(injectorRescope).not.toHaveBeenCalled()
    expect(rescope).not.toHaveBeenCalled()

    h.runtime.service.setSessionTags('sess-agentless', ['qqbot:7'])
    expect(injectorRescope).toHaveBeenCalledWith('sess-agentless')
    expect(rescope).toHaveBeenCalledWith('sess-agentless')
  })

  it('still warns that an owner block is visible after the tags moved the session out of owner', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    await seedOldWeek(h.runtime.store, 2, 20)
    setScopeRules(h, [{ match: 'qqbot:*', scope: 'qq-test' }])
    const conversation = await h.conversation('sess-moved')
    await step(h, conversation, '你好')
    expect(conversation.visible('memory-cloud')).toHaveLength(1)

    h.runtime.service.setSessionTags('sess-moved', ['qqbot:9'])
    await step(h, conversation, '还在吗')
    expect(warnings(h, 'owner memory block')).toHaveLength(1)
  })
})

describe('agent presets', () => {
  it('re-scopes a session whose preset is selected after it was created', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    setScopeRules(h, [{ match: 'preset:demo', scope: 'demo' }])
    const conversation = await h.conversation('sess-select', { agentPreset: 'standard' })
    expect(h.runtime.service.scopeFor(conversation.agent)).toMatchObject({ scope: OWNER_SCOPE, private: true })
    const rescope = vi.spyOn(h.runtime.capture, 'rescope')
    const injectorRescope = vi.spyOn(h.runtime.injector, 'rescope')

    h.ctx.emit('agent-preset/selected', conversation.session.id, 'demo')

    expect(h.runtime.service.scopeFor(conversation.agent)).toMatchObject({ scope: 'demo', private: false })
    expect(rescope).toHaveBeenCalledWith('sess-select')
    expect(injectorRescope).toHaveBeenCalledWith('sess-select')
  })

  it('reads the preset a session runs from the preset registry, not the creation header', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    setScopeRules(h, [{ match: 'preset:demo', scope: 'demo' }])
    h.ctx.provide('agentPresets', { presetForSession: (session: { id: string }) => session.id === 'sess-switched' ? 'demo' : 'standard' })
    const switched = await h.conversation('sess-switched', { agentPreset: 'standard' })
    const plain = await h.conversation('sess-plain', { agentPreset: 'standard' })
    expect(h.runtime.service.scopeFor(switched.agent).scope).toBe('demo')
    expect(h.runtime.service.scopeFor(plain.agent).scope).toBe(OWNER_SCOPE)
  })
})

describe('subagents', () => {
  it('resolve through the root session even when their own cwd and preset differ', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    setScopeRules(h, [{ match: 'cwd:/home/me/qq-rooms/*', scope: 'qq-$1' }])
    const room = await h.conversation('sess-room', { cwd: '/home/me/qq-rooms/family' })
    const child = await h.conversation('sess-room-child', { origin: 'subagent', parentSession: room.session.id, delegationDepth: 1, cwd: '/tmp/task', agentPreset: 'explore' })
    const grandchild = await h.conversation('sess-room-grandchild', { origin: 'subagent', parentSession: child.session.id, delegationDepth: 2 })
    expect(h.runtime.service.scopeFor(room.agent)).toMatchObject({ scope: 'qq-family', private: false })
    expect(h.runtime.service.scopeFor(child.agent)).toMatchObject({ scope: 'qq-family', capture: false, private: false })
    expect(h.runtime.service.scopeFor(grandchild.agent)).toMatchObject({ scope: 'qq-family', capture: false, private: false })
  })
})

describe('plugin reload', () => {
  it('keeps serving live agents and their bridge tags after the plugin restarts', async () => {
    const h = harness = await createHarness({ engine: 'memory' })
    setScopeRules(h, [{ match: 'qqbot:*', scope: 'qq-test' }])
    const tagged = await h.conversation('sess-reload-tagged')
    h.runtime.service.setSessionTags('sess-reload-tagged', ['qqbot:42'])
    const conversation = await chat(h, 'sess-reload')

    await h.reload()

    expect(h.runtime.service.scopeFor(tagged.agent).scope).toBe('qq-test')
    expect((await h.runtime.service.api.status('sess-reload')).agent).toMatchObject({ sessionId: 'sess-reload', scope: { scope: OWNER_SCOPE } })
    const result = await h.compaction!.compactNow(conversation.agent, new AbortController().signal)
    expect(result).not.toBeNull()
    expect(conversation.visible('compact-checkpoint')[0]).toContain('<memory-cloud>')
    expect((await h.runtime.service.api.status()).fallbacks).toEqual([])
  })
})

describe('rollup planning at start', () => {
  it('waits for the default model instead of planning against the fallback window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcb-int-'))
    try {
      const quota = (contextWindow: number, reservedOutputTokens: number) => resolveBudget({
        level: 3,
        overrides: {},
        capacity: { contextWindow, reservedOutputTokens },
        headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS,
        memoryShare: MEMORY_SHARE,
      }).quotas.distant
      const guessed = quota(FALLBACK_CONTEXT_WINDOW, 0)
      const real = quota(128 * 1024, 1024)
      const episodes = 10
      const gistTokens = Math.ceil((guessed + real) / 2 / episodes)
      expect(episodes * gistTokens).toBeGreaterThan(guessed)
      expect(episodes * gistTokens).toBeLessThan(real)
      await seedOldWeek(createFileMemoryStore({ root, clock: { now: () => Date.now() } }), episodes, gistTokens)

      let release!: () => void
      const h = harness = await createHarness({ engine: 'none', root, modelLookup: new Promise<void>((resolve) => { release = resolve }) })
      await h.runtime.runner.start()
      const rollupJobs = async () => (await h.runtime.store.readState()).queue.filter(job => job.kind === 'rollup')
      expect(await rollupJobs()).toEqual([])

      const plan = vi.spyOn(h.runtime.summaries, 'planRollups')
      release()
      await vi.waitFor(() => expect(plan).toHaveBeenCalled())
      expect(plan.mock.calls[0]?.[1]).toBe(real)
      expect(await rollupJobs()).toEqual([])
    } finally {
      await harness?.dispose()
      harness = undefined
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('idle consolidation after a compaction', () => {
  it('skips the idle compaction right after any compaction, whose effect the logged pressure may not show yet', async () => {
    const h = harness = await createHarness({ engine: 'memory' })
    const conversation = await chat(h, 'sess-compacted')
    h.meter.pressure.set('sess-compacted', { pressureTokens: 100_000, contextWindow: 128 * 1024 })
    const compactNow = vi.spyOn(h.compaction!, 'compactNow')
    conversation.session.append('compaction/end', { compactionId: 'c-1', turn: null } as never)

    h.ctx.emit('agent/status', { agent: conversation.agent, status: 'idle' })
    await sleep(40)
    expect(compactNow).not.toHaveBeenCalled()
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
