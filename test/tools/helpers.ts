import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  EpisodeId, EpisodeMeta, EpisodeMetaPatch, EpisodeStatus, MemoryIndex, MemoryStore, Millis, RawEventRecord, RawPage,
  ScopeId, StoreState, TokenEstimator,
} from '../../src/contracts.ts'
import { DEFAULT_TOKEN_ESTIMATOR_OPTIONS } from '../../src/contracts.ts'

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

export const estimator: TokenEstimator = {
  estimate(text) {
    let cjk = 0
    let other = 0
    for (const char of text) {
      if (CJK.test(char)) cjk++
      else other++
    }
    const { cjkWeight, otherWeight, safetyMargin } = DEFAULT_TOKEN_ESTIMATOR_OPTIONS
    return Math.ceil((cjkWeight * cjk + otherWeight * other) * safetyMargin)
  },
}

export const at = (year: number, month: number, day: number, hour = 12, minute = 0): Millis =>
  new Date(year, month - 1, day, hour, minute).getTime()

export interface SeedEpisode {
  readonly id: string
  readonly sessionId?: string
  readonly startedAt: Millis
  readonly endedAt?: Millis
  readonly status?: EpisodeStatus
  readonly gist?: string
  readonly summary?: string
  readonly keywords?: readonly string[]
  readonly people?: readonly string[]
  readonly dates?: readonly string[]
  readonly pinned?: boolean
  readonly hidden?: boolean
  readonly strength?: number
  readonly raw?: readonly RawEventRecord[]
}

function frontmatter(episode: SeedEpisode): string {
  const lines = ['---', `episode: ${episode.id}`, `keywords: ${JSON.stringify(episode.keywords ?? [])}`]
  if (episode.people !== undefined) lines.push(`people: ${JSON.stringify(episode.people)}`)
  if (episode.dates !== undefined) {
    lines.push('dates:')
    for (const date of episode.dates) lines.push(`  - date: ${date}`, '    what: something')
  }
  lines.push(`summarizedAt: 2026-12-31T00:00:00.000Z`, '---', '')
  return lines.join('\n')
}

/** File-backed `MemoryStore` covering what the tools use; other methods are unused here. */
export class FakeStore implements MemoryStore {
  readonly root: string
  readonly calls = { readTier: 0, readRaw: 0, updateEpisode: [] as { scope: ScopeId; id: EpisodeId; patch: EpisodeMetaPatch }[] }
  private readonly indexes = new Map<ScopeId, MemoryIndex>()
  private tick = 1

  constructor(root: string) {
    this.root = root
  }

  private episodeDir(scope: ScopeId, id: EpisodeId): string {
    return join(this.root, 'scopes', scope, 'episodes', id)
  }

  async seed(scope: ScopeId, episodes: readonly SeedEpisode[]): Promise<void> {
    const metas: EpisodeMeta[] = [...(this.indexes.get(scope)?.episodes ?? [])]
    for (const episode of episodes) {
      const id = episode.id as EpisodeId
      const dir = this.episodeDir(scope, id)
      await mkdir(dir, { recursive: true })
      const summarized = episode.gist !== undefined || episode.summary !== undefined
      if (episode.gist !== undefined) await writeFile(join(dir, 'gist.md'), `${frontmatter(episode)}${episode.gist}\n`)
      if (episode.summary !== undefined) await writeFile(join(dir, 'summary.md'), `${frontmatter(episode)}${episode.summary}\n`)
      const raw = episode.raw ?? []
      await writeFile(join(dir, 'raw.jsonl'), raw.map(record => `${JSON.stringify(record)}\n`).join(''))
      metas.push({
        id,
        scope,
        sessionId: episode.sessionId ?? 'session-1',
        dir: `episodes/${id}`,
        seqRange: { first: raw[0]?.seq ?? 1, last: raw.at(-1)?.seq ?? 1 },
        startedAt: episode.startedAt,
        ...episode.endedAt === undefined ? {} : { endedAt: episode.endedAt },
        status: episode.status ?? (summarized ? 'summarized' : 'sealed'),
        tokens: {
          raw: 100,
          ...episode.gist === undefined ? {} : { gist: estimator.estimate(episode.gist) },
          ...episode.summary === undefined ? {} : { summary: estimator.estimate(episode.summary) },
        },
        importance: 5,
        strength: episode.strength ?? 1,
        pinned: episode.pinned ?? false,
        hidden: episode.hidden ?? false,
        keywords: [...episode.keywords ?? []],
      })
    }
    this.indexes.set(scope, { version: 1, scope, episodes: metas, rollups: [], updatedAt: this.tick++ })
  }

