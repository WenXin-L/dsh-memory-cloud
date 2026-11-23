import type { RawEventRecord, TokenEstimator } from '../contracts.ts'
import { SYNTHETIC_SOURCE_KINDS } from '../contracts.ts'
import { clipMiddle, createTimeFormatter, splitPoint, tidyBlock } from './text.ts'

/** `user/message` source kinds that never reach a transcript, even when listed in `includeSourceKinds`. */
export const EXCLUDED_SOURCE_KINDS: readonly string[] = SYNTHETIC_SOURCE_KINDS

export interface TranscriptLabels {
  readonly user: string
  readonly assistant: string
  readonly reasoning: string
  readonly toolCall: string
  readonly toolResult: string
  readonly toolError: string
}

export const DEFAULT_TRANSCRIPT_LABELS: TranscriptLabels = {
  user: 'User',
  assistant: 'Assistant',
  reasoning: 'Assistant (thinking)',
  toolCall: 'Tool call',
  toolResult: 'Tool result',
  toolError: 'Tool error',
}

export interface TranscriptOptions {
  /** IANA zone for timestamps; defaults to the host zone. */
  readonly timeZone?: string
  /** Render assistant reasoning blocks (default false). */
  readonly includeReasoning?: boolean
  /** Head+tail clip for one user/assistant text (default 6000 chars; ≤ 0 keeps everything). */
  readonly messageChars?: number
  /** Head+tail clip for one reasoning block (default 1000 chars). */
  readonly reasoningChars?: number
  /** Head+tail clip for tool-call arguments (default 400 chars). */
  readonly toolArgumentChars?: number
  /** Head+tail clip for one tool result (default 1200 chars). */
  readonly toolResultChars?: number
  /**
   * `user/message` source kinds rendered as conversation input besides `user`
   * (for example a chat bridge's own kind). {@link EXCLUDED_SOURCE_KINDS} always lose.
   */
  readonly includeSourceKinds?: readonly string[]
  readonly labels?: Partial<TranscriptLabels>
}

/** Whether a `user/message` with this `source.kind` is conversation input (absent kind counts as `user`). */
export function isConversationSource(kind: string | undefined, includeSourceKinds: readonly string[] = []): boolean {
  if (kind === undefined || kind === 'user') return true
  if (EXCLUDED_SOURCE_KINDS.includes(kind)) return false
  return includeSourceKinds.includes(kind)
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function blocksOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function attachmentName(block: Json): string | undefined {
  return isRecord(block.attachment) ? str(block.attachment.name) : undefined
}

function inlineContent(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    switch (block.type) {
      case 'text': {
        const text = str(block.text)
        if (text !== undefined) parts.push(text)
        break
      }
      case 'image': {
        const name = attachmentName(block)
        parts.push(name === undefined ? '[image]' : `[image: ${name}]`)
        break
      }
      case 'file': {
        const name = attachmentName(block)
        parts.push(name === undefined ? '[file]' : `[file: ${name}]`)
        break
      }
    }
  }
  return parts.join('\n')
}

function compactArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw))
  } catch {
    return raw
  }
}

function indentContinuation(text: string): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 || line.length === 0 ? line : `  ${line}`))
    .join('\n')
}

/**
 * Render captured DSH session events as a compact timestamped transcript of
 * user/assistant text, tool calls, and tool results. Each entry starts at
 * column 0 (`[time] Label: text`) and continuation lines are indented, so
 * {@link splitTranscriptEntries} can recover record boundaries. Plugin-injected
 * `user/message` sources (checkpoints, runtime context, memory blocks, other
 * non-`user` kinds) are skipped.
 */
