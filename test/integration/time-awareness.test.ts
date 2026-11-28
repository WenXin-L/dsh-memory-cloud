import {
  createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, markAgentLoopRequest, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_SERVICE } from '../../src/client/contract.ts'
import type { MemoryCloudRemote } from '../../src/runtime/remote.ts'
import { createHarness, MODEL, PROVIDER, userMessage } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.dispose()
  harness = undefined
})

const sample = Date.parse('2026-11-27T18:32:11Z')
const stamp = '[Sat 2026-11-28 02:32:11 CST]'
const text = (value: string) => ({ type: 'text' as const, text: value })

async function send(h: Harness, session: Session, request: Partial<GenerateOptions> = {}, mark = true) {
  const prepared = await h.ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL })
  const messages = session.deriveMessages()
  Object.freeze(messages)
  const options: GenerateOptions = Object.freeze({ ...prepared.config, sessionId: session.id, messages, ...request })
  let last: StreamChunk | undefined
  for await (const chunk of prepared.stream(mark ? markAgentLoopRequest(options) : options)) last = chunk
  expect(last).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  return { original: options, outbound: h.adapter.calls.at(-1)! }
}

describe('time awareness on the prepared DSH adapter', () => {
  it('uses the current live toggle on later requests and leaves the frozen history and middleware input intact', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    const { session } = await h.conversation('timestamp-toggle')
    const now = vi.spyOn(Date, 'now').mockReturnValue(sample - 2_000)
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('instructions') }, { surfaceOp: 'append' })
    now.mockReturnValue(sample)
    session.append('user/message', userMessage('question'), { surfaceOp: 'append' })
    now.mockReturnValue(sample + 1_000)
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [text('answer'), text(' and more')], source: { provider: PROVIDER, model: MODEL } }),
    }, { surfaceOp: 'append' })
    now.mockRestore()

    const seen: GenerateOptions[] = []
    h.ctx.on('llm/stream', (options, next) => {
      if (options.sessionId === session.id) seen.push(options)
      return next()
    })
    const remote = h.ctx.get(REMOTE_SERVICE) as MemoryCloudRemote
    const log = structuredClone(session.snapshotEvents())
    const off = await send(h, session)
    expect(off.outbound).toBe(off.original)

    expect(await remote.setConfig({ timeAwareness: true })).toMatchObject({ ok: true })
    const on = await send(h, session)
    expect(seen.at(-1)).toBe(on.original)
    expect(on.original.messages).toEqual(session.deriveMessages())
    expect(on.outbound.messages.map(message => message.content)).toEqual([
      [text('[Sat 2026-11-28 02:32:09 CST] instructions')],
      [text(`${stamp} question`)],
      [text('[Sat 2026-11-28 02:32:12 CST] answer'), text(' and more')],
    ])
    expect(on.outbound.messages.map(message => message.id)).toEqual(on.original.messages.map(message => message.id))
    expect((await send(h, session)).outbound.messages).toEqual(on.outbound.messages)
    expect((await send(h, session, {}, false)).outbound.messages).toEqual(on.original.messages)
    expect((await send(h, session, { purpose: 'compaction' })).outbound.messages).toEqual(on.original.messages)
    expect(session.snapshotEvents()).toEqual(log)

    expect(await remote.setConfig({ timeAwareness: false })).toMatchObject({ ok: true })
    expect((await send(h, session)).outbound.messages).toEqual(on.original.messages)
    h.setVolatile('timeAwareness', true)
    await h.reload()
    expect((await send(h, session)).outbound.messages).toEqual(on.outbound.messages)
  })

  it('keeps tool and replay structure while labeling resumed history, pruned results and new checkpoints', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    const { session: seed } = await h.conversation('timestamp-seed')
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-27T15:59:59Z'))
    const past = seed.append('user/message', userMessage('old question'), { surfaceOp: 'append' })
    now.mockReturnValue(sample - 1_000)
    const callId = ToolCallId('time_fixture_tool')
    const reasoning = { type: 'reasoning' as const, text: 'Plan.' }
    const toolCall = { type: 'tool-call' as const, id: callId, name: 'echo', arguments: '{ "value": 1 }' }
    const native = {
      response: { kind: 'pi-ai', version: 2, provider: PROVIDER, model: MODEL, api: 'anthropic-messages', stopReason: 'toolUse' },
      blocks: [{ type: 'reasoning', thinkingSignature: 'thinking-sig' }, { type: 'text', textSignature: 'text-sig' }, { type: 'tool-call', thoughtSignature: 'tool-sig' }],
    }
    const assistant = createAssistantMessage({
      content: [reasoning, text('Signed answer.'), toolCall],
      source: { provider: PROVIDER, model: MODEL, replayState: native },
    })
    seed.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
    now.mockReturnValue(sample)
    const toolResult = createToolResultMessage({ callId, content: [text('original long result')], isError: false })
    const result = seed.append('tool/result', { turn: 1, step: 1, message: toolResult }, { surfaceOp: 'append' })
    now.mockReturnValue(sample + 1_000)
    seed.append('tool/result', { turn: 1, step: 1, message: { ...toolResult, content: [text('pruned result')] } }, {
      surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq },
      sourceEventSeqs: [result.seq],
    })
    now.mockRestore()
    const session = h.ctx.sessions.create(SessionId('timestamp-resumed'), { seed: seed.snapshotEvents() })
    h.setVolatile('timeAwareness', true)

    const resumed = (await send(h, session)).outbound.messages
    expect(resumed[0]?.content).toEqual([text('[Fri 2026-11-27 23:59:59 CST] old question')])
    expect(resumed[1]).toMatchObject({
      id: assistant.id,
      role: 'assistant',
      content: [reasoning, text('[Sat 2026-11-28 02:32:10 CST]'), text('Signed answer.'), toolCall],
      source: { replayState: { response: native.response, blocks: [native.blocks[0], { type: 'text' }, ...native.blocks.slice(1)] } },
    })
    expect(resumed[2]).toMatchObject({ id: toolResult.id, role: 'tool', toolCallId: callId, content: [text(`${stamp} pruned result`)] })
    expect(session.deriveMessages()[1]).toEqual(assistant)

    vi.spyOn(Date, 'now').mockReturnValue(sample + 9_000)
    session.append('user/message', userMessage('checkpoint'), {
      surfaceOp: { op: 'replace', startSeq: past.seq, endSeq: past.seq },
      sourceEventSeqs: [past.seq],
    })
    vi.mocked(Date.now).mockRestore()
    const compacted = (await send(h, session)).outbound.messages
    expect(compacted[0]?.content).toEqual([text('[Sat 2026-11-28 02:32:20 CST] checkpoint')])
    expect(compacted.slice(1)).toEqual(resumed.slice(1))
    expect(session.eventAt(past.seq)?.data).toEqual(past.data)
  })

  it('prefixes image-only inputs and native tool-only replies and skips messages with unavailable provenance', async () => {
    const h = harness = await createHarness({ engine: 'none' })
    const { session } = await h.conversation('timestamp-blocks')
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-27T16:00:00Z'))
    const image: ImageBlock = {
      type: 'image',
      attachment: { attachmentId: 'a'.repeat(64) as ImageBlock['attachment']['attachmentId'], bytes: 68, mediaType: 'image/png', width: 1, height: 1 },
    }
    session.append('user/message', createUserMessage({ content: [image], source: { kind: 'user' } }), { surfaceOp: 'append' })
    now.mockReturnValue(sample)
    const toolCall = { type: 'tool-call' as const, id: ToolCallId('native_call'), name: 'echo', arguments: '{  }' }
    const reasoning = { type: 'reasoning' as const, text: 'Thinking' }
    const native = {
      response: { kind: 'deepseek-messages', version: 1, model: MODEL },
      blocks: [{ type: 'reasoning', signature: 'native-signature' }, { type: 'tool-call' }],
    }
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [reasoning, toolCall], source: { provider: PROVIDER, model: MODEL, replayState: native } }),
    }, { surfaceOp: 'append' })
    const foreign = createAssistantMessage({
      content: [text('Unknown replay')], source: { provider: PROVIDER, model: MODEL, replayState: { adapter: 'custom' } },
    })
    session.append('assistant/message', { turn: 1, step: 2, message: foreign, stream: [] }, { surfaceOp: 'append' })
    now.mockRestore()
    const unlogged = userMessage('No session event')
    h.setVolatile('timeAwareness', true)

    const { outbound } = await send(h, session, { messages: [...session.deriveMessages(), unlogged] })
    expect(outbound.messages[0]?.content).toEqual([text('[Sat 2026-11-28 00:00:00 CST]'), image])
    expect(outbound.messages[1]).toMatchObject({
      content: [reasoning, text(stamp), toolCall],
      source: { replayState: { response: native.response, blocks: [native.blocks[0], { type: 'text' }, native.blocks[1]] } },
    })
    expect(outbound.messages[2]).toEqual(foreign)
    expect(outbound.messages[3]).toBe(unlogged)
  })
})
