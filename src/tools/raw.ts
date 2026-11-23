import type { RawEventRecord } from '../contracts.ts'
import { clip, localTime } from './text.ts'

const SKIPPED_TYPES = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end', 'request/header', 'request/context',
  'assistant/attempt', 'system/message', 'developer/message', 'tool/call', 'session/title',
  'session/title-llm-request', 'permission/preset', 'sandbox/mode', 'approval/policy',
  'agent/inbox/spliced', 'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune',
])

const TOOL_RESULT_CHARS = 1200
const TOOL_ARGUMENT_CHARS = 300
const REASONING_CHARS = 300
const OTHER_EVENT_CHARS = 200

export interface RawTextOptions {
  /** Per-record character ceiling. */
  readonly maxChars: number
  /** Include a clipped excerpt of model reasoning. */
  readonly reasoning: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function attachmentName(block: Record<string, unknown>): string | undefined {
  const attachment = block.attachment
  if (!isRecord(attachment)) return undefined
  const name = attachment.name ?? attachment.fileName
  return typeof name === 'string' && name !== '' ? name : undefined
}

function blocksText(content: unknown, options: RawTextOptions): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text !== '') parts.push(block.text)
        break
      case 'reasoning':
        if (options.reasoning && typeof block.text === 'string' && block.text !== '') {
          parts.push(`(thinking) ${clip(block.text, REASONING_CHARS)}`)
        }
        break
      case 'tool-call': {
        const name = typeof block.name === 'string' ? block.name : 'tool'
        const args = typeof block.arguments === 'string' ? clip(block.arguments, TOOL_ARGUMENT_CHARS) : ''
        parts.push(`→ ${name}(${args})`)
        break
      }
      case 'image':
        parts.push('[image]')
        break
      case 'file': {
        const name = attachmentName(block)
        parts.push(name === undefined ? '[file]' : `[file ${name}]`)
        break
      }
      default:
        break
    }
  }
  return parts.join('\n')
}

function preview(value: unknown): string {
  try {
    return clip(JSON.stringify(value) ?? '', OTHER_EVENT_CHARS)
  } catch {
    return ''
  }
}

function sourceKind(data: Record<string, unknown>): string | undefined {
  return isRecord(data.source) && typeof data.source.kind === 'string' ? data.source.kind : undefined
}

/**
 * Whether a raw record is conversation: a `user/message` from the user
 * (`source.kind` `user` or none), an assistant message (text and tool calls),
 * or a tool result. Everything else is a system record: the shared
 * `SYNTHETIC_SOURCE_KINDS` messages (runtime-context reminders, compaction
 * checkpoints, injected memory blocks), other plugins' user messages, and
 * `turn/*`, `step/*`, `request/*`, `compaction/*` and other log events.
 */
export function isConversationRecord(record: RawEventRecord): boolean {
  const data = record.data
  switch (record.type) {
    case 'user/message': {
      if (!isRecord(data)) return false
      const kind = sourceKind(data)
      return kind === undefined || kind === 'user'
    }
    case 'assistant/message':
    case 'tool/result':
      return true
    default:
      return false
  }
}

/** Speaker-labelled text of one raw record, or undefined for bookkeeping events. */
export function rawRecordText(record: RawEventRecord, options: RawTextOptions): string | undefined {
  if (SKIPPED_TYPES.has(record.type)) return undefined
  const data = record.data
  let label: string
  let text: string
  let limit = options.maxChars
  switch (record.type) {
    case 'user/message': {
      if (!isRecord(data)) return undefined
      const kind = sourceKind(data) ?? 'user'
      label = kind === 'user' ? 'user' : `user[${kind}]`
      text = blocksText(data.content, options)
      break
    }
    case 'assistant/message': {
      if (!isRecord(data) || !isRecord(data.message)) return undefined
      label = data.interrupted === true ? 'assistant (interrupted)' : 'assistant'
      text = blocksText(data.message.content, options)
      break
    }
    case 'tool/result': {
      if (!isRecord(data) || !isRecord(data.message)) return undefined
      label = data.message.isError === true ? '← tool error' : '← tool'
      text = blocksText(data.message.content, options)
      limit = Math.min(limit, TOOL_RESULT_CHARS)
      break
    }
    default:
      label = `[${record.type}]`
      text = preview(data)
      break
  }
  const trimmed = text.replace(/\n{3,}/g, '\n\n').trim()
  if (trimmed === '') return undefined
  return `${label}: ${clip(trimmed, limit)}`
}

/** One compact transcript line: `#seq HH:mm speaker: text`. */
export function renderRawRecord(record: RawEventRecord, options: RawTextOptions): string | undefined {
  const text = rawRecordText(record, options)
  if (text === undefined) return undefined
  const time = Number.isFinite(record.time) ? ` ${localTime(record.time)}` : ''
  return `#${record.seq}${time} ${text}`
}
