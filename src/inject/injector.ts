import type { ModelSelection, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import { MEMORY_SOURCE_KIND, OWNER_SCOPE } from '../contracts.ts'
import type { Clock, EffectiveMode, ScopeDecision, ScopeId, SessionDescriptor } from '../contracts.ts'
import { MEMORY_BLOCK_HEADER, MEMORY_BLOCK_OPEN } from '../pack/index.ts'
import { canReadScope } from '../scope/guard.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-cloud': { kind: 'memory-cloud' } & ContextFormed
  }
}

export const DEFAULT_PACK_TIMEOUT_MS = 1500
export const DEFAULT_MAX_SESSIONS = 256
/** An unsettled pack older than this no longer blocks a fresh attempt. */
export const STALE_PACK_MS = 60_000

const CHECKPOINT_SOURCE_KIND = 'compact-checkpoint'
const SUMMARY_OPEN_TAG = '<compacted-summary>'
/** How every block we pack starts; anything else that mentions the tag is not ours. */
export const MEMORY_BLOCK_OPENING = `${MEMORY_BLOCK_OPEN}\n${MEMORY_BLOCK_HEADER}`

/** The `SessionHeader` fields the injector reads. */
export interface InjectSessionHeader {
  readonly origin?: 'subagent'
  readonly parentSession?: string
  readonly delegationDepth?: number
  readonly agentPreset?: string
  readonly cwd?: string
}

export interface InjectSurfaceEvent {
  readonly type: string
  readonly data: unknown
}

/** Structural subset of a DSH `Session`. */
export interface InjectSession {
  readonly id: string
  readonly header: InjectSessionHeader
  /** Next event seq (log length); unique per session across restarts. */
  readonly seq: number
  readonly surface: { readonly nodes: readonly number[] }
  eventAt(seq: number): InjectSurfaceEvent | undefined
}

/** Structural subset of a DSH `Agent`. */
export interface InjectAgent {
  readonly session: InjectSession
}

/** The `agent/pre-step` payload fields the injector reads. */
export interface PreStepPayload<A extends InjectAgent = InjectAgent> {
  readonly agent: A
  readonly messages: readonly UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
  readonly modelSelection: Readonly<ModelSelection>
}

export type InjectReason = 'session-start' | 'refill'

export interface PackRequest<A extends InjectAgent = InjectAgent> {
  readonly agent: A
  readonly session: SessionDescriptor
  readonly scope: ScopeDecision
  readonly mode: Exclude<EffectiveMode, 'off'>
  /** `session-start` until the first compaction checkpoint is visible, `refill` afterwards. */
  readonly reason: InjectReason
  /** `session.seq` when packing started; a stable per-session ordinal for the snapshot file. */
  readonly atSeq: number
  readonly modelSelection: Readonly<ModelSelection>
  /** Aborted when the session is forgotten or the injector is disposed, not by the step timeout. */
  readonly signal: AbortSignal
}

export interface PackedMemory {
  /** Complete `<memory-cloud>` block. */
  readonly text: string
  readonly snapshotRef?: string | undefined
}

