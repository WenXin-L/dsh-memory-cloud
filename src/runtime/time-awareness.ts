import { symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, GenerateOptions, LlmRuntime, MessageId, RequestMessage, StreamChunk, TextBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const chinaTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function timestamp(time: number): string | undefined {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return undefined
  const parts = Object.fromEntries(chinaTime.formatToParts(date).map(part => [part.type, part.value]))
  return `[${parts.weekday} ${parts.year!.padStart(4, '0')}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} CST]`
}

function originalMessageTime(session: Session, event: SessionEvent, id: MessageId): number {
  // Tool-result pruning can replace a surface event while keeping its message identity.
  // A new checkpoint has a different identity and gets its own event time.
  while (event.sourceEventSeqs !== undefined) {
    let prior: SessionEvent | undefined
    for (const seq of event.sourceEventSeqs) {
      if (seq >= event.seq || (prior !== undefined && seq >= prior.seq)) continue
      const source = session.eventAt(seq)
      if (source !== undefined && session.deriveEventMessage(source)?.id === id) prior = source
    }
    if (prior === undefined) break
    event = prior
  }
  return event.time
}

function messageTimes(session: Session): ReadonlyMap<MessageId, number> {
  const times = new Map<MessageId, number>()
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const message = session.deriveEventMessage(event)
    if (message !== null && !times.has(message.id)) times.set(message.id, originalMessageTime(session, event, message.id))
  }
  return times
}

type ReplayBlock = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** These native envelopes keep one replay entry per neutral content block. */
function alignedReplay(value: unknown, content: readonly ContentBlock[]):
  (Readonly<Record<string, unknown>> & { readonly blocks: readonly ReplayBlock[] }) | undefined {
  if (!isRecord(value) || !isRecord(value.response) || !Array.isArray(value.blocks)) return undefined
  const { kind, version } = value.response
  if (!(kind === 'deepseek-messages' && version === 1 || kind === 'pi-ai' && version === 2)) return undefined
  if (value.blocks.length !== content.length || !value.blocks.every((block, index) => isRecord(block) && block.type === content[index]?.type)) return undefined
  return { ...value, blocks: value.blocks }
}

function prefixBlock(prefix: string, text = ''): TextBlock {
  return Object.freeze({ type: 'text', text: text.length === 0 ? prefix : `${prefix} ${text}` })
}

function prefixAssistant(message: AssistantMessage, prefix: string): AssistantMessage {
  const { content, source } = message
  const replay = alignedReplay(source.replayState, content)
  if (source.replayState !== undefined && replay === undefined) return message

  // Native thinking stays in front. A separate text block preserves signed text and tool inputs.
  const firstVisible = content.findIndex(block => block.type !== 'reasoning')
  const index = firstVisible === -1 ? content.length : firstVisible
  const first = content[index]
  if (first?.type === 'text' && replay?.blocks[index]?.textSignature === undefined) {
    return Object.freeze({ ...message, content: Object.freeze(content.with(index, prefixBlock(prefix, first.text))) })
  }
  const prefixed = Object.freeze(content.toSpliced(index, 0, prefixBlock(prefix)))
  if (replay === undefined) return Object.freeze({ ...message, content: prefixed })
  const blocks = Object.freeze(replay.blocks.toSpliced(index, 0, Object.freeze({ type: 'text' })))
  return Object.freeze({
    ...message,
    content: prefixed,
    source: Object.freeze({ ...source, replayState: Object.freeze({ ...replay, blocks }) }),
  })
}

function prefixMessage(message: RequestMessage, prefix: string): RequestMessage {
  if (message.role === 'assistant') return prefixAssistant(message, prefix)
  const [first] = message.content
  const content = first?.type === 'text'
    ? message.content.with(0, prefixBlock(prefix, first.text))
    : [prefixBlock(prefix), ...message.content]
  return Object.freeze({ ...message, content: Object.freeze(content) })
}

function prefixRequest(request: GenerateOptions, times: ReadonlyMap<MessageId, number>): GenerateOptions {
  let changed = false
  const messages = request.messages.map(message => {
    const time = message.id === undefined ? undefined : times.get(message.id)
    const prefix = time === undefined ? undefined : timestamp(time)
    if (prefix === undefined) return message
    const projected = prefixMessage(message, prefix)
    changed ||= projected !== message
    return projected
  })
  if (!changed) return request
  Object.freeze(messages)
  return Object.freeze({ ...request, messages })
}

type SessionLookup = (sessionId: string) => Session | undefined

interface PreparedDispatch {
  dispatch(request: GenerateOptions): AsyncIterable<StreamChunk>
}

type AdapterStream = (this: LlmRuntime, request: GenerateOptions, prepared?: PreparedDispatch) => AsyncIterable<StreamChunk>

interface Attachment {
  readonly lookups: Set<SessionLookup>
  restore(): void
}

const attachments = new WeakMap<LlmRuntime, Attachment>()

function attachAdapterStream(runtime: LlmRuntime): Attachment | undefined {
  const original = Reflect.get(runtime, 'adapterStream') as AdapterStream | undefined
  if (typeof original !== 'function') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(runtime, 'adapterStream')
  const lookups = new Set<SessionLookup>()

  // DSH 0.2 freezes loop requests and its public waterfall cannot replace them.
  // Wrap the prepared dispatch so middleware, route resolution and provider projections still use the logged request.
  const adapterStream: AdapterStream = function (request, prepared) {
    if (request.sessionId === undefined || request.purpose !== undefined || !isAgentLoopRequest(request)) {
      return original.call(this, request, prepared)
    }
    for (const lookup of lookups) {
      const session = lookup(request.sessionId)
      if (session === undefined) continue
      const times = messageTimes(session)
      if (prepared === undefined) return original.call(this, prefixRequest(request, times))
      return original.call(this, request, {
        ...prepared,
        dispatch: projected => prepared.dispatch(prefixRequest(projected, times)),
      })
    }
    return original.call(this, request, prepared)
  }

  const installed = Reflect.defineProperty(runtime, 'adapterStream', {
    value: adapterStream, configurable: true, writable: true,
  })
  if (!installed) return undefined
  return {
    lookups,
    restore() {
      if (Reflect.get(runtime, 'adapterStream') !== adapterStream) return
      if (descriptor === undefined) Reflect.deleteProperty(runtime, 'adapterStream')
      else Object.defineProperty(runtime, 'adapterStream', descriptor)
    },
  }
}

export function attachTimeAwareness(ctx: Context, enabled: () => boolean, sessionOf: SessionLookup): void {
  ctx.effect(() => {
    const service = ctx.llm
    const runtime: LlmRuntime = Reflect.get(service, symbols.original) ?? service
    const attachment = attachments.get(runtime) ?? attachAdapterStream(runtime)
    if (attachment === undefined) {
      let warned = false
      const warnIfEnabled = () => {
        if (warned || !enabled()) return
        warned = true
        ctx.logger.warn('Time awareness is unavailable on this version of the DSH LLM runtime.')
      }
      warnIfEnabled()
      return ctx.on('loader/volatile-update', warnIfEnabled)
    }

    attachments.set(runtime, attachment)
    const lookup: SessionLookup = id => enabled() ? sessionOf(id) : undefined
    attachment.lookups.add(lookup)
    return () => {
      attachment.lookups.delete(lookup)
      if (attachment.lookups.size !== 0) return
      attachment.restore()
      attachments.delete(runtime)
    }
  }, 'memory-cloud: time awareness')
}
