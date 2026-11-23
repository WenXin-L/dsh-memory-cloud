import type {
  EpisodeMeta,
  QueuedJob,
  RawEventRecord,
  RollupEntry,
  RollupPeriod,
  ScopeId,
  StoreState,
} from '../contracts.ts'
import { episodeRelativeDir, isRollupFile, isValidScopeId, parseEpisodeId } from './layout.ts'

type Fields = Readonly<Record<string, unknown>>

const STATUSES: ReadonlySet<unknown> = new Set(['open', 'sealed', 'summarized', 'failed'])
const SEAL_REASONS: ReadonlySet<unknown> = new Set(['compaction', 'idle', 'end', 'size'])
const PERIOD_KINDS: ReadonlySet<unknown> = new Set(['week', 'month', 'year'])

export function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString)
}

export function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(isFiniteNumber)
}

function optional(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === undefined || guard(value)
}

function isSeqRange(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.first) && isFiniteNumber(value.last)
}

function isTierTokens(value: unknown): boolean {
  return isRecord(value)
    && isFiniteNumber(value.raw)
    && optional(value.summary, isFiniteNumber)
    && optional(value.gist, isFiniteNumber)
}

function isProvenance(value: unknown): boolean {
  return isRecord(value)
    && isString(value.provider)
    && isString(value.model)
    && isString(value.promptVersion)
    && isFiniteNumber(value.summarizedAt)
}

export function isEpisodeMeta(value: unknown, scope: ScopeId): value is EpisodeMeta {
  if (!isRecord(value) || !isString(value.id) || parseEpisodeId(value.id) === undefined) return false
  return value.scope === scope
    && isString(value.sessionId)
    && value.dir === episodeRelativeDir(value.id)
    && isSeqRange(value.seqRange)
    && optional(value.shadowedSeqs, isNumberArray)
    && isFiniteNumber(value.startedAt)
    && optional(value.endedAt, isFiniteNumber)
    && optional(value.sealReason, reason => SEAL_REASONS.has(reason))
    && STATUSES.has(value.status)
    && isTierTokens(value.tokens)
    && isFiniteNumber(value.importance)
    && isFiniteNumber(value.strength)
    && optional(value.lastRecalledAt, isFiniteNumber)
    && typeof value.pinned === 'boolean'
    && typeof value.hidden === 'boolean'
    && isStringArray(value.keywords)
    && optional(value.summarizer, isProvenance)
    && optional(value.lastError, isString)
    && optional(value.attempts, isFiniteNumber)
}

export function isRollupPeriod(value: unknown): value is RollupPeriod {
  return isRecord(value) && PERIOD_KINDS.has(value.kind) && isString(value.key)
}

export function isRollupEntry(value: unknown, scope: ScopeId): value is RollupEntry {
  return isRecord(value)
    && isString(value.id)
    && value.id !== ''
    && value.scope === scope
    && isRollupPeriod(value.period)
    && isStringArray(value.episodeIds)
    && isFiniteNumber(value.from)
    && isFiniteNumber(value.to)
    && isFiniteNumber(value.tokens)
    && isString(value.file)
    && isRollupFile(value.file)
    && isFiniteNumber(value.createdAt)
}

/** Why a parsed `index.json` cannot be used as-is, or undefined when it is valid. */
export function describeIndexProblem(value: unknown, scope: ScopeId): string | undefined {
  if (!isRecord(value)) return 'not a JSON object'
  if (value.version !== 1) return `unsupported version ${JSON.stringify(value.version)}`
  if (value.scope !== scope) return `scope ${JSON.stringify(value.scope)} does not match its directory`
  if (!Array.isArray(value.episodes)) return 'episodes is not an array'
  const episodes = new Set<string>()
  for (const [position, entry] of value.episodes.entries()) {
    if (!isEpisodeMeta(entry, scope)) return `episodes[${position}] is not a valid episode entry`
    if (episodes.has(entry.id)) return `episode ${entry.id} is listed twice`
    episodes.add(entry.id)
  }
  if (!Array.isArray(value.rollups)) return 'rollups is not an array'
  const rollups = new Set<string>()
  for (const [position, entry] of value.rollups.entries()) {
    if (!isRollupEntry(entry, scope)) return `rollups[${position}] is not a valid rollup entry`
    if (rollups.has(entry.id)) return `rollup ${entry.id} is listed twice`
    rollups.add(entry.id)
  }
  if (!isFiniteNumber(value.updatedAt)) return 'updatedAt is not a number'
  return undefined
}

export function isQueuedJob(value: unknown): value is QueuedJob {
  if (!isRecord(value) || !isString(value.scope) || !isValidScopeId(value.scope)) return false
  if (!isFiniteNumber(value.notBefore) || !isFiniteNumber(value.attempts)) return false
  if (value.kind === 'summarize') return isString(value.episode)
  if (value.kind === 'rollup') return isRollupPeriod(value.period)
  return false
}

export function isStoreState(value: unknown): value is StoreState {
  return isRecord(value)
    && value.version === 1
    && isRecord(value.lastSeq)
    && Object.values(value.lastSeq).every(isFiniteNumber)
    && Array.isArray(value.queue)
    && value.queue.every(isQueuedJob)
}

export function isRawEventRecord(value: unknown): value is RawEventRecord {
  return isRecord(value)
    && isFiniteNumber(value.seq)
    && isFiniteNumber(value.time)
    && isString(value.type)
    && optional(value.sourceEventSeqs, isNumberArray)
}