export interface InjectLogger {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

export interface InjectorDeps<A extends InjectAgent = InjectAgent> {
  /** Resolve the block to inject, `null` when there is nothing to inject; reject on failure. */
  readonly pack: (request: PackRequest<A>) => Promise<PackedMemory | null>
  readonly mode: (agent: A) => EffectiveMode
  readonly scopeFor: (session: SessionDescriptor, agent: A) => ScopeDecision
  readonly clock: Clock
  readonly logger: InjectLogger
  /** How long one step waits for packing before continuing without memory. */
  readonly timeoutMs?: number
  /** Per-session state entries kept before the least recently used is evicted. */
  readonly maxSessions?: number
}

export interface Injector<A extends InjectAgent = InjectAgent> {
  /** `agent/pre-step` waterfall listener. */
  preStep(payload: PreStepPayload<A>, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  /** The text frozen for a session, if packing produced one for its current compaction epoch. */
  frozen(sessionId: string): PackedMemory | undefined
  /** Drop a session's frozen text and abort its pending pack. */
  forget(sessionId: string): void
  /**
   * Like {@link forget} for a session whose scope changed: also keeps which
   * scope's block it last showed, so a stale owner block is still reported.
   */
  rescope(sessionId: string): void
  dispose(): void
}

/** What the visible surface says about memory. */
export interface SurfaceMemoryState {
  /** One of our injected messages is visible. */
  readonly hasMemoryBlock: boolean
  /** A visible compaction checkpoint body starts with one of our `<memory-cloud>` blocks (written by our engine). */
  readonly memoryCheckpoint: boolean
  /** Seq of the newest visible compaction checkpoint; changes whenever a compaction lands. */
  readonly epoch: number | undefined
}

interface Flight {
  readonly key: string
  readonly startedAt: number
  readonly controller: AbortController
  readonly promise: Promise<PackedMemory | null | undefined>
}

interface SessionState {
  frozen?: { readonly key: string; readonly memory: PackedMemory | null }
  flight?: Flight
  lastTurn?: number
  /** Scope of the block this injector last added to the session. */
  shown?: ScopeId
  /** `shown|scope` pair already warned about, so a stale block is reported once. */
  warned?: string
}

const TIMED_OUT: unique symbol = Symbol('timed out')

export function scanSurface(session: InjectSession): SurfaceMemoryState {
  let memoryCheckpoint = false
  let epoch: number | undefined
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const kind = sourceKind(event.data)
    if (kind === MEMORY_SOURCE_KIND) return { hasMemoryBlock: true, memoryCheckpoint, epoch }
    if (kind !== CHECKPOINT_SOURCE_KIND) continue
    if (epoch === undefined || seq > epoch) epoch = seq
    if (!memoryCheckpoint && startsWithMemoryBlock(messageText(event.data))) memoryCheckpoint = true
  }
  return { hasMemoryBlock: false, memoryCheckpoint, epoch }
}

/**
 * Whether a checkpoint body starts with our block: {@link MEMORY_BLOCK_OPENING}
 * at the very start of the text or right after DSH's `<compacted-summary>`
 * opening tag (whitespace allowed in between).
 */
export function startsWithMemoryBlock(text: string): boolean {
  for (let at = text.indexOf(MEMORY_BLOCK_OPENING); at >= 0; at = text.indexOf(MEMORY_BLOCK_OPENING, at + 1)) {
    const before = text.slice(0, at).trimEnd()
    if (before === '' || before.endsWith(SUMMARY_OPEN_TAG)) return true
  }
  return false
}

export function describeSession(session: InjectSession): SessionDescriptor {
  const { origin, parentSession, delegationDepth, agentPreset, cwd } = session.header
  return {
    sessionId: session.id,
    ...origin === undefined ? {} : { origin },
    ...parentSession === undefined ? {} : { parentSession },
    ...delegationDepth === undefined ? {} : { delegationDepth },
    ...agentPreset === undefined ? {} : { agentPreset },
    ...cwd === undefined ? {} : { cwd },
  }
}

export function isMemoryMessage(message: { readonly source: { readonly kind: string } }): boolean {
  return message.source.kind === MEMORY_SOURCE_KIND
}

export function createInjector<A extends InjectAgent>(deps: InjectorDeps<A>): Injector<A> {
  const { clock, logger } = deps
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PACK_TIMEOUT_MS
  const maxSessions = Math.max(1, deps.maxSessions ?? DEFAULT_MAX_SESSIONS)
  const sessions = new Map<string, SessionState>()

  function stateFor(sessionId: string): SessionState {
    let state = sessions.get(sessionId)
    if (state === undefined) state = {}
    else sessions.delete(sessionId)
    sessions.set(sessionId, state)
    for (const [id, evicted] of sessions) {
      if (sessions.size <= maxSessions) break
      sessions.delete(id)
      evicted.flight?.controller.abort()
    }
    return state
  }

  function launch(state: SessionState, request: Omit<PackRequest<A>, 'signal'>, key: string): Flight {
    const controller = new AbortController()
    const sessionId = request.session.sessionId
    const promise = Promise.resolve()
      .then(() => deps.pack({ ...request, signal: controller.signal }))
      .then(
        (memory) => {
          const settled = memory === null || memory.text.trim() === '' ? null : memory
          if (state.flight === flight) {
            delete state.flight
            state.frozen = { key, memory: settled }
          }
          return settled
        },
        (error: unknown) => {
          if (state.flight === flight) delete state.flight
          if (!controller.signal.aborted) logger.warn('memory packing failed for session %s: %s', sessionId, describeError(error))
          return undefined
        },
      )
    const flight: Flight = { key, startedAt: clock.now(), controller, promise }
    state.flight = flight
    return flight
  }

  async function resolveMemory(
    state: SessionState,
    request: Omit<PackRequest<A>, 'signal'>,
    epoch: number | undefined,
    signal: AbortSignal,
  ): Promise<PackedMemory | null | undefined> {
    const key = `${request.scope.scope}|${epoch ?? ''}`
    if (state.frozen !== undefined && state.frozen.key === key) return state.frozen.memory
    let flight = state.flight
    if (flight === undefined || flight.key !== key || clock.now() - flight.startedAt > STALE_PACK_MS) {
      flight?.controller.abort()
      flight = launch(state, request, key)
    }
    const outcome = await within(flight.promise, timeoutMs, signal)
    if (outcome !== TIMED_OUT) return outcome
    if (!signal.aborted) {
      logger.warn('memory packing for session %s exceeded %d ms; continuing without memory', request.session.sessionId, timeoutMs)
    }
    return undefined
  }

  async function recall(payload: PreStepPayload<A>, entering: readonly UserMessage[]): Promise<UserMessage | undefined> {
    const { agent, turn } = payload
    const session = agent.session
    if (session.header.origin === 'subagent') return undefined
    const mode = deps.mode(agent)
    if (mode === 'off') return undefined
    const descriptor = describeSession(session)
    const scope = deps.scopeFor(descriptor, agent)
    if (!scope.capture) return undefined

    const state = stateFor(session.id)
    const continuation = state.lastTurn === turn
    state.lastTurn = turn
    if (entering.length === 0 && !(continuation && payload.messages.length === 0)) return undefined
    if (entering.some(isMemoryMessage)) return undefined

    const surface = scanSurface(session)
    if (surface.hasMemoryBlock || surface.memoryCheckpoint) warnStale(state, scope, session.id)
    if (surface.hasMemoryBlock || surface.memoryCheckpoint || !canReadScope(scope)) return undefined

    const reason: InjectReason = surface.epoch === undefined ? 'session-start' : 'refill'
    const request = {
      agent,
      session: descriptor,
      scope,
      mode,
      reason,
      atSeq: session.seq,
      modelSelection: payload.modelSelection,
    }
    const memory = await resolveMemory(state, request, surface.epoch, payload.signal)
    if (memory === undefined || memory === null || payload.signal.aborted) return undefined
    state.shown = scope.scope
    delete state.warned
    logger.info(
      'injecting memory block into session %s (%s, %s mode, %d chars, snapshot %s)',
      session.id, reason, mode, memory.text.length, memory.snapshotRef ?? '-',
    )
    return createUserMessage({
      content: [{ type: 'text', text: memory.text }],
      source: { kind: MEMORY_SOURCE_KIND, form: 'recall' },
    })
  }

  function warnStale(state: SessionState, scope: ScopeDecision, sessionId: string): void {
    const shown = state.shown
    if (shown !== OWNER_SCOPE || canReadScope(scope, shown)) return
    const pair = `${shown}|${scope.scope}`
    if (state.warned === pair) return
    state.warned = pair
    logger.warn(
      'session %s now resolves to scope %s, but an owner memory block injected earlier is still visible; it leaves the context at the next compaction, so start a new session if this chat must not see owner memory',
      sessionId, scope.scope,
    )
  }

  return {
    async preStep(payload, next) {
      const decision = await next()
      if (decision.kind !== 'enter' || payload.signal.aborted) return decision
      try {
        const memory = await recall(payload, decision.messages)
        if (memory === undefined) return decision
        const at = decision.messages.findLastIndex(message => payload.messages.includes(message))
        return { ...decision, messages: decision.messages.toSpliced(at + 1, 0, memory) }
      } catch (error: unknown) {
        logger.warn('memory injection skipped for session %s: %s', sessionIdOf(payload.agent), describeError(error))
        return decision
      }
    },

    frozen(sessionId) {
      return sessions.get(sessionId)?.frozen?.memory ?? undefined
    },

    forget(sessionId) {
      const state = sessions.get(sessionId)
      if (state === undefined) return
      sessions.delete(sessionId)
      state.flight?.controller.abort()
    },

    rescope(sessionId) {
      const state = sessions.get(sessionId)
      if (state === undefined) return
      state.flight?.controller.abort()
      delete state.flight
      delete state.frozen
    },

    dispose() {
      for (const state of sessions.values()) state.flight?.controller.abort()
      sessions.clear()
    },
  }
}

async function within<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T | typeof TIMED_OUT> {
  if (signal.aborted) return TIMED_OUT
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(resolve, ms, TIMED_OUT)
    onAbort = () => resolve(TIMED_OUT)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, expiry])
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

function sourceKind(data: unknown): string | undefined {
  if (!isRecord(data) || !isRecord(data.source)) return undefined
  const kind = data.source.kind
  return typeof kind === 'string' ? kind : undefined
}

function messageText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.content)) return ''
  let text = ''
  for (const block of data.content as unknown[]) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sessionIdOf(agent: InjectAgent): string {
  try {
    return agent.session.id
  } catch {
    return '?'
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
