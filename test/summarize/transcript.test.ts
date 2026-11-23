import { describe, expect, it } from 'vitest'
import type { RawEventRecord } from '../../src/contracts.ts'
import { chunkTranscript, isConversationSource, renderTranscript, splitTranscriptEntries } from '../../src/summarize/index.ts'
import { T0, assistantRecord, estimator, userRecord } from './helpers.ts'

const MINUTE = 60_000

function fixture(): RawEventRecord[] {
  return [
    { seq: 1, time: T0, type: 'turn/start', data: { turn: 1 } },
    userRecord(2, T0, '明天我要去面试，有点紧张\n你能陪我练练吗？'),
    userRecord(3, T0, 'RUNTIME-CONTEXT-SECRET', { kind: 'runtime-context', form: 'snapshot', sections: [] }),
    { ...userRecord(4, T0, 'OLD-CHECKPOINT-TEXT', { kind: 'compact-checkpoint', compactionId: 'c1' }), surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 } },
    userRecord(5, T0, 'MEMORY-BLOCK-TEXT', { kind: 'memory-cloud', form: 'recall' }),
    userRecord(6, T0, 'FILE-CHANGE-NOTICE', { kind: 'file-change', form: 'notice', summary: 'x' }),
    { seq: 7, time: T0, type: 'system/message', data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'SYSTEM-PROMPT' }] } } },
    assistantRecord(8, T0 + MINUTE, [
      { type: 'reasoning', text: 'REASONING-TEXT' },
      { type: 'text', text: '别担心，我们先模拟一下。' },
      { type: 'tool-call', id: 'call-1', name: 'calendar_add', arguments: '{ "date": "2026-11-21",  "title": "面试" }' },
    ]),
    { seq: 9, time: T0 + MINUTE, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'calendar_add', arguments: '{"date":"2026-11-21","title":"面试"}' } },
    {
      seq: 10,
      time: T0 + 2 * MINUTE,
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: `HEAD${'x'.repeat(5000)}TAIL` }], source: { kind: 'tool', callId: 'call-1' } } },
    },
    { seq: 11, time: T0 + 2 * MINUTE, type: 'compaction/summary', data: { compactionId: 'c2', summary: [{ type: 'text', text: 'COMPACTION-SUMMARY' }] } },
    { seq: 12, time: T0 + 2 * MINUTE, type: 'tool/call', data: { turn: 1, step: 2, callId: 'call-2', name: 'web_search', arguments: '{"q":"面试技巧"}' } },
    {
      seq: 13,
      time: T0 + 3 * MINUTE,
      type: 'tool/result',
      data: { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'call-2', isError: true, content: [{ type: 'text', text: 'network down' }], source: { kind: 'tool', callId: 'call-2' } } },
    },
    userRecord(14, T0 + 24 * 60 * MINUTE, '面试通过了！'),
  ]
}

