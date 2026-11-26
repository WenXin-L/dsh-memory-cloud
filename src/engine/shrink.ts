/**
 * DSH's shrink guard (`dsh-compaction-basic/src/region.ts`) rejects a
 * checkpoint whose framed size is not below the replaced span. These helpers
 * reproduce its fixed 4-chars/token heuristic (`dsh-token-meter/src/estimate.ts`)
 * so the engine can enforce a safety margin before handing text back.
 */

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

/** Text compaction-basic wraps around every summary (`frameSummary`). */
const CHECKPOINT_OPEN =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>'
const CHECKPOINT_CLOSE = '</compacted-summary>'

/** Framing price of a checkpoint message excluding the summary text block itself. */
const FRAME_TOKENS = textBlockTokens(CHECKPOINT_OPEN.length) + textBlockTokens(CHECKPOINT_CLOSE.length) + ROLE_OVERHEAD

/** Share of the replaced region a checkpoint may occupy. */
export const DEFAULT_SHRINK_RATIO = 0.5

/** Below this cap no useful memory checkpoint fits the shrink guard, so the engine does not call the composer. */
export const MIN_CHECKPOINT_CHARS = 256

/** Structural view of a DSH `Message`, so these helpers stay framework-agnostic. */
export interface MessageLike {
  readonly role: string
  readonly content: readonly { readonly type: string }[]
}

export interface RegionMeasure<M extends MessageLike = MessageLike> {
  /** Region messages in surface order, without the leading system head. */
  readonly messages: readonly M[]
  readonly chars: number
  /** Heuristic tokens under DSH's 4-chars/token pricing. */
  readonly tokens: number
}

/** Split off the replayed system head (surface node 0) and price the rest. */
export function measureRegion<M extends MessageLike>(messages: readonly M[]): RegionMeasure<M> {
  const region = messages[0]?.role === 'system' ? messages.slice(1) : messages
  let chars = 0
  let tokens = 0
  for (const message of region) {
    chars += messageChars(message)
    tokens += estimateMessageTokens(message)
  }
  return { messages: region, chars, tokens }
}

/** `estimateMessage` from dsh-token-meter. */
export function estimateMessageTokens(message: MessageLike): number {
  if (message.role === 'system') {
    if (message.content.length === 0) return 0
    let characters = 0
    for (const block of message.content) {
      const text = textOf(block)
      characters += text === undefined ? JSON.stringify(block).length : text.length
    }
    return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
  }
  let tokens = ROLE_OVERHEAD
  for (const block of message.content) {
    const text = textOf(block)
    if (text !== undefined) {
      tokens += textBlockTokens(text.length)
      continue
    }
    const call = toolCallOf(block)
    tokens += call === undefined
      ? BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
      : Math.ceil(call.name.length / CHARS_PER_TOKEN) + Math.ceil(call.arguments.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  }
  return tokens
}

/**
 * Price `messages` (minus a leading system head) twice: with DSH's heuristic
 * and with `estimate` (a real-token estimator), using the same role and block
 * framing for both.
 */
export function priceConversation(messages: readonly MessageLike[], estimate: (text: string) => number): { readonly meterTokens: number; readonly realTokens: number } {
  const region = messages[0]?.role === 'system' ? messages.slice(1) : messages
  let meterTokens = 0
  let realTokens = 0
  for (const message of region) {
    meterTokens += estimateMessageTokens(message)
    realTokens += ROLE_OVERHEAD
    for (const block of message.content) {
      const text = textOf(block)
      const call = text === undefined ? toolCallOf(block) : undefined
      const content = text ?? (call === undefined ? JSON.stringify(block) : `${call.name}${call.arguments}`)
      realTokens += BLOCK_OVERHEAD + Math.max(0, estimate(content))
    }
  }
  return { meterTokens, realTokens }
}

/** Heuristic tokens of the user message DSH lands for `text` (preamble, tags, and role framing included). */
export function framedCheckpointTokens(text: string): number {
  return FRAME_TOKENS + textBlockTokens(text.length)
}

/** Whether the framed checkpoint stays strictly below `ratio` of the region's heuristic size. */
export function fitsShrinkGuard(text: string, regionTokens: number, ratio = DEFAULT_SHRINK_RATIO): boolean {
  return framedCheckpointTokens(text) < regionTokens * ratio
}

/** Longest checkpoint text, in characters, that still satisfies {@link fitsShrinkGuard}; 0 when none fits. */
export function maxCheckpointChars(regionTokens: number, ratio = DEFAULT_SHRINK_RATIO): number {
  const limit = regionTokens * ratio
  const textTokens = Math.ceil(limit - FRAME_TOKENS - BLOCK_OVERHEAD) - 1
  return textTokens > 0 ? textTokens * CHARS_PER_TOKEN : 0
}

function messageChars(message: MessageLike): number {
  let chars = 0
  for (const block of message.content) {
    const text = textOf(block)
    if (text !== undefined) {
      chars += text.length
      continue
    }
    const call = toolCallOf(block)
    chars += call === undefined ? JSON.stringify(block).length : call.name.length + call.arguments.length
  }
  return chars
}

function textBlockTokens(length: number): number {
  return Math.ceil(length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

function textOf(block: { readonly type: string }): string | undefined {
  if (block.type !== 'text' && block.type !== 'reasoning') return undefined
  const text = (block as { readonly text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

function toolCallOf(block: { readonly type: string }): { readonly name: string; readonly arguments: string } | undefined {
  if (block.type !== 'tool-call') return undefined
  const { name, arguments: args } = block as { readonly name?: unknown; readonly arguments?: unknown }
  return { name: typeof name === 'string' ? name : '', arguments: typeof args === 'string' ? args : '' }
}
