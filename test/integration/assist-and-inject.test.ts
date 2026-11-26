import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { EpisodeSummaryResult, MemoryStore, ScopeId } from '../../src/contracts.ts'
import { MEMORY_SOURCE_KIND, OWNER_SCOPE, SUMMARIZE_PURPOSE, TOOL_NAMES } from '../../src/contracts.ts'
import { isEngineHost, MEMORY_CLOUD_SERVICE } from '../../src/engine/index.ts'
import * as plugin from '../../src/index.ts'
import { MEMORY_BLOCK_HEADINGS } from '../../src/pack/index.ts'
import { createHarness, createMeter, longText, MODEL, PROVIDER, ScriptedAdapter, summaryReply, userMessage } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const DAY = 86_400_000
const BASE = Date.UTC(2026, 9, 1, 2)

function memoryTexts(messages: readonly UserMessage[]): string[] {
  return messages
    .filter(message => message.source.kind === MEMORY_SOURCE_KIND)
    .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

async function seedEpisode(store: MemoryStore, scope: ScopeId, index: number, summaryChars: number): Promise<void> {
  const startedAt = BASE + index * DAY
  const meta = await store.openEpisode(scope, { sessionId: `old-session-${index}`, startedAt, firstSeq: 1 })
  await store.appendRaw(scope, meta.id, [
    { seq: 1, time: startedAt, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: `第 ${index} 次聊天` }], source: { kind: 'user' } } },
    { seq: 2, time: startedAt + 1000, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } },
  ])
  await store.sealEpisode(scope, meta.id, { reason: 'end', endedAt: startedAt + 1000, lastSeq: 2, rawTokens: 20 })
  const result: EpisodeSummaryResult = {
    gist: `总结${index}：聊了第 ${index} 件事。`,
    summary: `摘要${index}：${'细节'.repeat(Math.max(1, Math.floor(summaryChars / 2)))}`,
    ongoing: [],
    importance: 5,
    keywords: [`事件${index}`],
    people: [],
    dates: [],
    promises: [],
  }
  await store.writeSummary(scope, meta.id, result, { provider: PROVIDER, model: MODEL, promptVersion: 'test', summarizedAt: startedAt + 2000 }, { summary: 0, gist: 0 })
}

describe('assist mode', () => {
  it('summarizes a host compaction in the background and refills the memory block on the next pre-step', async () => {
    const h = harness = await createHarness({
      engine: 'basic',
      responder: call => call.purpose === SUMMARIZE_PURPOSE ? summaryReply() : 'DSH host checkpoint summary.',
    })
    const conversation = await h.conversation('sess-assist-1')
    expect(h.runtime.modes.modeFor(conversation.agent)).toMatchObject({ mode: 'assist', engineActive: false })

    const opening = await h.preStep(conversation.agent, [userMessage('你好')])
    expect(memoryTexts(opening.kind === 'enter' ? opening.messages : [])).toEqual([])
    await h.tool(TOOL_NAMES.note, { action: 'add', text: '用户偏好公制单位。' }, conversation.agent)

    conversation.route()
    for (let turn = 0; turn < 3; turn++) conversation.exchange(longText(`用户 ${turn}`, 800), longText(`助手 ${turn}`, 800))
    await h.runtime.capture.flush()

    const result = await h.compaction!.compactNow(conversation.agent, new AbortController().signal)
    expect(result).not.toBeNull()
    const [checkpoint] = conversation.visible('compact-checkpoint')
    expect(checkpoint).toContain('DSH host checkpoint summary.')
    expect(checkpoint).not.toContain('<memory-cloud')

    await h.settle()
    const sealed = (await h.runtime.store.readIndex(OWNER_SCOPE)).episodes.find(meta => meta.sealReason === 'compaction')
    expect(sealed).toMatchObject({ status: 'summarized' })
    const summaryCalls = h.adapter.callsFor(SUMMARIZE_PURPOSE)
    expect(summaryCalls).toHaveLength(1)
    expect(summaryCalls[0]).toMatchObject({ provider: PROVIDER, model: MODEL })
    expect(summaryCalls[0]?.sessionId).toBeUndefined()
    expect(JSON.stringify(summaryCalls[0]?.messages)).toContain('用户 0')

    const claimed = userMessage('还记得我周末要去哪吗？')
    const decision = await h.preStep(conversation.agent, [claimed])
    expect(decision.kind).toBe('enter')
    const messages = decision.kind === 'enter' ? decision.messages : []
    const [block, ...more] = memoryTexts(messages)
    expect(more).toEqual([])
    expect(block).toContain('<memory-cloud>')
    expect(block).toContain('楼外楼的醋鱼')
    expect(block).toContain('用户偏好公制单位。')
    expect(block).toContain(`#${sealed!.id}`)
    expect(messages[0]).toBe(claimed)
    expect(messages[1]?.source.kind).toBe(MEMORY_SOURCE_KIND)
  })
})