export function renderTranscript(records: readonly RawEventRecord[], opts: TranscriptOptions = {}): string {
  const formatter = createTimeFormatter(opts.timeZone)
  const labels = { ...DEFAULT_TRANSCRIPT_LABELS, ...opts.labels }
  const messageChars = opts.messageChars ?? 6000
  const reasoningChars = opts.reasoningChars ?? 1000
  const toolArgumentChars = opts.toolArgumentChars ?? 400
  const toolResultChars = opts.toolResultChars ?? 1200
  const includeSourceKinds = opts.includeSourceKinds ?? []
  const toolNames = new Map<string, string>()
  const renderedCalls = new Set<string>()
  const entries: string[] = []
  let lastDate: string | undefined

  const push = (time: number, label: string, body: string, maxChars: number): void => {
    const text = tidyBlock(clipMiddle(tidyBlock(body), maxChars))
    if (text.length === 0) return
    const date = formatter.date(time)
    const stamp = date === lastDate ? formatter.time(time) : formatter.weekdayDateTime(time)
    lastDate = date
    entries.push(`[${stamp}] ${label}: ${indentContinuation(text)}`)
  }

  const pushCall = (time: number, callId: string | undefined, name: string, args: string): void => {
    if (callId !== undefined) {
      toolNames.set(callId, name)
      if (renderedCalls.has(callId)) return
      renderedCalls.add(callId)
    }
    const argText = clipMiddle(compactArguments(args.trim()), toolArgumentChars)
    push(time, labels.toolCall, argText.length > 0 && argText !== '{}' ? `${name} ${argText}` : name, 0)
  }

  for (const record of records) {
    const data = record.data
    if (!isRecord(data)) continue
    switch (record.type) {
      case 'user/message': {
        const kind = isRecord(data.source) ? str(data.source.kind) : undefined
        if (!isConversationSource(kind, includeSourceKinds)) break
        push(record.time, labels.user, inlineContent(blocksOf(data.content)), messageChars)
        break
      }
      case 'assistant/message': {
        const message = data.message
        if (!isRecord(message)) break
        const label = data.interrupted === true ? `${labels.assistant} (interrupted)` : labels.assistant
        let text: string[] = []
        const flush = (): void => {
          if (text.length > 0) push(record.time, label, text.join('\n'), messageChars)
          text = []
        }
        for (const block of blocksOf(message.content)) {
          if (!isRecord(block)) continue
          if (block.type === 'text') {
            const value = str(block.text)
            if (value !== undefined) text.push(value)
          } else if (block.type === 'reasoning') {
            if (opts.includeReasoning !== true) continue
            flush()
            push(record.time, labels.reasoning, str(block.text) ?? '', reasoningChars)
          } else if (block.type === 'tool-call') {
            flush()
            pushCall(record.time, str(block.id), str(block.name) ?? 'tool', str(block.arguments) ?? '')
          }
        }
        flush()
        break
      }
      case 'tool/call': {
        pushCall(record.time, str(data.callId), str(data.name) ?? 'tool', str(data.arguments) ?? '')
        break
      }
      case 'tool/result': {
        const message = data.message
        if (!isRecord(message)) break
        const callId = str(message.toolCallId)
        const name = (callId === undefined ? undefined : toolNames.get(callId)) ?? 'tool'
        const label = message.isError === true ? labels.toolError : labels.toolResult
        const body = inlineContent(blocksOf(message.content))
        push(record.time, `${label} (${name})`, body.trim().length > 0 ? body : '(empty)', toolResultChars)
        break
      }
    }
  }
  return entries.join('\n')
}

/** Split a transcript into entries: a new entry starts at every line whose first character is not whitespace. */
export function splitTranscriptEntries(transcript: string): string[] {
  const entries: string[] = []
  let current: string[] = []
  for (const line of transcript.split('\n')) {
    if (/^\S/.test(line) && current.length > 0) {
      entries.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) entries.push(current.join('\n'))
  return entries.map(entry => entry.trimEnd()).filter(entry => entry.trim().length > 0)
}

/** Pack transcript entries into chunks whose estimate stays within `maxTokens`; an oversized entry is split on lines. */
export function chunkTranscript(transcript: string, maxTokens: number, estimator: TokenEstimator): string[] {
  const pieces: string[] = []
  for (const entry of splitTranscriptEntries(transcript)) {
    let rest = entry
    while (rest.length > 0 && estimator.estimate(rest) > maxTokens) {
      const cut = splitPoint(rest, maxTokens, estimator)
      pieces.push(rest.slice(0, cut).trimEnd())
      rest = rest.slice(cut).replace(/^\n+/, '')
    }
    if (rest.trim().length > 0) pieces.push(rest)
  }
  const chunks: string[] = []
  let current: string[] = []
  let tokens = 0
  for (const piece of pieces) {
    const cost = estimator.estimate(piece) + 1
    if (current.length > 0 && tokens + cost > maxTokens) {
      chunks.push(current.join('\n'))
      current = []
      tokens = 0
    }
    current.push(piece)
    tokens += cost
  }
  if (current.length > 0) chunks.push(current.join('\n'))
  return chunks
}