describe('renderTranscript', () => {
  it('renders user/assistant text, tool calls, and results with timestamps', () => {
    const text = renderTranscript(fixture(), { timeZone: 'Asia/Hong_Kong' })
    expect(text).toContain('[2026-11-20 周五 21:30] User: 明天我要去面试，有点紧张\n  你能陪我练练吗？')
    expect(text).toContain('[21:31] Assistant: 别担心，我们先模拟一下。')
    expect(text).toContain('[21:31] Tool call: calendar_add {"date":"2026-11-21","title":"面试"}')
    expect(text).toContain('[21:32] Tool call: web_search {"q":"面试技巧"}')
    expect(text).toContain('[21:33] Tool error (web_search): network down')
    expect(text).toContain('[2026-11-21 周六 21:30] User: 面试通过了！')
    expect(text.match(/Tool call: calendar_add/g)).toHaveLength(1)
  })

  it('excludes injected user sources, system/compaction events, and reasoning by default', () => {
    const text = renderTranscript(fixture(), { timeZone: 'Asia/Hong_Kong' })
    for (const secret of ['RUNTIME-CONTEXT-SECRET', 'OLD-CHECKPOINT-TEXT', 'MEMORY-BLOCK-TEXT', 'FILE-CHANGE-NOTICE', 'SYSTEM-PROMPT', 'COMPACTION-SUMMARY', 'REASONING-TEXT']) {
      expect(text).not.toContain(secret)
    }
  })

  it('includes reasoning on request and extra source kinds, but never the excluded ones', () => {
    const text = renderTranscript(fixture(), {
      timeZone: 'Asia/Hong_Kong',
      includeReasoning: true,
      includeSourceKinds: ['file-change', 'memory-cloud', 'compact-checkpoint', 'runtime-context'],
    })
    expect(text).toContain('Assistant (thinking): REASONING-TEXT')
    expect(text).toContain('User: FILE-CHANGE-NOTICE')
    expect(text).not.toContain('MEMORY-BLOCK-TEXT')
    expect(text).not.toContain('OLD-CHECKPOINT-TEXT')
    expect(text).not.toContain('RUNTIME-CONTEXT-SECRET')
  })

  it('clips long tool results head+tail', () => {
    const text = renderTranscript(fixture(), { timeZone: 'Asia/Hong_Kong', toolResultChars: 300 })
    const line = text.split('\n').find(item => item.includes('Tool result (calendar_add)')) ?? ''
    expect(line).toContain('HEAD')
    expect(text).toContain('TAIL')
    expect(text).toMatch(/chars omitted/)
    const entry = splitTranscriptEntries(text).find(item => item.includes('Tool result (calendar_add)')) ?? ''
    expect(entry.length).toBeLessThan(400)
  })

  it('stamps a Chinese weekday only when the local date changes', () => {
    const text = renderTranscript([
      userRecord(1, Date.UTC(2026, 10, 22, 15, 50), '睡了吗'),
      assistantRecord(2, Date.UTC(2026, 10, 22, 15, 55), [{ type: 'text', text: '还没' }]),
      userRecord(3, Date.UTC(2026, 10, 22, 16, 5), '过零点了'),
    ], { timeZone: 'Asia/Hong_Kong' })
    expect(text.split('\n')).toEqual([
      '[2026-11-22 周日 23:50] User: 睡了吗',
      '[23:55] Assistant: 还没',
      '[2026-11-23 周一 00:05] User: 过零点了',
    ])
    expect(text).not.toMatch(/Sunday|Monday/)
  })

  it('renders images, files, and interrupted assistant messages', () => {
    const text = renderTranscript([
      { seq: 1, time: T0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '看这张' }, { type: 'image', attachment: { name: 'cat.png' } }, { type: 'file', attachment: { name: 'a.pdf' } }], source: { kind: 'user' } } },
      assistantRecord(2, T0, [{ type: 'text', text: '好可爱' }], { interrupted: true }),
    ], { timeZone: 'UTC' })
    expect(text).toContain('User: 看这张\n  [image: cat.png]\n  [file: a.pdf]')
    expect(text).toContain('Assistant (interrupted): 好可爱')
  })

  it('tolerates malformed records', () => {
    const text = renderTranscript([
      { seq: 1, time: Number.NaN, type: 'user/message', data: { content: [{ type: 'text', text: 'no source' }] } },
      { seq: 2, time: T0, type: 'assistant/message', data: null },
      { seq: 3, time: T0, type: 'tool/result', data: { message: 'bad' } },
    ], { timeZone: 'Not/A_Zone' })
    expect(text).toBe('[????-??-?? ??:??] User: no source')
  })
})

describe('isConversationSource', () => {
  it('accepts user and listed kinds only', () => {
    expect(isConversationSource('user')).toBe(true)
    expect(isConversationSource(undefined)).toBe(true)
    expect(isConversationSource('qq-bridge')).toBe(false)
    expect(isConversationSource('qq-bridge', ['qq-bridge'])).toBe(true)
    expect(isConversationSource('memory-cloud', ['memory-cloud'])).toBe(false)
  })
})

describe('splitTranscriptEntries / chunkTranscript', () => {
  it('splits on entry starts and packs whole entries into chunks', () => {
    const text = renderTranscript(fixture(), { timeZone: 'Asia/Hong_Kong' })
    const entries = splitTranscriptEntries(text)
    expect(entries).toHaveLength(7)
    expect(entries[0]).toContain('你能陪我练练吗？')
    const chunks = chunkTranscript(text, 200, estimator)
    expect(chunks.length).toBeGreaterThan(1)
    for (const entry of entries) {
      if (estimator.estimate(entry) <= 200) expect(chunks.some(chunk => chunk.includes(entry))).toBe(true)
    }
    for (const chunk of chunks) expect(estimator.estimate(chunk)).toBeLessThanOrEqual(200)
  })

  it('hard-splits a single oversized entry', () => {
    const chunks = chunkTranscript(`[21:30] User: ${'字'.repeat(1000)}`, 100, estimator)
    expect(chunks.length).toBeGreaterThan(5)
    for (const chunk of chunks) expect(estimator.estimate(chunk)).toBeLessThanOrEqual(100)
    expect(chunks.join('').replace(/\s/g, '')).toBe(`[21:30]User:${'字'.repeat(1000)}`)
  })
})
