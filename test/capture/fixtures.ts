import type { CaptureStore } from '../../src/capture/capture.ts'
import type { EpisodeId, EpisodeMeta, MemoryIndex, RawEventRecord, RawPage, ScopeId, StoreState } from '../../src/contracts.ts'
import { EpisodeNotOpenError } from '../../src/store/owner.ts'

interface StoredEpisode {
  meta: EpisodeMeta
  raw: RawEventRecord[]
}

/** In-memory `MemoryStore` subset with the seal/append semantics capture relies on. */
export class FakeStore implements CaptureStore {
  readonly root = '/fake'
  readonly episodes = new Map<string, StoredEpisode>()
  state: StoreState = { version: 1, lastSeq: {}, queue: [] }
  failNext = new Map<string, number>()
  calls = 0
  readonly methods: string[] = []
  readonly claimed: EpisodeId[] = []
  private counter = 0

  private key(scope: ScopeId, id: EpisodeId): string {
    return `${scope}/${id}`
  }

  private get(scope: ScopeId, id: EpisodeId): StoredEpisode {
    const episode = this.episodes.get(this.key(scope, id))
    if (episode === undefined) throw new Error(`no episode ${scope}/${id}`)
    return episode
  }

  private hit(method: string): void {
    this.calls++
    this.methods.push(method)
    const failures = this.failNext.get(method) ?? 0
    if (failures > 0) {
      this.failNext.set(method, failures - 1)
      throw new Error(`injected ${method} failure`)
    }
  }

  list(scope?: ScopeId): StoredEpisode[] {
    return [...this.episodes.values()]
      .filter(episode => scope === undefined || episode.meta.scope === scope)
      .sort((a, b) => a.meta.seqRange.first - b.meta.seqRange.first)
  }

  async listScopes(): Promise<readonly ScopeId[]> {
    this.hit('listScopes')
    return [...new Set(this.list().map(episode => episode.meta.scope))]
  }

  async readIndex(scope: ScopeId): Promise<MemoryIndex> {
    this.hit('readIndex')
    return { version: 1, scope, episodes: this.list(scope).map(episode => episode.meta), rollups: [], updatedAt: 0 }
  }

  async openEpisode(scope: ScopeId, init: { readonly sessionId: string; readonly startedAt: number; readonly firstSeq: number }): Promise<EpisodeMeta> {
    this.hit('openEpisode')
    const id = `${init.sessionId.slice(0, 8)}_${++this.counter}` as EpisodeId
    const meta: EpisodeMeta = {
      id,
      scope,
      sessionId: init.sessionId,
      dir: `episodes/${id}`,
      seqRange: { first: init.firstSeq, last: init.firstSeq },
      startedAt: init.startedAt,
      status: 'open',
      tokens: { raw: 0 },
      importance: 5,
      strength: 1,
      pinned: false,
      hidden: false,
      keywords: [],
    }
    this.episodes.set(this.key(scope, id), { meta, raw: [] })
    return meta
  }

  async appendRaw(scope: ScopeId, id: EpisodeId, records: readonly RawEventRecord[]): Promise<void> {
    this.hit('appendRaw')
    const episode = this.get(scope, id)
    if (episode.meta.status !== 'open') throw new EpisodeNotOpenError(id, episode.meta.status)
    episode.raw.push(...JSON.parse(JSON.stringify(records)) as RawEventRecord[])
  }

  async sealEpisode(scope: ScopeId, id: EpisodeId, seal: Parameters<CaptureStore['sealEpisode']>[2]): Promise<EpisodeMeta> {
    this.hit('sealEpisode')
    const episode = this.get(scope, id)
    if (episode.meta.status !== 'open') throw new Error(`episode ${id} is ${episode.meta.status}`)
    episode.meta = {
      ...episode.meta,
      status: 'sealed',
      sealReason: seal.reason,
      endedAt: seal.endedAt,
      seqRange: { first: episode.meta.seqRange.first, last: seal.lastSeq },
      tokens: { raw: seal.rawTokens },
      ...seal.shadowedSeqs === undefined ? {} : { shadowedSeqs: seal.shadowedSeqs },
    }
    return episode.meta
  }

  async claimEpisode(scope: ScopeId, id: EpisodeId): Promise<EpisodeMeta> {
    this.hit('claimEpisode')
    const episode = this.get(scope, id)
    if (episode.meta.status === 'open') this.claimed.push(id)
    return episode.meta
  }

  async readRaw(scope: ScopeId, id: EpisodeId, page: { readonly offset: number; readonly limit: number }): Promise<RawPage> {
    this.hit('readRaw')
    const raw = this.get(scope, id).raw
    return { records: raw.slice(page.offset, page.offset + page.limit), offset: page.offset, total: raw.length }
  }

  async readState(): Promise<StoreState> {
    this.hit('readState')
    return structuredClone(this.state)
  }

