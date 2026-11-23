import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ScopeDecision, ScopeId } from '../../src/contracts.ts'
import type {
  InjectAgent,
  InjectLogger,
  Injector,
  InjectSession,
  InjectSessionHeader,
  InjectSurfaceEvent,
  PreStepPayload,
} from '../../src/inject/index.ts'

interface LoggedEvent extends InjectSurfaceEvent {
  readonly seq: number
}

export class FakeSession implements InjectSession {
  readonly log: LoggedEvent[] = []
  nodes: number[] = []

  constructor(readonly id: string, readonly header: InjectSessionHeader = {}) {}

  get seq(): number {
    return this.log.length
  }

  get surface(): { readonly nodes: readonly number[] } {
    return { nodes: this.nodes }
  }

  eventAt(seq: number): InjectSurfaceEvent | undefined {
    return this.log[seq]
  }

  private push(type: string, data: unknown): number {
    const seq = this.log.length
    this.log.push({ seq, type, data })
    return seq
  }

  appendMessage(message: unknown): number {
    const seq = this.push('user/message', message)
    this.nodes.push(seq)
    return seq
  }

  appendAssistant(text: string): number {
    const seq = this.push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
    this.nodes.push(seq)
    return seq
  }

  appendLogOnly(type: string): void {
    this.push(type, {})
  }

  /** Replace every surface node after the system head with one checkpoint, like a retain-0 compaction. */
  compact(summary: string): number {
    const seq = this.push('user/message', {
      role: 'user',
      content: [
        { type: 'text', text: 'This is an automatically generated checkpoint.\n\n<compacted-summary>' },
        { type: 'text', text: summary },
        { type: 'text', text: '</compacted-summary>' },
      ],
      source: { kind: 'compact-checkpoint', compactionId: `c${this.log.length}` },
    })
    this.nodes = [...this.nodes.slice(0, 1), seq]
    return seq
  }

  memoryMessages(): unknown[] {
    return this.nodes
      .map(seq => this.log[seq])
      .filter(event => event?.type === 'user/message' && (event.data as UserMessage).source.kind === 'memory-cloud')
      .map(event => event?.data)
  }
}

export interface FakeAgent extends InjectAgent {
  readonly session: FakeSession
  readonly name: string
}

export function fakeAgent(id: string, header: InjectSessionHeader = {}): FakeAgent {
  const session = new FakeSession(id, header)
  session.log.push({ seq: 0, type: 'system/message', data: { message: { role: 'system', content: [] } } })
  session.nodes.push(0)
  return { session, name: id }
}

export function prompt(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

export function runtimeContext(): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: '<runtime-context/>' }], source: { kind: 'user' } })
}

export const selection: Readonly<ModelSelection> = { provider: 'fake', model: 'fake-1' }

export interface StepOptions {
  readonly turn: number
  readonly step: number
  readonly claimed?: readonly UserMessage[]
  readonly context?: UserMessage
  readonly signal?: AbortSignal
  readonly inner?: PreStepDecision
  /** Simulate an outer listener rejecting the step after ours ran: nothing is appended. */
  readonly drop?: boolean
}

/** Run one pre-step like the agent loop does and append the admitted messages. */
export async function step<A extends FakeAgent>(injector: Injector<A>, agent: A, options: StepOptions): Promise<PreStepDecision> {
  const claimed = [...options.claimed ?? []]
  const payload: PreStepPayload<A> = {
    agent,
    messages: claimed,
    turn: options.turn,
    step: options.step,
    signal: options.signal ?? new AbortController().signal,
    modelSelection: selection,
  }
  const inner: PreStepDecision = options.inner ?? {
    kind: 'enter',
    messages: options.context === undefined ? claimed : [...claimed, options.context],
  }
  const decision = await injector.preStep(payload, async () => inner)
  if (decision.kind === 'enter' && !options.drop) {
    for (const message of decision.messages) agent.session.appendMessage(message)
    agent.session.appendAssistant(`reply ${options.turn}.${options.step}`)
  }
  return decision
}

export function ownerScope(capture = true): ScopeDecision {
  return { scope: 'owner' as ScopeId, capture, private: true, reason: 'test' }
}

export class FakeClock {
  current = Date.UTC(2026, 10, 23, 7, 0, 0)
  now(): number {
    return this.current
  }
}

export interface RecordedLogger extends InjectLogger {
  readonly lines: { readonly level: string; readonly text: string }[]
}

export function recordingLogger(): RecordedLogger {
  const lines: { level: string; text: string }[] = []
  const record = (level: string) => (format: string, ...args: unknown[]) => {
    let index = 0
    lines.push({ level, text: format.replace(/%[sd]/g, () => String(args[index++])) })
  }
  return { lines, debug: record('debug'), info: record('info'), warn: record('warn') }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
