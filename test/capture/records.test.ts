import { describe, expect, it } from 'vitest'
import { isExcludedRecord, isMessageRecord, isSyntheticRecord, readShadowedSeqs, recordText, stripReasoning } from '../../src/capture/records.ts'
import type { RawEventRecord } from '../../src/contracts.ts'
import { EventStream } from './fixtures.ts'

describe('record classification', () => {
  const s = new EventStream()

  it('classifies user message sources', () => {
    const human = s.user('hi')
    const memory = s.user('m', { kind: 'memory-cloud' })
    const checkpoint = s.user('c', { kind: 'compact-checkpoint' })
    const runtime = s.user('r', { kind: 'runtime-context' })
    const notice = s.user('n', { kind: 'file-change' })
    expect([human, memory, checkpoint, runtime, notice].map(isExcludedRecord)).toEqual([false, true, false, false, false])
    expect([human, memory, checkpoint, runtime, notice].map(isSyntheticRecord)).toEqual([false, true, true, true, false])
    expect([human, memory, checkpoint, runtime, notice].map(isMessageRecord)).toEqual([true, false, false, false, true])
    expect(isMessageRecord(s.assistant('a'))).toBe(true)
    expect(isMessageRecord(s.toolResult('t'))).toBe(false)
    expect(isMessageRecord(s.turnEnd())).toBe(false)
  })

  it('extracts model-facing text for token estimates', () => {
    expect(recordText(s.user('hello'))).toBe('hello')
    expect(recordText(s.user('snapshot', { kind: 'runtime-context' }))).toBe('')
    expect(recordText(s.assistant('answer', { reasoning: 'think', toolCall: 'read' }))).toBe('think\nanswer\nread {}')
    expect(recordText(s.toolResult('result'))).toBe('result')
    expect(recordText(s.event('system/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'prompt' }] } }))).toBe('')
    expect(recordText(s.event('user/message', null))).toBe('')
  })

  it('reads shadowed seqs defensively', () => {
    expect(readShadowedSeqs(s.event('compaction/summary', { shadowedSeqs: [32, 21, 'x', 1.5, 23] }))).toEqual([32, 21, 23])
    expect(readShadowedSeqs(s.event('compaction/summary', {}))).toEqual([])
  })
})

describe('stripReasoning', () => {
  const s = new EventStream()

  it('removes reasoning from assistant messages and attempts without mutating the input', () => {
    const record = s.assistant('visible', { reasoning: 'hidden' })
    const snapshot = structuredClone(record)
    const stripped = stripReasoning(record)
    expect(record).toEqual(snapshot)
    expect(JSON.stringify(stripped)).not.toContain('hidden')
    expect(stripped).toMatchObject({ seq: record.seq, time: record.time, type: 'assistant/message' })

    const attempt: RawEventRecord = s.event('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [
        { type: 'chunk', time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hidden' } },
        { type: 'chunk', time: 1, chunk: { type: 'text-delta', index: 1, text: 'shown' } },
      ],
    })
    expect(stripReasoning(attempt).data).toEqual({ turn: 1, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', index: 1, text: 'shown' } }] })
  })

  it('removes reasoning from compaction summaries', () => {
    const record = s.event('compaction/summary', {
      shadowedSeqs: [1],
      summary: [{ type: 'text', text: 'sum' }],
      rawOutput: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'sum' }],
      llmStreamCall: true,
    })
    expect(stripReasoning(record).data).toEqual({ shadowedSeqs: [1], summary: [{ type: 'text', text: 'sum' }], rawOutput: [{ type: 'text', text: 'sum' }], llmStreamCall: true })
  })

  it('returns other records unchanged', () => {
    const record = s.user('hi')
    expect(stripReasoning(record)).toBe(record)
    const odd = s.event('assistant/message', 'not an object')
    expect(stripReasoning(odd)).toBe(odd)
  })
})