  async updateState(change: (state: StoreState) => StoreState): Promise<StoreState> {
    this.hit('updateState')
    this.state = change(structuredClone(this.state))
    return this.state
  }

  /** Records of an episode that belong to it (`seq <= seqRange.last` once sealed). */
  owned(episode: StoredEpisode): RawEventRecord[] {
    return episode.meta.status === 'open' ? episode.raw : episode.raw.filter(record => record.seq <= episode.meta.seqRange.last)
  }
}

export const T0 = Date.UTC(2026, 10, 20, 13, 30)

export interface UserOptions {
  readonly kind?: string
}

/** Builds synthetic DSH session events with contiguous seqs, one second apart. */
export class EventStream {
  seq = 0
  time = T0
  turn = 0
  step = 0

  event(type: string, data: unknown, extra: Partial<RawEventRecord> = {}): RawEventRecord {
    this.time += 1000
    return { seq: this.seq++, time: this.time, type, data, ...extra }
  }

  user(text: string, options: UserOptions = {}): RawEventRecord {
    const data = { id: `u${this.seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: options.kind ?? 'user' } }
    return this.event('user/message', data, { surfaceOp: 'append' })
  }

  assistant(text: string, options: { readonly reasoning?: string; readonly toolCall?: string } = {}): RawEventRecord {
    const content: unknown[] = []
    const stream: unknown[] = []
    if (options.reasoning !== undefined) {
      content.push({ type: 'reasoning', text: options.reasoning })
      stream.push({ type: 'chunk', time: this.time, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
      stream.push({ type: 'reasoning-chunks', time0: this.time, index: 0, dt: [0], texts: [options.reasoning] })
      stream.push({ type: 'chunk', time: this.time, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: options.reasoning } } })
    }
    content.push({ type: 'text', text })
    stream.push({ type: 'text-chunks', time0: this.time, index: content.length - 1, dt: [0], texts: [text] })
    if (options.toolCall !== undefined) content.push({ type: 'tool-call', id: `c${this.seq}`, name: options.toolCall, arguments: '{}' })
    stream.push({ type: 'chunk', time: this.time, chunk: { type: 'finish', reason: 'stop' } })
    const message = { id: `a${this.seq}`, role: 'assistant', content, source: { kind: 'model', provider: 'fake', model: 'fake-1' } }
    return this.event('assistant/message', { turn: this.turn, step: this.step, message, stream })
  }

  toolResult(text: string): RawEventRecord {
    const message = { id: `t${this.seq}`, role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId: 'c' }, toolCallId: 'c' }
    return this.event('tool/result', { turn: this.turn, step: this.step, message }, { surfaceOp: 'append' })
  }

  turnStart(): RawEventRecord {
    this.turn++
    this.step = 0
    return this.event('turn/start', { turn: this.turn })
  }

  turnEnd(): RawEventRecord {
    return this.event('turn/end', { turn: this.turn, reason: { kind: 'completed' } })
  }

  stepStart(): RawEventRecord {
    this.step++
    return this.event('step/start', { turn: this.turn, step: this.step })
  }

  stepEnd(): RawEventRecord {
    return this.event('step/end', { turn: this.turn, step: this.step })
  }

  /** `turn/start, user/message, step/start, assistant/message, step/end, turn/end`. */
  fullTurn(userText: string, assistantText: string): RawEventRecord[] {
    return [this.turnStart(), this.user(userText), this.stepStart(), this.assistant(assistantText), this.stepEnd(), this.turnEnd()]
  }

  /** `compaction/start, compaction/summary, user/message (checkpoint), compaction/end`. */
  compaction(shadowedSeqs: readonly number[], turn: number | null = null): RawEventRecord[] {
    const compactionId = `k${this.seq}`
    const start = this.event('compaction/start', { compactionId, turn })
    const summary = this.event('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'host summary' }],
      shadowedRange: { start: 0, end: shadowedSeqs.length - 1 },
      shadowedSeqs,
      shadowedTokenCount: 100,
      provider: 'fake',
      model: 'fake-1',
    })
    const firstShadowed = shadowedSeqs[0] ?? 0
    const lastShadowed = shadowedSeqs.at(-1) ?? 0
    const checkpoint = this.event('user/message', {
      id: `k${this.seq}`,
      role: 'user',
      content: [{ type: 'text', text: '<compacted-summary>host summary</compacted-summary>' }],
      source: { kind: 'compact-checkpoint', compactionId },
    }, { surfaceOp: { op: 'replace', startSeq: firstShadowed, endSeq: lastShadowed }, sourceEventSeqs: [start.seq, summary.seq, ...shadowedSeqs] })
    const end = this.event('compaction/end', { compactionId, turn })
    return [start, summary, checkpoint, end]
  }
}

export function seqs(records: readonly RawEventRecord[]): number[] {
  return records.map(record => record.seq)
}

export function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}
