import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { EVENT_MEMORY_SOURCE_KIND, MEMORY_SOURCE_KIND, OWNER_SCOPE, TOOL_NAMES } from '../../src/contracts.ts'
import { createTokenEstimator } from '../../src/pack/index.ts'
import { createHarness, MODEL, PROVIDER, userMessage, type Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const subject = '海棠上线日期'
const query = '海棠什么时候上线？'
const prior = '确定为十二月十二日。'
const latest = '改到十二月十九日。'

async function admitted(h: Harness, agent: Agent, messages: UserMessage[], turn = 1) {
  const step = await h.preStep(agent, messages, turn)
  if (step.kind !== 'enter') throw new Error('Step was not admitted')
  return step.messages
}

function eventTexts(messages: readonly UserMessage[]): string[] {
  return messages.filter(message => message.source.kind === EVENT_MEMORY_SOURCE_KIND)
    .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

function save(h: Harness, agent: Agent, text: string, expectedRevision: number) {
  return h.tool<{ revision: number }>(TOOL_NAMES.event, { action: 'save', subject, text, expectedRevision }, agent)
}

describe('scoped event memory through registered tools and the DSH pre-step', () => {
  it.each(['basic', 'memory'] as const)('sends the latest fact to the adapter on a related later turn with the %s engine', async engine => {
    const h = harness = await createHarness({ engine })
    const writer = await h.conversation('writer')
    const first = await save(h, writer.agent, prior, 0)
    const found = await h.tool<{ entries: { revision: number }[] }>(TOOL_NAMES.event, { action: 'find', query: subject }, writer.agent)
    expect(found.entries).toMatchObject([{ revision: first.revision }])
    const revision = await save(h, writer.agent, latest, found.entries[0]!.revision)
    await expect(save(h, writer.agent, '旧窗口的修改', first.revision)).rejects.toThrow()
    await h.tool(TOOL_NAMES.note, { action: 'add', text: '用户偏好摄氏度。' }, writer.agent)
    await h.reload()

    const reader = await h.conversation('reader')
    reader.route()
    const opening = await admitted(h, reader.agent, [userMessage('早上好')])
    expect(eventTexts(opening)).toEqual([])
    expect(opening.some(message => message.source.kind === MEMORY_SOURCE_KIND)).toBe(true)
    for (const message of opening) reader.session.append('user/message', message, { surfaceOp: 'append' })

    const relevant = await admitted(h, reader.agent, [userMessage(query)], 2)
    expect(eventTexts(relevant)).toHaveLength(1)
    expect(eventTexts(relevant)[0]).toContain(latest)
    for (const message of relevant) reader.session.append('user/message', message, { surfaceOp: 'append' })
    expect(h.adapter.calls).toHaveLength(0)
    let lastChunk: string | undefined
    for await (const chunk of h.ctx.llm.stream({ provider: PROVIDER, model: MODEL, messages: reader.session.deriveMessages() })) lastChunk = chunk.type
    expect(lastChunk).toBe('finish')
    const request = JSON.stringify(h.adapter.calls.at(-1)?.messages)
    expect(request).toContain(latest)
    expect(request).not.toContain(prior)
    expect(eventTexts(await admitted(h, reader.agent, [userMessage(query)], 3))).toEqual([])

    const newer = '已确定延期至一月六日。'
    const corrected = await save(h, writer.agent, newer, revision.revision)
    expect(eventTexts(await admitted(h, reader.agent, [userMessage(query)], 4))[0]).toContain(newer)
    await h.tool(TOOL_NAMES.event, { action: 'remove', subject, expectedRevision: corrected.revision }, writer.agent)
    const empty = await h.conversation('after-removal')
    expect(eventTexts(await admitted(h, empty.agent, [userMessage(query)]))).toEqual([])

    await h.runtime.capture.flush()
    const index = await h.runtime.store.readIndex(OWNER_SCOPE)
    const episode = index.episodes.find(item => item.sessionId === reader.session.id)!
    const raw = await h.runtime.store.readRaw(OWNER_SCOPE, episode.id, { offset: 0, limit: 100 })
    expect(JSON.stringify(raw.records)).toContain(query)
    expect(raw.records.some(record => record.type === 'user/message' && (record.data as UserMessage).source?.kind === EVENT_MEMORY_SOURCE_KIND)).toBe(false)
  })

  it('keeps owner and room decisions separate, including when both have the same subject and revision', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    const rules = h.config.scopeRules as unknown as Record<symbol, (value: unknown) => void>
    rules[Symbol.for('cosmokit.volatile.write')]!([{ match: 'room:*', scope: 'room-$1' }])
    const owner = await h.conversation('owner-1')
    await save(h, owner.agent, '主人会话里的日期', 0)
    const room = await h.conversation('room-1')
    h.runtime.service.setSessionTags(room.session.id, ['room:42'])
    expect(eventTexts(await admitted(h, room.agent, [userMessage(query)]))).toEqual([])
    await save(h, room.agent, '群内约定的日期', 0)
    const next = await h.conversation('room-2')
    h.runtime.service.setSessionTags(next.session.id, ['room:42'])
    const texts = eventTexts(await admitted(h, next.agent, [userMessage(query)]))
    expect(texts.join('')).toContain('群内约定的日期')
    expect(texts.join('')).not.toContain('主人会话里的日期')
    const child = await h.conversation('event-child', { origin: 'subagent', parentSession: SessionId('room-2') })
    expect(eventTexts(await admitted(h, child.agent, [userMessage(query)]))).toEqual([])
    await expect(save(h, child.agent, '子会话写入', 0)).rejects.toThrow()
  })

  it('keeps the original transcript and treats an episode hide and a confirmed-event removal independently', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    const writer = await h.conversation('archive-and-event')
    writer.exchange(`确认${subject}，${prior}`, '收到')
    await h.runtime.capture.flush()
    const episode = (await h.runtime.store.readIndex(OWNER_SCOPE)).episodes.find(item => item.sessionId === writer.session.id)!
    const first = await save(h, writer.agent, prior, 0)
    const current = await save(h, writer.agent, latest, first.revision)
    await h.tool(TOOL_NAMES.hide, { id: episode.id }, writer.agent)
    const next = await h.conversation('hidden-archive')
    expect(eventTexts(await admitted(h, next.agent, [userMessage(query)]))[0]).toContain(latest)
    await expect(h.tool(TOOL_NAMES.read, { id: episode.id, level: 'raw' }, next.agent)).rejects.toThrow()
    await h.tool(TOOL_NAMES.event, { action: 'remove', subject, expectedRevision: current.revision }, writer.agent)
    await h.tool(TOOL_NAMES.unhide, { id: episode.id }, writer.agent)
    const raw = await h.tool<{ text: string }>(TOOL_NAMES.read, { id: episode.id, level: 'raw' }, next.agent)
    expect(raw.text).toContain(prior)
    expect(eventTexts(await admitted(h, next.agent, [userMessage(query)], 2))).toEqual([])
  })

  it('ignores synthetic input and pauses automatic recall with high pressure or off mode', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    const { agent, session } = await h.conversation('flags')
    await save(h, agent, latest, 0)
    const other = createUserMessage({ content: [{ type: 'text', text: query }], source: { kind: MEMORY_SOURCE_KIND, form: 'recall' } })
    expect(eventTexts(await admitted(h, agent, [userMessage('你好'), other]))).toEqual([])
    expect(eventTexts(await admitted(h, agent, []))).toEqual([])
    h.meter.pressure.set(session.id, { pressureTokens: 950, contextWindow: 1000 })
    expect(eventTexts(await admitted(h, agent, [userMessage(query)]))).toEqual([])
    h.meter.pressure.clear()
    h.setVolatile('compactionMode', 'off')
    expect(eventTexts(await admitted(h, agent, [userMessage(query)]))).toEqual([])
    const found = await h.tool<{ entries: { text: string }[] }>(TOOL_NAMES.event, { action: 'find', query }, agent)
    expect(found.entries[0]?.text).toBe(latest)
    h.setVolatile('compactionMode', 'assist')
    expect(eventTexts(await admitted(h, agent, [userMessage(query)]))[0]).toContain(latest)
  })

  it('opens an old store without migration and preserves archive recall if event storage is damaged', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    const dir = join(h.root, 'scopes', 'owner')
    const file = join(dir, 'events.json')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'profile.md'), '历史档案标记\n')
    const { agent } = await h.conversation('old-store')
    const original = await admitted(h, agent, [userMessage(query)])
    expect(eventTexts(original)).toEqual([])
    expect(JSON.stringify(original)).toContain('历史档案标记')
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(file, '{broken')
    await h.reload()
    const fresh = await h.conversation('damaged-events')
    const fallback = await admitted(h, fresh.agent, [userMessage(query)])
    expect(eventTexts(fallback)).toEqual([])
    expect(JSON.stringify(fallback)).toContain('历史档案标记')
    await expect(save(h, fresh.agent, latest, 0)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })

  it('skips automatic recall when the window is consumed by output and engine headroom', async () => {
    const h = harness = await createHarness({ engine: 'none', level: 5, contextWindow: 8192 })
    const { agent } = await h.conversation('small-window')
    await save(h, agent, latest, 0)
    expect((await h.runtime.budgets.budgetFor(agent)).memoryBudgetTokens).toBeLessThan(10)
    expect(eventTexts(await admitted(h, agent, [userMessage(query)]))).toEqual([])
  })

  it('fits event and archive text into one memory budget when both enter a fresh step', async () => {
    const h = harness = await createHarness({ engine: 'none', level: 5, contextWindow: 16_384 })
    const { agent } = await h.conversation('budget')
    await save(h, agent, latest, 0)
    const dir = join(h.root, 'scopes', 'owner')
    await writeFile(join(dir, 'profile.md'), Array.from({ length: 1000 }, (_, i) => `历史档案行 ${i}`).join('\n'))
    const messages = await admitted(h, agent, [userMessage(query)])
    expect(eventTexts(messages)).toHaveLength(1)
    expect(messages.some(message => message.source.kind === MEMORY_SOURCE_KIND)).toBe(true)
    const estimate = createTokenEstimator()
    const injectedTokens = messages.filter(message => message.source.kind !== 'user').reduce((sum, message) => sum + estimate.estimate(message.content.map(block => block.type === 'text' ? block.text : '').join('')), 0)
    expect(injectedTokens).toBeLessThanOrEqual((await h.runtime.budgets.budgetFor(agent)).memoryBudgetTokens)
  })
})
