import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import type { EffectiveMode, ScopeDecision, ScopeId } from '../../src/contracts.ts'
import { createInjector, scanSurface, STALE_PACK_MS } from '../../src/inject/index.ts'
import { startsWithMemoryBlock } from '../../src/inject/injector.ts'
import { MEMORY_BLOCK_HEADER } from '../../src/pack/index.ts'
import type { Injector, PackedMemory, PackRequest } from '../../src/inject/index.ts'
import {
  deferred,
  type FakeAgent,
  FakeClock,
  fakeAgent,
  ownerScope,
  prompt,
  recordingLogger,
  runtimeContext,
  step,
} from './fakes.ts'

const BLOCK = '<memory-cloud>\n远期：2026-11-01 一起看了电影 #20261101-2000_aaaaaaaa_1\n</memory-cloud>'
const CHECKPOINT_BLOCK = `<memory-cloud>\n${MEMORY_BLOCK_HEADER}\n近期：刚才聊了天气 #20261123-0700_s1_1\n</memory-cloud>`
const groupScope = (scope = 'qq-group-1'): ScopeDecision => ({ scope: scope as ScopeId, capture: true, private: false, reason: 'test' })

interface Harness {
  readonly injector: Injector<FakeAgent>
  readonly pack: ReturnType<typeof vi.fn<(request: PackRequest<FakeAgent>) => Promise<PackedMemory | null>>>
  readonly logger: ReturnType<typeof recordingLogger>
  readonly clock: FakeClock
  mode: EffectiveMode
  capture: boolean
  decision?: ScopeDecision
}

function harness(options: {
  pack?: (request: PackRequest<FakeAgent>) => Promise<PackedMemory | null>
  mode?: EffectiveMode
  timeoutMs?: number
  maxSessions?: number
} = {}): Harness {
  const logger = recordingLogger()
  const clock = new FakeClock()
  let packs = 0
  const pack = vi.fn(options.pack ?? (async (request: PackRequest<FakeAgent>) => {
    packs += 1
    return { text: `${BLOCK}\n<!-- ${request.session.sessionId} #${packs} -->`, snapshotRef: `snapshots/${request.session.sessionId}-${request.atSeq}.md` }
  }))
  const h: Harness = {
    pack,
    logger,
    clock,
    mode: options.mode ?? 'assist',
    capture: true,
    injector: undefined as unknown as Injector<FakeAgent>,
  }
  const injector = createInjector<FakeAgent>({
    pack,
    mode: () => h.mode,
    scopeFor: () => h.decision ?? ownerScope(h.capture),
    clock,
    logger,
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ...options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions },
  })
  return Object.assign(h, { injector })
}

function entered(decision: PreStepDecision): UserMessage[] {
  if (decision.kind !== 'enter') throw new Error(`expected an enter decision, got ${decision.kind}`)
  return decision.messages
}

function memoryIn(messages: readonly UserMessage[]): UserMessage[] {
  return messages.filter(message => message.source.kind === 'memory-cloud')
}

