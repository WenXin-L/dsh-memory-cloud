import type { LlmClient, LlmCompletion, LlmCompletionRequest, RawEventRecord, TokenEstimator } from '../../src/contracts.ts'
import { DEFAULT_TOKEN_ESTIMATOR_OPTIONS } from '../../src/contracts.ts'

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/u

export const estimator: TokenEstimator = {
  estimate(text) {
    let cjk = 0
    let other = 0
    for (const char of text) {
      if (CJK.test(char)) cjk += 1
      else other += 1
    }
    const { cjkWeight, otherWeight, safetyMargin } = DEFAULT_TOKEN_ESTIMATOR_OPTIONS
    return Math.ceil((cjkWeight * cjk + otherWeight * other) * safetyMargin)
  },
}

export const clock = { now: () => Date.UTC(2026, 10, 23, 7, 0) }

export type Reply = Partial<LlmCompletion> | ((request: LlmCompletionRequest, index: number) => Partial<LlmCompletion>)

export function scriptedLlm(replies: readonly Reply[] | ((request: LlmCompletionRequest, index: number) => Partial<LlmCompletion>)) {
  const calls: LlmCompletionRequest[] = []
  const llm: LlmClient = {
    async complete(request) {
      const index = calls.length
      calls.push(request)
      const reply = typeof replies === 'function' ? replies : replies[index]
      if (reply === undefined) throw new Error(`unexpected call #${index + 1}`)
      const partial = typeof reply === 'function' ? reply(request, index) : reply
      return { text: '', toolCalls: [], finish: 'stop', provider: 'fake', model: 'fake-1', ...partial }
    },
  }
  return { llm, calls }
}

export interface FakeSummary {
  gist?: string
  summary?: string
  ongoing?: string[]
  importance?: number
  keywords?: string[]
  people?: string[]
  dates?: { date: string; what: string }[]
  promises?: { what: string; who?: string; due?: string }[]
}

export function summaryJson(overrides: FakeSummary = {}): string {
  return JSON.stringify({
    gist: '用户聊到明天的面试。',
    summary: '## 发生了什么\n用户说 2026-11-21 要去面试，有点紧张。',
    ongoing: ['面试结果待跟进'],
    importance: 7,
    keywords: ['面试'],
    people: ['小林'],
    dates: [{ date: '2026-11-21', what: '面试' }],
    promises: [{ what: '面试后告诉结果', who: '用户', due: '2026-11-21' }],
    ...overrides,
  })
}

export function toolReply(overrides: FakeSummary = {}): Partial<LlmCompletion> {
  return { finish: 'tool-calls', toolCalls: [{ name: 'memory_save', arguments: summaryJson(overrides) }] }
}

export function allText(request: LlmCompletionRequest): string {
  return [request.system ?? '', ...request.messages.map(message => message.text)].join('\n')
}

export const T0 = Date.UTC(2026, 10, 20, 13, 30)

export function userRecord(seq: number, time: number, text: string, source: Record<string, unknown> = { kind: 'user' }): RawEventRecord {
  return { seq, time, type: 'user/message', data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source } }
}

export function assistantRecord(seq: number, time: number, content: unknown[], extra: Record<string, unknown> = {}): RawEventRecord {
  return {
    seq,
    time,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { id: `a${seq}`, role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [], ...extra },
  }
}
