import { EVENT_MEMORY_SOURCE_KIND, MEMORY_SOURCE_KIND, SYNTHETIC_SOURCE_KINDS, type RawEventRecord } from '../contracts.ts'

/**
 * Records whose `user/message` source kind is one of the shared
 * {@link SYNTHETIC_SOURCE_KINDS} do not make an episode non-empty, do not
 * count toward its raw tokens, and are not "real" seqs when a compaction
 * region decides where an episode ends.
 */
const SYNTHETIC_KINDS: ReadonlySet<string> = new Set(SYNTHETIC_SOURCE_KINDS)

export { SYNTHETIC_SOURCE_KINDS }

/** `user/message` source kinds that are never written to the raw archive. */
export const EXCLUDED_SOURCE_KINDS: ReadonlySet<string> = new Set([MEMORY_SOURCE_KIND, EVENT_MEMORY_SOURCE_KIND])

type JsonObject = Readonly<Record<string, unknown>>

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

/** `source.kind` of a `user/message` record, if it has one. */
export function userSourceKind(record: RawEventRecord): string | undefined {
  if (record.type !== 'user/message') return undefined
  const kind = asObject(asObject(record.data)?.source)?.kind
  return typeof kind === 'string' ? kind : undefined
}

export function isExcludedRecord(record: RawEventRecord): boolean {
  const kind = userSourceKind(record)
  return kind !== undefined && EXCLUDED_SOURCE_KINDS.has(kind)
}

export function isSyntheticRecord(record: RawEventRecord): boolean {
  const kind = userSourceKind(record)
  return kind !== undefined && SYNTHETIC_KINDS.has(kind)
}

/** A user or assistant conversation message; an episode without one is empty. */
export function isMessageRecord(record: RawEventRecord): boolean {
  if (record.type === 'assistant/message') return true
  return record.type === 'user/message' && !isSyntheticRecord(record)
}

function blockText(block: unknown): string {
  const value = asObject(block)
  if (value === undefined) return ''
  switch (value.type) {
    case 'text':
    case 'reasoning':
      return typeof value.text === 'string' ? value.text : ''
    case 'tool-call':
      return `${typeof value.name === 'string' ? value.name : ''} ${typeof value.arguments === 'string' ? value.arguments : ''}`
    default:
      return ''
  }
}

function contentText(content: unknown): string {
  return Array.isArray(content) ? content.map(blockText).filter(text => text !== '').join('\n') : ''
}

/**
 * Model-facing conversation text of one record, used for raw token estimates:
 * user messages (except synthetic ones), assistant content (text, reasoning,
 * tool calls), and tool results. Log-only events, system prompts, and tool
 * lists contribute nothing.
 */
export function recordText(record: RawEventRecord): string {
  const data = asObject(record.data)
  switch (record.type) {
    case 'user/message':
      return isSyntheticRecord(record) ? '' : contentText(data?.content)
    case 'assistant/message':
    case 'tool/result':
      return contentText(asObject(data?.message)?.content)
    default:
      return ''
  }
}

function isReasoningBlock(block: unknown): boolean {
  return asObject(block)?.type === 'reasoning'
}

function isReasoningStreamRecord(entry: unknown): boolean {
  const value = asObject(entry)
  if (value === undefined) return false
  if (value.type === 'reasoning-chunks') return true
  if (value.type !== 'chunk') return false
  const chunk = asObject(value.chunk)
  if (chunk === undefined) return false
  if (chunk.type === 'reasoning-delta') return true
  if (chunk.type === 'block-start') return chunk.blockType === 'reasoning'
  if (chunk.type === 'block-end') return isReasoningBlock(chunk.block)
  return false
}

function withoutReasoningBlocks(content: unknown): unknown {
  return Array.isArray(content) ? content.filter(block => !isReasoningBlock(block)) : content
}

function withoutReasoningStream(stream: unknown): unknown {
  return Array.isArray(stream) ? stream.filter(entry => !isReasoningStreamRecord(entry)) : stream
}

function withData(record: RawEventRecord, data: unknown): RawEventRecord {
  return { ...record, data }
}

/**
 * Drop reasoning from the places DSH stores it: `reasoning` content blocks of
 * assistant messages and compaction summaries, and reasoning deltas/runs of
 * embedded assistant streams. Every other field is kept as recorded.
 */
export function stripReasoning(record: RawEventRecord): RawEventRecord {
  const data = asObject(record.data)
  if (data === undefined) return record
  switch (record.type) {
    case 'assistant/message': {
      const message = asObject(data.message)
      return withData(record, {
        ...data,
        ...message === undefined ? {} : { message: { ...message, content: withoutReasoningBlocks(message.content) } },
        ...'stream' in data ? { stream: withoutReasoningStream(data.stream) } : {},
      })
    }
    case 'assistant/attempt':
      return 'stream' in data ? withData(record, { ...data, stream: withoutReasoningStream(data.stream) }) : record
    case 'compaction/summary':
      return withData(record, {
        ...data,
        ...'summary' in data ? { summary: withoutReasoningBlocks(data.summary) } : {},
        ...'rawOutput' in data ? { rawOutput: withoutReasoningBlocks(data.rawOutput) } : {},
      })
    default:
      return record
  }
}

/** `compaction/summary.shadowedSeqs` (surface order), ignoring malformed entries. */
export function readShadowedSeqs(record: RawEventRecord): number[] {
  const seqs = asObject(record.data)?.shadowedSeqs
  return Array.isArray(seqs) ? seqs.filter((seq): seq is number => typeof seq === 'number' && Number.isSafeInteger(seq)) : []
}
