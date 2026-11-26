import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { RawEventRecord, SessionDescriptor } from '../contracts.ts'
import type { Capture } from './capture.ts'

export interface AttachCaptureOptions {
  /**
   * Build a session's descriptor; called for every event, so cache inside the
   * describer when building is costly. Returning a different object makes the
   * capture re-resolve the session's scope. Defaults to the header-only
   * {@link describeSessionHeader}; pass a describer that adds chat-bridge tags
   * when scope rules need them.
   */
  readonly describe?: (session: Session) => SessionDescriptor
  /** Run `capture.sealIdle()` on this interval; omitted or `0` leaves idle sealing to the caller. */
  readonly idleCheckIntervalMs?: number
}

/** Header-derived {@link SessionDescriptor} without tags. */
export function describeSessionHeader(header: SessionHeader): SessionDescriptor {
  return {
    sessionId: header.id,
    ...header.origin === 'subagent' ? { origin: 'subagent' as const } : {},
    ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
    ...header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth },
    ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
  }
}

/** The session event envelope as a raw archive record, including the `ignorable` marker when set. */
export function toRawEventRecord(event: SessionEvent): RawEventRecord {
  return {
    seq: event.seq,
    time: event.time,
    type: event.type,
    data: event.data,
    ...event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp },
    ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
    ...event.ignorable === undefined ? {} : { ignorable: event.ignorable },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Feed `session/event` into `capture`, write buffers on `session/flush`, and
 * seal on `session/disposed`. Every handler is synchronous and hands work to
 * the capture queue, whose promises never reject. The returned disposer (also
 * run when the owning fiber unloads) removes the listeners and the idle timer;
 * it does not flush, so call `capture.dispose()` as well.
 */
export function attachCaptureToDsh(ctx: Context, capture: Capture, options: AttachCaptureOptions = {}): () => Promise<void> {
  const describe = options.describe ?? ((session: Session) => describeSessionHeader(session.header))

  const warn = (message: string, error: unknown) => {
    try {
      ctx.logger.warn(`memory-cloud capture: ${message}: ${errorText(error)}`)
    } catch {}
  }

  return ctx.effect(() => {
    const disposers = [
      ctx.on('session/event', (session, event) => {
        try {
          capture.handleEvent(describe(session), toRawEventRecord(event))
        } catch (error) {
          warn('session/event handler failed', error)
        }
      }),
      ctx.on('session/flush', (session) => {
        try {
          void capture.flushSession(session.id).catch((error: unknown) => warn('flush failed', error))
        } catch (error) {
          warn('session/flush handler failed', error)
        }
      }),
      ctx.on('session/disposed', (session) => {
        try {
          void capture.sealSession(session.id, 'end').catch((error: unknown) => warn('end seal failed', error))
        } catch (error) {
          warn('session/disposed handler failed', error)
        }
      }),
    ]
    const intervalMs = options.idleCheckIntervalMs ?? 0
    const timer = intervalMs > 0
      ? setInterval(() => {
        try {
          void capture.sealIdle().catch((error: unknown) => warn('idle seal failed', error))
        } catch (error) {
          warn('idle check failed', error)
        }
      }, intervalMs)
      : undefined
    if (timer !== undefined) (timer as { unref?: () => void }).unref?.()
    return () => {
      for (const dispose of disposers) dispose()
      if (timer !== undefined) clearInterval(timer)
    }
  }, 'memory-cloud.capture')
}
