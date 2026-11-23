import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createAssistantMessage, createDeveloperMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, ToolCallId } from '@deepseek-ai/dsh-llm'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHRINK_RATIO,
  estimateMessageTokens,
  fitsShrinkGuard,
  framedCheckpointTokens,
  maxCheckpointChars,
  measureRegion,
} from '../../src/engine/index.ts'

const realEstimate = (message: Message): number => TokenMeter.prototype.estimateMessage.call(undefined, message)

function shippedPreamble(): string {
  const source = readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-compaction-basic/src/summarizer.ts')), 'utf8')
  const match = /const CHECKPOINT_PREAMBLE =\s*'([^']*)'/.exec(source)
  if (match?.[1] === undefined) throw new Error('CHECKPOINT_PREAMBLE not found in compaction-basic')
  return match[1]
}

function framed(text: string): Message {
  const content: ContentBlock[] = [
    { type: 'text', text: `${shippedPreamble()}\n\n<compacted-summary>` },
    { type: 'text', text },
    { type: 'text', text: '</compacted-summary>' },
  ]
  return createUserMessage({ content, source: { kind: 'user' } })
}

const callId = 'call-1' as ToolCallId
const samples: Message[] = [
  createUserMessage({ content: [{ type: 'text', text: '你好，今天天气不错。Let us go out.' }], source: { kind: 'user' } }),
  createAssistantMessage({
    content: [
      { type: 'reasoning', text: 'thinking about the weather' },
      { type: 'text', text: 'Sure!' },
      { type: 'tool-call', id: callId, name: 'weather_lookup', arguments: '{"city":"Hong Kong"}' },
    ],
    source: { provider: 'fake', model: 'fake-1' },
  }),
  createToolResultMessage({ callId, content: [{ type: 'text', text: '{"temp":24}' }], isError: false }),
  createDeveloperMessage({ content: [{ type: 'tool-addition', toolName: 'memory_read' }], source: { kind: 'user' } }),
  createSystemMessage('You are a companion.'),
]

describe('estimateMessageTokens', () => {
  it('matches dsh-token-meter for every message shape', () => {
    for (const message of samples) expect(estimateMessageTokens(message)).toBe(realEstimate(message))
  })
})

describe('measureRegion', () => {
  it('drops only the leading system head and prices the rest', () => {
    const [user, assistant, tool, developer, system] = samples as [Message, Message, Message, Message, Message]
    const region = measureRegion([system, user, assistant, tool, developer])
    expect(region.messages).toEqual([user, assistant, tool, developer])
    expect(region.tokens).toBe([user, assistant, tool, developer].reduce((sum, message) => sum + realEstimate(message), 0))
    const userText = '你好，今天天气不错。Let us go out.'.length
    const assistantChars = 'thinking about the weather'.length + 'Sure!'.length + 'weather_lookup'.length + '{"city":"Hong Kong"}'.length
    const developerChars = JSON.stringify({ type: 'tool-addition', toolName: 'memory_read' }).length
    expect(region.chars).toBe(userText + assistantChars + '{"temp":24}'.length + developerChars)
    expect(measureRegion([user, system]).messages).toEqual([user, system])
  })
})

describe('shrink guard', () => {
  it('prices the framed checkpoint exactly like DSH, with the shipped preamble', () => {
    const runtime = readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-compaction-basic')), 'utf8')
    expect(runtime).toContain(shippedPreamble())
    for (const text of ['', 'x', 'a short memory block', '<memory-cloud>\n'.repeat(300), '记忆'.repeat(777)]) {
      expect(framedCheckpointTokens(text)).toBe(realEstimate(framed(text)))
    }
  })

  it('accepts text strictly under the ratio and caps it at maxCheckpointChars', () => {
    for (const regionTokens of [150, 400, 1000, 4097, 50_000]) {
      const max = maxCheckpointChars(regionTokens)
      if (max === 0) {
        expect(fitsShrinkGuard('x', regionTokens)).toBe(false)
        continue
      }
      expect(fitsShrinkGuard('x'.repeat(max), regionTokens)).toBe(true)
      expect(fitsShrinkGuard('x'.repeat(max + 1), regionTokens)).toBe(false)
      expect(realEstimate(framed('x'.repeat(max)))).toBeLessThan(regionTokens * DEFAULT_SHRINK_RATIO)
    }
    expect(maxCheckpointChars(100)).toBe(0)
  })

  it('honours a custom ratio', () => {
    const text = 'y'.repeat(2000)
    expect(fitsShrinkGuard(text, 2000, 0.5)).toBe(true)
    expect(fitsShrinkGuard(text, 2000, 0.25)).toBe(false)
    expect(maxCheckpointChars(2000, 0.25)).toBeLessThan(maxCheckpointChars(2000, 0.5))
  })
})