  /** Rewrite one episode's gist as a re-summarization would, bumping the index. */
  async resummarize(scope: ScopeId, id: string, gist: string): Promise<void> {
    await writeFile(join(this.episodeDir(scope, id as EpisodeId), 'gist.md'), `${gist}\n`)
    await this.updateEpisode(scope, id as EpisodeId, { tokens: { raw: 100, gist: estimator.estimate(gist), summary: 1 } })
    this.calls.updateEpisode.pop()
  }

  meta(scope: ScopeId, id: string): EpisodeMeta | undefined {
    return this.indexes.get(scope)?.episodes.find(episode => episode.id === id)
  }

  async listScopes(): Promise<readonly ScopeId[]> {
    return [...this.indexes.keys()]
  }

  async readIndex(scope: ScopeId): Promise<MemoryIndex> {
    return this.indexes.get(scope) ?? { version: 1, scope, episodes: [], rollups: [], updatedAt: 0 }
  }

  async updateEpisode(scope: ScopeId, id: EpisodeId, update: EpisodeMetaPatch | ((meta: EpisodeMeta) => EpisodeMetaPatch)): Promise<EpisodeMeta> {
    const index = await this.readIndex(scope)
    const current = index.episodes.find(episode => episode.id === id)
    if (current === undefined) throw new Error(`unknown episode ${id}`)
    const patch = typeof update === 'function' ? update(current) : update
    const next = { ...current, ...patch } as EpisodeMeta
    this.indexes.set(scope, { ...index, episodes: index.episodes.map(episode => episode.id === id ? next : episode), updatedAt: this.tick++ })
    this.calls.updateEpisode.push({ scope, id, patch })
    return next
  }

  async readTier(scope: ScopeId, id: EpisodeId, tier: 'summary' | 'gist'): Promise<string | undefined> {
    this.calls.readTier++
    try {
      return await readFile(join(this.episodeDir(scope, id), `${tier}.md`), 'utf8')
    } catch {
      return undefined
    }
  }

  async readRaw(scope: ScopeId, id: EpisodeId, page: { readonly offset: number; readonly limit: number }): Promise<RawPage> {
    this.calls.readRaw++
    const text = await readFile(join(this.episodeDir(scope, id), 'raw.jsonl'), 'utf8')
    const records = text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as RawEventRecord)
    return { records: records.slice(page.offset, page.offset + page.limit), offset: page.offset, total: records.length }
  }

  openEpisode(): Promise<EpisodeMeta> { return unused() }
  appendRaw(): Promise<void> { return unused() }
  sealEpisode(): Promise<EpisodeMeta> { return unused() }
  writeSummary(): Promise<EpisodeMeta> { return unused() }
  writeRollup(): Promise<void> { return unused() }
  readRollup(): Promise<string | undefined> { return unused() }
  writeSnapshot(): Promise<string> { return unused() }
  readProfile(): Promise<string | undefined> { return unused() }
  readState(): Promise<StoreState> { return unused() }
  updateState(): Promise<StoreState> { return unused() }
  withLock<T>(_scope: ScopeId, operation: () => Promise<T>): Promise<T> { return operation() }
}

function unused(): never {
  throw new Error('not used by the tools module')
}

export async function withTempStore<T>(run: (store: FakeStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'memory-cloud-tools-'))
  try {
    return await run(new FakeStore(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

let nextSeq = 1

/** A `user/message`; `source: null` omits the source, as older user messages do. */
export function userRecord(text: string, time: Millis, seq = nextSeq++, source: { readonly kind: string } | null = { kind: 'user' }): RawEventRecord {
  const content = [{ type: 'text', text }]
  return { seq, time, type: 'user/message', data: { id: `m${seq}`, role: 'user', content, ...source === null ? {} : { source } } }
}

export function assistantRecord(text: string, time: Millis, seq = nextSeq++, toolCall?: { readonly id: string; readonly name: string; readonly arguments: string }): RawEventRecord {
  const content: unknown[] = [{ type: 'text', text }]
  if (toolCall !== undefined) content.push({ type: 'tool-call', ...toolCall })
  return {
    seq,
    time,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { id: `m${seq}`, role: 'assistant', content, source: { kind: 'model' } }, stream: [] },
  }
}

export function toolResultRecord(callId: string, text: string, time: Millis, seq = nextSeq++): RawEventRecord {
  return {
    seq,
    time,
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { id: `m${seq}`, role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError: false } },
  }
}

export function eventRecord(type: string, data: unknown, time: Millis, seq = nextSeq++): RawEventRecord {
  return { seq, time, type, data }
}

export function stepRecord(time: Millis, seq = nextSeq++): RawEventRecord {
  return eventRecord('step/start', { turn: 1, step: 1 }, time, seq)
}
