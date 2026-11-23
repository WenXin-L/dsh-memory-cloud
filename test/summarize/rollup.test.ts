import { describe, expect, it } from 'vitest'
import type { LlmCompletionRequest } from '../../src/contracts.ts'
import { SUMMARIZE_PURPOSE } from '../../src/contracts.ts'
import { ROLLUP_PROMPT_VERSION, ROLLUP_SYSTEM_PROMPT, SummarizeError, cleanRollupText, createRollupSummarizer } from '../../src/summarize/index.ts'
import type { RollupRequest } from '../../src/summarize/index.ts'
import { T0, clock, estimator, scriptedLlm } from './helpers.ts'
import type { Reply } from './helpers.ts'

const DAY = 24 * 60 * 60_000

function request(overrides: Partial<RollupRequest> = {}): RollupRequest {
  return {
    period: { kind: 'week', key: '2026-W47' },
    items: [
      { at: T0, text: '用户聊到明天的面试。' },
      { at: T0 + DAY, text: '用户面试通过，\n很开心。' },
    ],
    targetTokens: 60,
    timeZone: 'Asia/Hong_Kong',
    ...overrides,
  }
}

function setup(replies: readonly Reply[] | ((request: LlmCompletionRequest, index: number) => Reply), maxInputTokens?: number) {
  const script = scriptedLlm(typeof replies === 'function'
    ? (req, index) => {
      const reply = replies(req, index)
      return typeof reply === 'function' ? reply(req, index) : reply
    }
    : replies)
  const rollups = createRollupSummarizer({
    llm: script.llm,
    estimator,
    clock,
    route: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'off' },
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
  })
  return { rollups, calls: script.calls }
}