describe('session-start injection', () => {
  it('injects distant gists and recent summaries from earlier sessions', async () => {
    const h = harness = await createHarness({ engine: 'none', level: 5 })
    for (let index = 0; index < 8; index++) await seedEpisode(h.runtime.store, OWNER_SCOPE, index, 1500)

    const conversation = await h.conversation('sess-new-1')
    conversation.route()
    const decision = await h.preStep(conversation.agent, [userMessage('早上好')])
    const [block] = memoryTexts(decision.kind === 'enter' ? decision.messages : [])

    expect(block).toBeDefined()
    expect(block).toContain('摘要7：')
    expect(block).toContain('摘要6：')
    expect(block).not.toContain('摘要0：')
    expect(block).toContain('总结0：')
    expect(block!.indexOf(MEMORY_BLOCK_HEADINGS.distant)).toBeLessThan(block!.indexOf(MEMORY_BLOCK_HEADINGS.recent))
    expect(block!.indexOf('总结0：')).toBeLessThan(block!.indexOf('总结1：'))

    const again = await h.preStep(conversation.agent, [userMessage('再说一句')])
    expect(memoryTexts(again.kind === 'enter' ? again.messages : [])).toEqual([block])
    const snapshots = await readdir(join(h.root, 'scopes', 'owner', 'snapshots'))
    expect(snapshots.filter(name => name.startsWith('sess-new-1-'))).toHaveLength(1)
  })

  it('keeps an owner note frozen until a fresh pack and preserves the hand-written profile', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    const ownerDir = join(h.root, 'scopes', 'owner')
    await mkdir(ownerDir, { recursive: true })
    const manual = 'Use the name 林.\n'
    await writeFile(join(ownerDir, 'profile.md'), manual)
    const first = await h.conversation('note-first')
    const original = 'Prefers temperature in Fahrenheit.'
    const updated = 'Prefers temperature in Celsius.'
    await h.tool(TOOL_NAMES.note, { action: 'add', text: original }, first.agent)

    const blockFor = async (agent: Agent) => {
      const step = await h.preStep(agent, [userMessage('你好')])
      return memoryTexts(step.kind === 'enter' ? step.messages : []).join('\n')
    }
    const frozen = await blockFor(first.agent)
    expect(frozen).toContain(manual.trim())
    expect(frozen).toContain(original)
    await h.tool(TOOL_NAMES.note, { action: 'replace', oldText: original, text: updated }, first.agent)
    expect(await blockFor(first.agent)).toBe(frozen)
    const next = await h.conversation('note-next')
    const refreshed = await blockFor(next.agent)
    expect(refreshed).toContain(updated)
    expect(refreshed).not.toContain(original)

    await h.tool(TOOL_NAMES.note, { action: 'remove', oldText: updated }, next.agent)
    const afterRemoval = await blockFor((await h.conversation('note-removed')).agent)
    expect(afterRemoval).not.toContain(updated)
    expect(afterRemoval).toContain(manual.trim())
    expect(await readFile(join(ownerDir, 'profile.md'), 'utf8')).toBe(manual)
    expect(h.adapter.calls).toHaveLength(0)
  })

  it('can still pack earlier episodes when the owner notes file is damaged', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    await seedEpisode(h.runtime.store, OWNER_SCOPE, 0, 100)
    const file = join(h.root, 'scopes', 'owner', 'profile-notes.json')
    await writeFile(file, '{invalid')
    const { agent } = await h.conversation('note-recovery')
    const step = await h.preStep(agent, [userMessage('你好')])
    expect(memoryTexts(step.kind === 'enter' ? step.messages : []).join('\n')).toContain('摘要0')
    await expect(h.tool(TOOL_NAMES.note, { action: 'add', text: 'Prefers short answers.' }, agent)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{invalid')
  })

  it('never injects owner memories into a session mapped to another scope', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    for (let index = 0; index < 3; index++) await seedEpisode(h.runtime.store, OWNER_SCOPE, index, 100)
    const owner = await h.conversation('note-owner')
    await h.tool(TOOL_NAMES.note, { action: 'add', text: 'Prefers Celsius.' }, owner.agent)
    h.runtime.service.setSessionTags('sess-group-1', ['qqbot:bot1:group:42'])
    ;(h.config.scopeRules as unknown as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]?.([{ match: 'qqbot:*:group:*', scope: 'qq-group-$2' }])

    const conversation = await h.conversation('sess-group-1')
    const decision = await h.preStep(conversation.agent, [userMessage('大家好')])
    expect(memoryTexts(decision.kind === 'enter' ? decision.messages : [])).toEqual([])
    expect(h.runtime.service.scopeFor(conversation.agent)).toMatchObject({ scope: 'qq-group-42', private: false })
    await expect(h.tool(TOOL_NAMES.note, { action: 'list' }, conversation.agent)).rejects.toThrow()
    await expect(h.tool('memory_search', { query: '聊了' }, conversation.agent)).resolves.toMatchObject({ total: 0 })
  })
})