function textOf(message: UserMessage | undefined): string {
  const block = message?.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('createInjector', () => {
  it('injects one frozen recall message after the claimed batch on the first step', async () => {
    const h = harness()
    const agent = fakeAgent('s1')
    const first = prompt('你好')
    const context = runtimeContext()
    const decision = await step(h.injector, agent, { turn: 1, step: 1, claimed: [first], context })

    const messages = entered(decision)
    expect(messages).toHaveLength(3)
    expect(messages[0]).toBe(first)
    expect(messages[2]).toBe(context)
    const memory = messages[1]
    expect(memory?.role).toBe('user')
    expect(memory?.source).toEqual({ kind: 'memory-cloud', form: 'recall' })
    expect(textOf(memory)).toContain('<memory-cloud>')
    expect(Object.isFrozen(memory)).toBe(true)

    expect(h.pack).toHaveBeenCalledTimes(1)
    const request = h.pack.mock.calls[0]?.[0]
    expect(request).toMatchObject({ reason: 'session-start', mode: 'assist', atSeq: 1, session: { sessionId: 's1' }, scope: { capture: true } })
    expect(request?.agent).toBe(agent)
    expect(request?.signal).toBeInstanceOf(AbortSignal)
    expect(h.injector.frozen('s1')?.text).toBe(textOf(memory))
    expect(h.logger.lines.some(line => line.level === 'info' && line.text.includes('s1'))).toBe(true)
  })

  it('preserves other decision fields such as startsRequestSeries', async () => {
    const h = harness()
    const agent = fakeAgent('s1')
    const claimed = [prompt('hi')]
    const decision = await step(h.injector, agent, {
      turn: 1,
      step: 1,
      claimed,
      inner: { kind: 'enter', messages: claimed, startsRequestSeries: true },
    })
    expect(decision).toMatchObject({ kind: 'enter', startsRequestSeries: true })
    expect(memoryIn(entered(decision))).toHaveLength(1)
  })

  it('does not inject twice while the block is visible', async () => {
    const h = harness()
    const agent = fakeAgent('s1')
    await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    const continuation = await step(h.injector, agent, { turn: 1, step: 2, context: runtimeContext() })
    const nextTurn = await step(h.injector, agent, { turn: 2, step: 3, claimed: [prompt('b')] })

    for (const decision of [continuation, nextTurn]) {
      expect(memoryIn(entered(decision))).toHaveLength(0)
    }
    expect(agent.session.memoryMessages()).toHaveLength(1)
    expect(h.pack).toHaveBeenCalledTimes(1)
  })

  it('does not add a second block when an inner listener already entered one', async () => {
    const h = harness()
    const agent = fakeAgent('s1')
    const claimed = [prompt('a')]
    const existing: UserMessage = { ...prompt(BLOCK), source: { kind: 'memory-cloud', form: 'recall' } }
    const decision = await step(h.injector, agent, { turn: 1, step: 1, claimed, inner: { kind: 'enter', messages: [...claimed, existing] } })
    expect(memoryIn(entered(decision))).toEqual([existing])
    expect(h.pack).not.toHaveBeenCalled()
  })

  it('reuses the identical frozen text when the block went missing without a compaction', async () => {
    const h = harness()
    const agent = fakeAgent('s1')
    const first = await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')], drop: true })
    const second = await step(h.injector, agent, { turn: 2, step: 1, claimed: [prompt('b')] })

    const a = memoryIn(entered(first))[0]
    const b = memoryIn(entered(second))[0]
    expect(a).toBeDefined()
    expect(textOf(b)).toBe(textOf(a))
    expect(b?.id).not.toBe(a?.id)
    expect(h.pack).toHaveBeenCalledTimes(1)
  })

  it('freezes per session', async () => {
    const h = harness()
    const one = fakeAgent('s1')
    const two = fakeAgent('s2')
    const a = await step(h.injector, one, { turn: 1, step: 1, claimed: [prompt('a')] })
    const b = await step(h.injector, two, { turn: 1, step: 1, claimed: [prompt('b')] })
    expect(h.pack).toHaveBeenCalledTimes(2)
    expect(textOf(memoryIn(entered(a))[0])).toContain('s1')
    expect(textOf(memoryIn(entered(b))[0])).toContain('s2')
  })

  it('refills a refreshed block after a compaction shadowed it in assist mode', async () => {
    const h = harness()
    const agent = fakeAgent('s1')
    const first = await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    agent.session.compact('Host summary of the earlier conversation.')
    expect(agent.session.memoryMessages()).toHaveLength(0)

    const refill = await step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    expect(h.pack).toHaveBeenCalledTimes(2)
    expect(h.pack.mock.calls[1]?.[0]).toMatchObject({ reason: 'refill', mode: 'assist' })
    const refilled = memoryIn(entered(refill))
    expect(refilled).toHaveLength(1)
    expect(textOf(refilled[0])).not.toBe(textOf(memoryIn(entered(first))[0]))
    expect(agent.session.memoryMessages()).toHaveLength(1)

    const after = await step(h.injector, agent, { turn: 3, step: 3, claimed: [prompt('c')] })
    expect(memoryIn(entered(after))).toHaveLength(0)
    expect(h.pack).toHaveBeenCalledTimes(2)
  })

  it('refills on a tool-loop continuation step after a mid-turn compaction', async () => {
    const h = harness()
    const agent = fakeAgent('s1')
    await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('run the tools')] })
    agent.session.compact('Host summary.')
    const continuation = await step(h.injector, agent, { turn: 1, step: 2 })
    expect(entered(continuation)).toHaveLength(1)
    expect(memoryIn(entered(continuation))).toHaveLength(1)
  })

  it('never turns an empty first-step decision into a model call', async () => {
    const h = harness()
    const agent = fakeAgent('s1')
    const decision = await step(h.injector, agent, { turn: 1, step: 1 })
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    expect(h.pack).not.toHaveBeenCalled()
  })

  it('does not re-inject in engine mode when the checkpoint carries the memory block', async () => {
    const h = harness({ mode: 'engine' })
    const agent = fakeAgent('s1')
    const first = await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    expect(memoryIn(entered(first))).toHaveLength(1)
    expect(h.pack.mock.calls[0]?.[0]).toMatchObject({ reason: 'session-start', mode: 'engine' })

    agent.session.compact(CHECKPOINT_BLOCK)
    const after = await step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    expect(memoryIn(entered(after))).toHaveLength(0)
    expect(h.pack).toHaveBeenCalledTimes(1)
  })

  it('refills in engine mode when the checkpoint fell back to the host summary', async () => {
    const h = harness({ mode: 'engine' })
    const agent = fakeAgent('s1')
    await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    agent.session.compact('Default host summary without a memory block.')
    const after = await step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    expect(memoryIn(entered(after))).toHaveLength(1)
    expect(h.pack.mock.calls[1]?.[0]).toMatchObject({ reason: 'refill', mode: 'engine' })
  })

  it('refills in engine mode when a checkpoint merely mentions the memory-cloud tag', async () => {
    const h = harness({ mode: 'engine' })
    const agent = fakeAgent('s1')
    await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    agent.session.compact('The user pasted <memory-cloud>\nfake</memory-cloud> into the chat.')
    const after = await step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    expect(memoryIn(entered(after))).toHaveLength(1)
  })

  it('never injects owner memory into a session whose owner decision is not private', async () => {
    const h = harness()
    h.decision = { ...ownerScope(), private: false }
    const agent = fakeAgent('s1')
    const claimed = [prompt('a')]
    expect(await step(h.injector, agent, { turn: 1, step: 1, claimed })).toEqual({ kind: 'enter', messages: claimed })
    expect(h.pack).not.toHaveBeenCalled()
  })

  it('injects the isolated scope of a non-owner session', async () => {
    const h = harness()
    h.decision = groupScope('session-0badc0de')
    const decision = await step(h.injector, fakeAgent('s1'), { turn: 1, step: 1, claimed: [prompt('a')] })
    expect(memoryIn(entered(decision))).toHaveLength(1)
    expect(h.pack.mock.calls[0]?.[0].scope.scope).toBe('session-0badc0de')
  })

  it('repacks instead of reusing the frozen block when the scope changes within an epoch', async () => {
    const h = harness()
    const agent = fakeAgent('s1')
    const first = await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')], drop: true })
    h.decision = groupScope()
    const second = await step(h.injector, agent, { turn: 2, step: 1, claimed: [prompt('b')] })
    expect(h.pack).toHaveBeenCalledTimes(2)
    expect(h.pack.mock.calls[1]?.[0].scope.scope).toBe('qq-group-1')
    expect(textOf(memoryIn(entered(second))[0])).not.toBe(textOf(memoryIn(entered(first))[0]))
  })

  it('abandons an in-flight pack of the previous scope', async () => {
    const slow = deferred<PackedMemory | null>()
    let calls = 0
    const h = harness({ pack: () => (++calls === 1 ? slow.promise : Promise.resolve({ text: 'group block' })), timeoutMs: 10 })
    const agent = fakeAgent('s1')
    await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    const ownerSignal = h.pack.mock.calls[0]?.[0].signal
    h.decision = groupScope()
    const decision = await step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    expect(ownerSignal?.aborted).toBe(true)
    expect(textOf(memoryIn(entered(decision))[0])).toBe('group block')
    slow.resolve({ text: BLOCK })
    await slow.promise
    expect(h.injector.frozen('s1')?.text).toBe('group block')
  })

  it('warns once when an owner block is still visible after the scope changed', async () => {
    const h = harness()
    const agent = fakeAgent('s1')
    await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    h.decision = groupScope()
    const after = await step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    await step(h.injector, agent, { turn: 3, step: 3, claimed: [prompt('c')] })
    expect(memoryIn(entered(after))).toHaveLength(0)
    expect(h.pack).toHaveBeenCalledTimes(1)
    const warnings = h.logger.lines.filter(line => line.level === 'warn' && line.text.includes('owner memory block'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.text).toContain('qq-group-1')
  })

  it('fails open and logs when packing rejects, then retries on a later step', async () => {
    let fail = true
    const h = harness({
      pack: async () => {
        if (fail) throw new Error('index unreadable')
        return { text: BLOCK }
      },
    })
    const agent = fakeAgent('s1')
    const claimed = [prompt('a')]
    const decision = await step(h.injector, agent, { turn: 1, step: 1, claimed })
    expect(decision).toEqual({ kind: 'enter', messages: claimed })
    expect(h.logger.lines.some(line => line.level === 'warn' && line.text.includes('index unreadable'))).toBe(true)

    fail = false
    const retry = await step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    expect(memoryIn(entered(retry))).toHaveLength(1)
    expect(h.pack).toHaveBeenCalledTimes(2)
  })

  it('fails open on timeout and uses the late result on the next step without repacking', async () => {
    const slow = deferred<PackedMemory | null>()
    const h = harness({ pack: () => slow.promise, timeoutMs: 20 })
    const agent = fakeAgent('s1')
    const claimed = [prompt('a')]
    const started = performance.now()
    const decision = await step(h.injector, agent, { turn: 1, step: 1, claimed })
    expect(performance.now() - started).toBeLessThan(1000)
    expect(decision).toEqual({ kind: 'enter', messages: claimed })
    expect(h.logger.lines.some(line => line.level === 'warn' && line.text.includes('exceeded 20 ms'))).toBe(true)

    slow.resolve({ text: BLOCK, snapshotRef: 'snapshots/s1-1.md' })
    await slow.promise
    await Promise.resolve()
    const next = await step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    expect(textOf(memoryIn(entered(next))[0])).toBe(BLOCK)
    expect(h.pack).toHaveBeenCalledTimes(1)
  })

  it('joins a pending pack instead of starting another one', async () => {
    const slow = deferred<PackedMemory | null>()
    const h = harness({ pack: () => slow.promise, timeoutMs: 10 })
    const agent = fakeAgent('s1')
    await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    const pending = step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    slow.resolve({ text: BLOCK })
    const decision = await pending
    expect(memoryIn(entered(decision))).toHaveLength(1)
    expect(h.pack).toHaveBeenCalledTimes(1)
  })

  it('replaces a pack that never settles once it is stale', async () => {
    const hung = deferred<PackedMemory | null>()
    let calls = 0
    const h = harness({ pack: () => (++calls === 1 ? hung.promise : Promise.resolve({ text: BLOCK })), timeoutMs: 10 })
    const agent = fakeAgent('s1')
    await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    const firstSignal = h.pack.mock.calls[0]?.[0].signal
    h.clock.current += STALE_PACK_MS + 1
    const decision = await step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    expect(memoryIn(entered(decision))).toHaveLength(1)
    expect(h.pack).toHaveBeenCalledTimes(2)
    expect(firstSignal?.aborted).toBe(true)
  })

  it('caches an empty result for the epoch instead of repacking every step', async () => {
    const h = harness({ pack: async () => null })
    const agent = fakeAgent('s1')
    await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    await step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    expect(h.pack).toHaveBeenCalledTimes(1)
    expect(agent.session.memoryMessages()).toHaveLength(0)
    expect(h.injector.frozen('s1')).toBeUndefined()
  })

  it('skips subagent sessions', async () => {
    const h = harness()
    const agent = fakeAgent('child', { origin: 'subagent', parentSession: 's1', delegationDepth: 1 })
    const claimed = [prompt('task')]
    expect(await step(h.injector, agent, { turn: 1, step: 1, claimed })).toEqual({ kind: 'enter', messages: claimed })
    expect(h.pack).not.toHaveBeenCalled()
  })

  it('skips mode off and sessions whose scope does not capture', async () => {
    const h = harness({ mode: 'off' })
    const agent = fakeAgent('s1')
    await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    h.mode = 'assist'
    h.capture = false
    await step(h.injector, agent, { turn: 2, step: 2, claimed: [prompt('b')] })
    expect(h.pack).not.toHaveBeenCalled()
    expect(agent.session.memoryMessages()).toHaveLength(0)
  })

  it('passes rejections and aborted steps through untouched', async () => {
    const h = harness()
    const agent = fakeAgent('s1')
    expect(await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')], inner: { kind: 'reject' } })).toEqual({ kind: 'reject' })
    const aborted = new AbortController()
    aborted.abort()
    const claimed = [prompt('b')]
    expect(await step(h.injector, agent, { turn: 2, step: 1, claimed, signal: aborted.signal })).toEqual({ kind: 'enter', messages: claimed })
    expect(h.pack).not.toHaveBeenCalled()
  })

  it('fails open when the scope resolver throws', async () => {
    const logger = recordingLogger()
    const injector = createInjector<FakeAgent>({
      pack: async () => ({ text: BLOCK }),
      mode: () => 'assist',
      scopeFor: () => {
        throw new Error('bad rule')
      },
      clock: new FakeClock(),
      logger,
    })
    const claimed = [prompt('a')]
    expect(await step(injector, fakeAgent('s1'), { turn: 1, step: 1, claimed })).toEqual({ kind: 'enter', messages: claimed })
    expect(logger.lines.some(line => line.level === 'warn' && line.text.includes('bad rule'))).toBe(true)
  })

  it('forget drops the frozen text and aborts a pending pack', async () => {
    const slow = deferred<PackedMemory | null>()
    const h = harness({ pack: () => slow.promise, timeoutMs: 10 })
    const agent = fakeAgent('s1')
    await step(h.injector, agent, { turn: 1, step: 1, claimed: [prompt('a')] })
    const signal = h.pack.mock.calls[0]?.[0].signal
    h.injector.forget('s1')
    expect(signal?.aborted).toBe(true)
    slow.resolve({ text: BLOCK })
    await slow.promise
    expect(h.injector.frozen('s1')).toBeUndefined()
  })

  it('evicts the least recently used session beyond maxSessions', async () => {
    const h = harness({ maxSessions: 1 })
    const one = fakeAgent('s1')
    await step(h.injector, one, { turn: 1, step: 1, claimed: [prompt('a')], drop: true })
    await step(h.injector, fakeAgent('s2'), { turn: 1, step: 1, claimed: [prompt('b')] })
    expect(h.injector.frozen('s1')).toBeUndefined()
    expect(h.injector.frozen('s2')).toBeDefined()
  })
})