describe('createRollupSummarizer', () => {
  it('merges period entries into one plain-text gist', async () => {
    const { rollups, calls } = setup([{ text: '这周用户准备并通过了面试。', usage: { inputTokens: 80, outputTokens: 20 } }])
    const outcome = await rollups.rollup(request())
    expect(outcome.text).toBe('这周用户准备并通过了面试。')
    expect(outcome.tokens).toBe(estimator.estimate(outcome.text))
    expect(outcome.provenance).toEqual({ provider: 'fake', model: 'fake-1', promptVersion: ROLLUP_PROMPT_VERSION, summarizedAt: clock.now() })
    expect(outcome.usage).toEqual({ inputTokens: 80, outputTokens: 20 })
    const call = calls[0] as LlmCompletionRequest
    expect(call.system).toBe(ROLLUP_SYSTEM_PROMPT)
    expect(call.tools).toBeUndefined()
    expect(call.purpose).toBe(SUMMARIZE_PURPOSE)
    expect(call.sessionId).toBeUndefined()
    expect(call.reasoningEffort).toBe('off')
    const prompt = call.messages[0]?.text ?? ''
    expect(prompt).toContain('时期：2026-W47（周）')
    expect(prompt).toContain('不超过 60 tokens')
    expect(prompt).toContain('- [2026-11-20] 用户聊到明天的面试。')
    expect(prompt).toContain('- [2026-11-21] 用户面试通过， 很开心。')
  })

  it('retries over-length output, then truncates at a sentence boundary', async () => {
    const long = Array.from({ length: 30 }, (_, index) => `第${index + 1}天发生了一件事。`).join('')
    const { rollups, calls } = setup([{ text: long }, { text: long }])
    const outcome = await rollups.rollup(request())
    expect(calls).toHaveLength(2)
    expect(calls[1]?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(calls[1]?.messages[2]?.text).toContain('超过上限 60')
    expect(outcome.tokens).toBeLessThanOrEqual(60)
    expect(outcome.text.endsWith('。')).toBe(true)
    expect(long.startsWith(outcome.text)).toBe(true)
  })

  it('asks again after a cut-off answer and never keeps a cut-off sentence', async () => {
    const cut = setup([{ text: '本周小林', finish: 'max-tokens' }, { text: '本周小林说下周三搬', finish: 'max-tokens' }])
    await expect(cut.rollups.rollup(request())).rejects.toMatchObject({ code: 'parse' })
    const instruction = cut.calls[1]?.messages[2]?.text ?? ''
    expect(instruction).toContain('截断')
    expect(instruction).not.toContain('超过上限')

    const partial = setup([{ text: '本周小林', finish: 'max-tokens' }, { text: '本周小林说下周三搬家。他还说要请大家', finish: 'max-tokens' }])
    expect((await partial.rollups.rollup(request())).text).toBe('本周小林说下周三搬家。')

    const failed = setup([{ text: '本周小林说下周三搬家。他还说要请大家', finish: 'max-tokens' }, { finish: 'error', error: 'rate limited' }])
    expect((await failed.rollups.rollup(request())).text).toBe('本周小林说下周三搬家。')
  })

  it('prefers the complete first answer when the retry is cut off', async () => {
    const long = Array.from({ length: 30 }, (_, index) => `第${index + 1}天发生了一件事。`).join('')
    const { rollups } = setup([{ text: long }, { text: '本周小林说下周三', finish: 'max-tokens' }])
    const outcome = await rollups.rollup(request())
    expect(outcome.text.startsWith('第1天发生了一件事。')).toBe(true)
    expect(outcome.text.endsWith('。')).toBe(true)
    expect(long.startsWith(outcome.text)).toBe(true)
    expect(outcome.tokens).toBeLessThanOrEqual(60)
  })

  it('retries an empty answer and fails after a second empty one', async () => {
    const ok = setup([{ text: '<think>只想了想</think>' }, { text: '这周很充实。' }])
    expect((await ok.rollups.rollup(request())).text).toBe('这周很充实。')
    expect(ok.calls[1]?.messages[2]?.text).toContain('没有得到有效的时期总结')

    const bad = setup([{ text: '' }, { text: '<think>x</think>' }])
    await expect(bad.rollups.rollup(request())).rejects.toMatchObject({ code: 'parse' })
  })

  it('rejects an empty entry list and propagates model errors', async () => {
    await expect(setup([]).rollups.rollup(request({ items: [{ text: '  ' }] }))).rejects.toMatchObject({ code: 'empty-input' })
    const error = await setup([{ finish: 'error', error: 'boom' }]).rollups.rollup(request()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SummarizeError)
    expect((error as SummarizeError).code).toBe('llm-error')
  })

  it('rolls up in batches when the entries exceed the input cap', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ at: T0 + index * DAY, text: `第${index}条${'记忆'.repeat(150)}` }))
    const { rollups, calls } = setup((req) => {
      const prompt = req.messages[0]?.text ?? ''
      const count = (prompt.match(/^- /gm) ?? []).length
      return { text: `合并了${count}条。` }
    }, 512)
    const outcome = await rollups.rollup(request({ items, targetTokens: 40 }))
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls.slice(0, -1)) expect((call.messages[0]?.text.match(/^- /gm) ?? []).length).toBeGreaterThanOrEqual(2)
    const last = calls.at(-1)?.messages[0]?.text ?? ''
    expect(last).toContain('合并了')
    expect(outcome.text).toMatch(/^合并了\d条。$/)
  })
})

describe('cleanRollupText', () => {
  it('strips think blocks, fences, JSON wrappers, and labels', () => {
    expect(cleanRollupText('<think>x</think>\n```\n时期总结：这周很好。\n```')).toBe('这周很好。')
    expect(cleanRollupText('{"text": "一月很忙。"}')).toBe('一月很忙。')
    expect(cleanRollupText('Summary: A quiet week.')).toBe('A quiet week.')
  })

  it('keeps think tags inside the answer', () => {
    expect(cleanRollupText('总结：本周 <think> 标签讨论了三次。')).toBe('本周 <think> 标签讨论了三次。')
    expect(cleanRollupText('<think>x</think>本周修了 </think> 的问题。')).toBe('本周修了 </think> 的问题。')
  })
})