describe('compression level', () => {
  it('shrinks the injected block when /memory level raises the level', async () => {
    const h = harness = await createHarness({ engine: 'none', level: 1 })
    for (let index = 0; index < 24; index++) await seedEpisode(h.runtime.store, OWNER_SCOPE, index, 600)

    const first = await h.conversation('sess-level-1')
    first.route()
    const before = memoryTexts((await h.preStep(first.agent, [userMessage('hi')]) as { messages: UserMessage[] }).messages)[0]
    const budgetBefore = await h.runtime.budgets.budgetFor(first.agent)

    const command = await h.command(first.agent, '/memory level 5')
    expect(command).toMatchObject({ kind: 'success' })
    expect(h.config.level.get()).toBe(5)

    const second = await h.conversation('sess-level-2')
    second.route()
    const after = memoryTexts((await h.preStep(second.agent, [userMessage('hi')]) as { messages: UserMessage[] }).messages)[0]
    const budgetAfter = await h.runtime.budgets.budgetFor(second.agent)

    expect(budgetAfter.memoryBudgetTokens).toBeLessThan(budgetBefore.memoryBudgetTokens)
    expect(budgetAfter.thresholdTokens).toBeLessThan(budgetBefore.thresholdTokens)
    expect(before).toBeDefined()
    expect(after).toBeDefined()
    expect(after!.length).toBeLessThan(before!.length)
    expect(h.runtime.budgets.budgetNow(second.agent).recallLimitTokens).toBe(budgetAfter.recallLimitTokens)

    const status = await h.command(second.agent, '/memory status')
    expect(status.text).toContain('档位：5')
    await expect(h.command(second.agent, '/memory level 9')).resolves.toMatchObject({ kind: 'error' })
  })
})

describe('plugin entry', () => {
  it('loads through ctx.plugin, provides the memoryCloud service, and survives a tool-name clash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcb-entry-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolsService)
      await ctx.plugin(CommandRuntime)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter(() => 'unused', 128 * 1024))
      ctx.provide('tokenMeter', createMeter().service)
      const exclusions: ((request: { purpose?: string }) => boolean)[] = []
      ctx.provide('sessionLogDeepSeek', { registerExclusion: (exclude: (request: { purpose?: string }) => boolean) => { exclusions.push(exclude); return () => {} } })
      ctx.tools.register(defineTool({
        name: TOOL_NAMES.read,
        description: 'Another memory plugin',
        parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
        execute: async () => ({}),
      }))

      const fiber = await ctx.plugin(plugin, { storageRoot: root })
      const service = ctx.get(MEMORY_CLOUD_SERVICE)
      expect(isEngineHost(service)).toBe(true)
      expect(exclusions).toHaveLength(1)
      expect(exclusions[0]?.({ purpose: SUMMARIZE_PURPOSE })).toBe(true)
      expect(exclusions[0]?.({ purpose: 'compaction' })).toBe(false)
      expect(exclusions[0]?.({})).toBe(false)

      const session = ctx.sessions.create(SessionId('sess-entry-1'))
      const agent = { session, options: { provider: PROVIDER, model: MODEL }, ctx } as unknown as Agent
      expect(ctx.commands.list(agent).map(command => command.name)).toContain('memory')
      const status = await (service as typeof ctx.memoryCloud).api.status()
      expect(status.registrations).toMatchObject({ tools: false, command: true })
      expect(status.registrations.problems[0]).toContain('memory_read')
      expect(status.storageRoot).toBe(root)
      const execution = await ctx.commands.execute(agent, '/memory status', [], new AbortController().signal)
      expect(execution?.result.kind).toBe('success')
      expect(execution?.result.text).toContain('回忆工具：未注册')

      await fiber.dispose()
      expect(ctx.get(MEMORY_CLOUD_SERVICE)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