describe('scanSurface', () => {
  it('reports the newest visible checkpoint as the epoch', () => {
    const agent = fakeAgent('s1')
    expect(scanSurface(agent.session)).toEqual({ hasMemoryBlock: false, memoryCheckpoint: false, epoch: undefined })
    agent.session.appendMessage(prompt('a'))
    agent.session.appendLogOnly('turn/end')
    const first = agent.session.compact('summary one')
    expect(scanSurface(agent.session)).toEqual({ hasMemoryBlock: false, memoryCheckpoint: false, epoch: first })
    agent.session.appendMessage(prompt('b'))
    const second = agent.session.compact(CHECKPOINT_BLOCK)
    expect(scanSurface(agent.session)).toEqual({ hasMemoryBlock: false, memoryCheckpoint: true, epoch: second })
  })

  it('counts a checkpoint only when its body starts with our exact opening', () => {
    const agent = fakeAgent('s1')
    agent.session.compact('<memory-cloud scope="owner">x</memory-cloud>')
    expect(scanSurface(agent.session).memoryCheckpoint).toBe(false)
    agent.session.compact(`Earlier notes.\n${CHECKPOINT_BLOCK}`)
    expect(scanSurface(agent.session).memoryCheckpoint).toBe(false)
    agent.session.compact(`\n${CHECKPOINT_BLOCK}`)
    expect(scanSurface(agent.session).memoryCheckpoint).toBe(true)
  })

  it('recognises our opening at the start of a bare or wrapped body only', () => {
    expect(startsWithMemoryBlock(CHECKPOINT_BLOCK)).toBe(true)
    expect(startsWithMemoryBlock(`Preamble.\n\n<compacted-summary>${CHECKPOINT_BLOCK}</compacted-summary>`)).toBe(true)
    expect(startsWithMemoryBlock(`<compacted-summary>Summary quoting ${CHECKPOINT_BLOCK}</compacted-summary>`)).toBe(false)
    expect(startsWithMemoryBlock('<memory-cloud>\nno header')).toBe(false)
    expect(startsWithMemoryBlock(`<memory-cloud >\n${MEMORY_BLOCK_HEADER}`)).toBe(false)
  })

  it('ignores memory-cloud text outside checkpoints and detects our source kind', () => {
    const agent = fakeAgent('s1')
    agent.session.appendMessage(prompt('<memory-cloud> pasted by the user'))
    expect(scanSurface(agent.session).hasMemoryBlock).toBe(false)
    agent.session.appendMessage({ ...prompt(BLOCK), source: { kind: 'memory-cloud', form: 'recall' } })
    expect(scanSurface(agent.session).hasMemoryBlock).toBe(true)
  })
})
