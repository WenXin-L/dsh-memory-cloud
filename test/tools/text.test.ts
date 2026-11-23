import { describe, expect, it } from 'vitest'
import { SYNTHETIC_SOURCE_KINDS } from '../../src/contracts.ts'
import { isConversationRecord, renderRawRecord } from '../../src/tools/raw.ts'
import { extractQueryDates, parseDateBound, queryTerms, tokenize, truncateToTokens } from '../../src/tools/text.ts'
import { at, estimator } from './helpers.ts'

describe('tokenize', () => {
  it('emits CJK bigrams, lone CJK characters, and lowercase words', () => {
    const tokens = tokenize('猫粮 Brand：皇家ＲＣ 猫')
    expect(tokens.terms).toEqual(['猫粮', 'brand', '皇家', 'rc', '猫'])
    expect(tokens.chars).toEqual(['猫', '粮', '皇', '家'])
    expect(tokens.runs).toEqual(['猫粮', 'brand', '皇家', 'rc'])
  })

  it('folds simple English plurals without mangling -is/-us/-ss words', () => {
    expect(tokenize('cats stories this status glass').terms).toEqual(['cat', 'story', 'this', 'status', 'glass'])
  })

  it('drops stopwords and particle bigrams from queries unless nothing is left', () => {
    expect(queryTerms('what is the cat food')).toEqual(['cat', 'food'])
    expect(queryTerms('说的猫粮')).toEqual(['猫粮'])
    expect(queryTerms('the')).toEqual(['the'])
  })
})

describe('dates', () => {
  it('extracts full and month-day dates from queries', () => {
    const dates = extractQueryDates('2026年11月8日 和 12月1号 还有 2026-11-30 的事')
    expect(dates.full).toEqual(['2026-11-08', '2026-11-30'])
    expect(dates.monthDay).toEqual(['12-01'])
    expect(dates.rest).not.toMatch(/\d/)
  })

  it('parses inclusive from/to bounds in local time', () => {
    expect(parseDateBound('2026-11-20', 'from')).toBe(at(2026, 11, 20, 0))
    expect(parseDateBound('2026-11-20', 'to')).toBe(at(2026, 11, 21, 0) - 1)
    expect(parseDateBound('2026-11', 'to')).toBe(at(2026, 12, 1, 0) - 1)
    expect(parseDateBound('2026', 'from')).toBe(at(2026, 1, 1, 0))
    expect(parseDateBound('2026-11-20T10:00:00Z', 'from')).toBe(Date.UTC(2026, 10, 20, 10))
    expect(parseDateBound('  ', 'from')).toBeUndefined()
    expect(() => parseDateBound('2026-02-30', 'from')).toThrow(RangeError)
    expect(() => parseDateBound('2026-13', 'to')).toThrow(RangeError)
    expect(() => parseDateBound('last week', 'to')).toThrow(RangeError)
  })

  it('reads dots and slashes like dashes and accepts only strict ISO date-times otherwise', () => {
    expect(parseDateBound('2026.11.20', 'to')).toBe(at(2026, 11, 21, 0) - 1)
    expect(parseDateBound('2026/11/20', 'from')).toBe(at(2026, 11, 20, 0))
    expect(parseDateBound('2026.11', 'to')).toBe(at(2026, 12, 1, 0) - 1)
    expect(parseDateBound('2026-11-20 10:30', 'from')).toBe(at(2026, 11, 20, 10, 30))
    expect(parseDateBound('2026-11-20T10:30', 'to')).toBe(at(2026, 11, 20, 10, 30))
    expect(parseDateBound('2026-11-20T10:30:15.250+08:00', 'from')).toBe(Date.UTC(2026, 10, 20, 2, 30, 15, 250))
    for (const text of ['11-20', '11/20', 'Nov 20 2026', '20 November 2026', '2026-11-20T10', '2026-11-20T25:00', '2026-02-30T10:00', '2026-11-20T10:00+0800', '1763600000000', '2026年11月20日']) {
      expect(() => parseDateBound(text, 'to'), text).toThrow(RangeError)
    }
  })
})

describe('truncateToTokens', () => {
  it('keeps text within the budget and marks truncation', () => {
    const text = '记忆'.repeat(500)
    const cut = truncateToTokens(text, 100, estimator)
    expect(cut.truncated).toBe(true)
    expect(estimator.estimate(cut.text)).toBeLessThanOrEqual(100)
    expect(cut.text.endsWith('…')).toBe(true)
    expect(truncateToTokens('short', 100, estimator)).toEqual({ text: 'short', truncated: false })
  })
})

describe('renderRawRecord', () => {
  it('renders messages compactly and skips bookkeeping events', () => {
    const time = at(2026, 11, 20, 9, 5)
    expect(renderRawRecord({ seq: 1, time, type: 'step/start', data: {} }, { maxChars: 100, reasoning: true })).toBeUndefined()
    expect(renderRawRecord({
      seq: 2,
      time,
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'think' },
            { type: 'text', text: 'Hello' },
            { type: 'tool-call', id: 'c1', name: 'memory_read', arguments: '{"id":"x"}' },
          ],
        },
      },
    }, { maxChars: 100, reasoning: true })).toBe('#2 09:05 assistant: (thinking) think\nHello\n→ memory_read({"id":"x"})')
    expect(renderRawRecord({
      seq: 3,
      time,
      type: 'tool/result',
      data: { message: { isError: true, content: [{ type: 'text', text: 'x'.repeat(50) }] } },
    }, { maxChars: 20, reasoning: false })).toBe(`#3 09:05 ← tool error: ${'x'.repeat(20)}…(+30 chars)`)
    expect(renderRawRecord({
      seq: 4,
      time,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'note' }], source: { kind: 'runtime-context' } },
    }, { maxChars: 100, reasoning: false })).toBe('#4 09:05 user[runtime-context]: note')
  })
})

describe('isConversationRecord', () => {
  it('keeps user, assistant and tool records and drops synthetic messages and log events', () => {
    const time = at(2026, 11, 20, 9, 5)
    const user = (source?: { kind: string }) => ({
      seq: 1, time, type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], ...source === undefined ? {} : { source } },
    })
    expect(isConversationRecord(user())).toBe(true)
    expect(isConversationRecord(user({ kind: 'user' }))).toBe(true)
    for (const kind of [...SYNTHETIC_SOURCE_KINDS, 'tool-registry']) expect(isConversationRecord(user({ kind }))).toBe(false)
    expect(isConversationRecord({ seq: 2, time, type: 'user/message', data: null })).toBe(false)
    expect(isConversationRecord({ seq: 3, time, type: 'assistant/message', data: { message: { content: [] } } })).toBe(true)
    expect(isConversationRecord({ seq: 4, time, type: 'tool/result', data: { message: { content: [] } } })).toBe(true)
    for (const type of ['compaction/summary', 'compaction/summary-error', 'request/header', 'step/start', 'turn/end', 'tool/call', 'session/title']) {
      expect(isConversationRecord({ seq: 5, time, type, data: {} })).toBe(false)
    }
  })
})
