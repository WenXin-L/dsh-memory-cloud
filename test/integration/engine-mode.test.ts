import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OWNER_SCOPE, SUMMARIZE_PURPOSE } from '../../src/contracts.ts'
import type { ReadOutput } from '../../src/tools/index.ts'
import { createHarness, longText, MODEL, PROVIDER } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function chat(h: Harness, id: string, turns = 4) {
  const conversation = await h.conversation(id)
  conversation.route()
  for (let turn = 0; turn < turns; turn++) {
    conversation.exchange(longText(`用户问题 ${turn}`, 1500), longText(`助手回答 ${turn}`, 1500))
  }
  await h.runtime.capture.flush()
  return conversation
}

describe('engine mode', () => {
  it('turns a compaction into a memory checkpoint and stores its summary without a second model call', async () => {
    const h = harness = await createHarness({ engine: 'memory' })
    const conversation = await chat(h, 'sess-engine-1')
    expect(h.runtime.modes.modeFor(conversation.agent)).toMatchObject({ mode: 'engine', engineActive: true })
    expect((await h.runtime.store.readIndex(OWNER_SCOPE)).episodes).toMatchObject([{ status: 'open', sessionId: 'sess-engine-1' }])

    await h.tool('memory_note', { action: 'add', text: '用户习惯摄氏度。' }, conversation.agent)
    const result = await h.compaction!.compactNow(conversation.agent, new AbortController().signal)

    expect(result).not.toBeNull()
    const [checkpoint, ...others] = conversation.visible('compact-checkpoint')
    expect(others).toEqual([])
    expect(checkpoint).toContain('<compacted-summary>')
    expect(checkpoint).toContain('<memory-cloud>')
    expect(checkpoint).toContain('用户习惯摄氏度。')
    expect(checkpoint).toContain('楼外楼的醋鱼')
    expect(checkpoint).toContain('周五提醒用户带伞')
    expect(h.adapter.calls).toHaveLength(1)
    const [call] = h.adapter.callsFor(SUMMARIZE_PURPOSE)
    expect(call).toMatchObject({ provider: PROVIDER, model: MODEL, purpose: SUMMARIZE_PURPOSE })
    expect(call?.sessionId).toBeUndefined()
    expect(call?.messages[0]).toMatchObject({ role: 'system' })
    expect(JSON.stringify(call?.messages.at(-1))).toContain('记忆整理任务')
    expect(JSON.stringify(call?.messages)).toContain('用户问题 3')

    await h.settle()
    const index = await h.runtime.store.readIndex(OWNER_SCOPE)
    const sealed = index.episodes.find(meta => meta.sealReason === 'compaction')
    expect(sealed).toMatchObject({ status: 'summarized', sessionId: 'sess-engine-1', summarizer: { provider: PROVIDER, model: MODEL } })
    expect(sealed?.shadowedSeqs?.length).toBeGreaterThan(0)
    expect(h.adapter.calls).toHaveLength(1)
    expect(h.runtime.runner.stats().queue).toEqual([])

    const withHash = await h.tool<ReadOutput>('memory_read', { id: `#${sealed!.id}` }, conversation.agent)
    const bare = await h.tool<ReadOutput>('memory_read', { id: sealed!.id }, conversation.agent)
    expect(withHash.text).toContain('楼外楼的醋鱼')
    expect(bare).toEqual(withHash)
    const raw = await h.tool<ReadOutput>('memory_read', { id: `#${sealed!.id}`, level: 'raw' }, conversation.agent)
    expect(raw.level).toBe('raw')
    expect(raw.text.includes('#3 ') && raw.text.includes('用户问题 0（第 39 句）')).toBe(true)
    expect(raw.text.includes('用户问题 3')).toBe(true)
    expect(raw.text.includes('<memory-cloud')).toBe(false)

    const snapshots = await readdir(join(h.root, 'scopes', 'owner', 'snapshots'))
    expect(snapshots.some(name => name.startsWith('sess-engine-1-'))).toBe(true)
    const log = (await readFile(join(h.root, 'logs', 'summarizer.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; ok: boolean })
    expect(log.map(entry => entry.kind)).toEqual(['checkpoint-summary', 'checkpoint'])
  })

  it('consolidates an idle agent above idleCompactRatio once, through compactNow', async () => {
    const h = harness = await createHarness({ engine: 'memory' })
    const conversation = await chat(h, 'sess-idle-1')
    h.meter.pressure.set('sess-idle-1', { pressureTokens: 100_000, contextWindow: 128 * 1024 })

    h.ctx.emit('agent/status', { agent: conversation.agent, status: 'idle' })
    await expect.poll(() => conversation.visible('compact-checkpoint').length).toBe(1)
    expect(conversation.visible('compact-checkpoint')[0]).toContain('<memory-cloud>')

    h.ctx.emit('agent/status', { agent: conversation.agent, status: 'idle' })
    await h.settle()
    expect(conversation.visible('compact-checkpoint')).toHaveLength(1)
    expect(h.adapter.calls).toHaveLength(1)
  })

  it('skips idle consolidation below the ratio and in off mode', async () => {
    const h = harness = await createHarness({ engine: 'memory' })
    const conversation = await chat(h, 'sess-idle-2')
    h.meter.pressure.set('sess-idle-2', { pressureTokens: 1000, contextWindow: 128 * 1024 })
    h.ctx.emit('agent/status', { agent: conversation.agent, status: 'idle' })

    h.meter.pressure.set('sess-idle-2', { pressureTokens: 100_000, contextWindow: 128 * 1024 })
    h.setVolatile('compactionMode', 'off')
    h.ctx.emit('agent/status', { agent: conversation.agent, status: 'idle' })
    await h.settle()
    expect(conversation.visible('compact-checkpoint')).toEqual([])
    expect(h.adapter.calls).toEqual([])
  })

  it('falls back to the host summary when the memory summarizer fails, and keeps running', async () => {
    const h = harness = await createHarness({
      engine: 'memory',
      responder: call => call.purpose === SUMMARIZE_PURPOSE ? new Error('provider exploded') : 'DSH fallback summary.',
    })
    const conversation = await chat(h, 'sess-fail-1')

    const result = await h.compaction!.compactNow(conversation.agent, new AbortController().signal)

    expect(result).not.toBeNull()
    const [checkpoint] = conversation.visible('compact-checkpoint')
    expect(checkpoint).toContain('DSH fallback summary.')
    expect(checkpoint).not.toContain('<memory-cloud')
    expect(h.adapter.callsFor('compaction')).toHaveLength(1)
    const status = await h.runtime.service.api.status('sess-fail-1')
    expect(status.fallbacks.at(-1)).toMatchObject({ kind: 'compose-error', stage: 'summarize', sessionId: 'sess-fail-1' })

    await h.settle()
    const sealed = (await h.runtime.store.readIndex(OWNER_SCOPE)).episodes.find(meta => meta.sealReason === 'compaction')
    expect(sealed).toMatchObject({ status: 'failed', attempts: 1 })
    expect(sealed?.lastError).toContain('provider exploded')
    expect(h.runtime.runner.stats().queue).toMatchObject([{ kind: 'summarize', episode: sealed?.id }])

    const command = await h.command(conversation.agent, '/memory status')
    expect(command.kind).toBe('success')
    expect(command.text).toContain('模式：engine')
    expect(command.text).toContain('最近一次回退到宿主摘要：compose-error')
    expect(command.text).toContain('failed 1')
  })
})
