/**
 * Shared contracts for the memory-cloud modules. Everything here is
 * framework-agnostic: no Cordis or DSH runtime imports, so every module can be
 * unit-tested against fakes. Host adapters (engine, capture, inject, tools,
 * commands) translate DSH objects into these shapes at the edge.
 */

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** Stable episode identity, also its directory leaf name: `20261120-2130_<sid8>_<n>`. */
export type EpisodeId = Brand<string, 'EpisodeId'>
/** Memory isolation unit (`owner`, `qq-group-<id>`, ...); also the directory name under `scopes/`. */
export type ScopeId = Brand<string, 'ScopeId'>

export const OWNER_SCOPE = 'owner' as ScopeId

/** Epoch milliseconds. */
export type Millis = number

// ---------------------------------------------------------------------------
// Configuration vocabulary
// ---------------------------------------------------------------------------

export const COMPRESSION_LEVELS = [1, 2, 3, 4, 5] as const
export type CompressionLevel = (typeof COMPRESSION_LEVELS)[number]

export const COMPACTION_MODES = ['auto', 'engine', 'assist', 'off'] as const
export type CompactionMode = (typeof COMPACTION_MODES)[number]

/** The mode actually running for one agent after `auto` resolution. */
export type EffectiveMode = 'engine' | 'assist' | 'off'

// ---------------------------------------------------------------------------
// Data model (files under `<root>/scopes/<scopeId>/`)
// ---------------------------------------------------------------------------

/** Why an episode stopped accepting raw events. */
export type SealReason = 'compaction' | 'idle' | 'end' | 'size'

/** Episode lifecycle: raw capture → sealed → summarized (or failed, retried later). */
export type EpisodeStatus = 'open' | 'sealed' | 'summarized' | 'failed'

/** Estimated tokens per tier, computed with {@link TokenEstimator} when written. */
export interface TierTokens {
  readonly raw: number
  readonly summary?: number
  readonly gist?: number
}

/** Which model and prompt produced an episode's summary/gist. */
export interface SummaryProvenance {
  readonly provider: string
  readonly model: string
  readonly promptVersion: string
  readonly summarizedAt: Millis
}

/** One `index.json` entry. The index is the only mutable file; raw text is append-only. */
export interface EpisodeMeta {
  readonly id: EpisodeId
  readonly scope: ScopeId
  readonly sessionId: string
  /** Episode directory relative to the scope root, e.g. `episodes/2026/11/20261120-2130_ab12cd34_1`. */
  readonly dir: string
  /**
   * Inclusive range of captured DSH session-log seqs (numeric log order).
   * While the episode is open `last` equals `first`; it is accurate once sealed.
   */
  readonly seqRange: { readonly first: number; readonly last: number }
  /** Surface seqs replaced by the compaction that sealed this episode (`compaction/summary.shadowedSeqs`). */
  readonly shadowedSeqs?: readonly number[]
  readonly startedAt: Millis
  readonly endedAt?: Millis
  readonly sealReason?: SealReason
  readonly status: EpisodeStatus
  readonly tokens: TierTokens
  /** 1–10, assigned by the summarizer; 5 until summarized. */
  readonly importance: number
  /** Retention strength `S = 1 + recall count`. */
  readonly strength: number
  readonly lastRecalledAt?: Millis
  readonly pinned: boolean
  readonly hidden: boolean
  readonly keywords: readonly string[]
  readonly summarizer?: SummaryProvenance
  /** Last summarization failure, kept for retry/backoff and `/memory status`. */
  readonly lastError?: string
  readonly attempts?: number
}

type MutableEpisodeFields = Omit<EpisodeMeta, 'id' | 'scope' | 'sessionId' | 'dir' | 'startedAt'>

/**
 * Fields a caller may change after creation (seal, summarize, recall, pin/hide).
 * A key set to `undefined` clears that optional field (e.g. `lastError`).
 */
export type EpisodeMetaPatch = { readonly [K in keyof MutableEpisodeFields]?: MutableEpisodeFields[K] | undefined }

/**
 * One line of `raw.jsonl`: the DSH session event envelope, stored losslessly.
 * Once an episode is sealed, readers must only use records whose seq lies in
 * its `seqRange`: the append-only file may also hold copies of the retained
 * tail that a compaction split moved to the next episode.
 */
export interface RawEventRecord {
  readonly seq: number
  readonly time: Millis
  readonly type: string
  readonly data: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: readonly number[]
  readonly ignorable?: true
}

/** A dated fact pulled out of an episode, with relative dates resolved to absolute ones. */
export interface DatedFact {
  /** ISO 8601 date or date-time. */
  readonly date: string
  readonly what: string
}

/** A commitment made by either side, tracked so a later session can follow up. */
export interface Commitment {
  readonly what: string
  readonly who?: string
  /** ISO 8601 due date, when one was stated. */
  readonly due?: string
}

/** Structured output of one episode summarization. */
export interface EpisodeSummaryResult {
  /** Highly compressed "this happened" line(s) for the distant tier. */
  readonly gist: string
  /** Normally compressed "what happened" text for the recent tier. */
  readonly summary: string
  /** Unfinished threads; used only for compaction checkpoints. */
  readonly ongoing: readonly string[]
  /** 1–10. */
  readonly importance: number
  readonly keywords: readonly string[]
  readonly people: readonly string[]
  readonly dates: readonly DatedFact[]
  readonly promises: readonly Commitment[]
}

export type RollupPeriod =
  | { readonly kind: 'week'; readonly key: string }
  | { readonly kind: 'month'; readonly key: string }
  | { readonly kind: 'year'; readonly key: string }

/** One period summary under `rollups/` that replaces many gists when the distant tier overflows. */
export interface RollupEntry {
  readonly id: string
  readonly scope: ScopeId
  readonly period: RollupPeriod
  readonly episodeIds: readonly EpisodeId[]
  readonly from: Millis
  readonly to: Millis
  readonly tokens: number
  /** File relative to the scope root, e.g. `rollups/2026-W47.md`. */
  readonly file: string
  readonly createdAt: Millis
}

/** Parsed `index.json`. */
export interface MemoryIndex {
  readonly version: 1
  readonly scope: ScopeId
  readonly episodes: readonly EpisodeMeta[]
  readonly rollups: readonly RollupEntry[]
  readonly updatedAt: Millis
}

/** One page of raw records. `total` is the number of records in the episode. */
export interface RawPage {
  readonly records: readonly RawEventRecord[]
  readonly offset: number
  readonly total: number
}

/** Background jobs started on one local day (`YYYY-MM-DD`), persisted so restarts keep counting. */
export interface JobQuota {
  readonly day: string
  readonly used: number
}

/** Root `state.json`: per-session capture watermarks, the background job queue, and its daily quota. */
export interface StoreState {
  readonly version: 1
  /** Last captured seq per session id. */
  readonly lastSeq: Readonly<Record<string, number>>
  readonly queue: readonly QueuedJob[]
  readonly quota?: JobQuota
}

export type QueuedJob =
  | { readonly kind: 'summarize'; readonly scope: ScopeId; readonly episode: EpisodeId; readonly notBefore: Millis; readonly attempts: number }
  | { readonly kind: 'rollup'; readonly scope: ScopeId; readonly period: RollupPeriod; readonly notBefore: Millis; readonly attempts: number }

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Scope-aware multi-file store. Writes are temp-file + rename; `index.json`
 * mutations hold a cross-process lock (`@deepseek-ai/dsh-atomic-write`
 * `withFileLock` is available from the host); `raw.jsonl` is append-only and
 * nothing is ever deleted ("forgetting" only changes packing tiers).
 */
export interface MemoryStore {
  /** Absolute storage root (default `$DSH_HOME/memory-cloud`). */
  readonly root: string
  listScopes(): Promise<readonly ScopeId[]>
  readIndex(scope: ScopeId): Promise<MemoryIndex>
  openEpisode(scope: ScopeId, init: { readonly sessionId: string; readonly startedAt: Millis; readonly firstSeq: number }): Promise<EpisodeMeta>
  appendRaw(scope: ScopeId, episode: EpisodeId, records: readonly RawEventRecord[]): Promise<void>
  sealEpisode(scope: ScopeId, episode: EpisodeId, seal: {
    readonly reason: SealReason
    readonly endedAt: Millis
    readonly lastSeq: number
    readonly rawTokens: number
    readonly shadowedSeqs?: readonly number[]
  }): Promise<EpisodeMeta>
  /** Write `summary.md` + `gist.md` (with frontmatter) and mark the episode summarized. */
  writeSummary(scope: ScopeId, episode: EpisodeId, result: EpisodeSummaryResult, provenance: SummaryProvenance, tokens: Required<Omit<TierTokens, 'raw'>>): Promise<EpisodeMeta>
  /**
   * A function patch is computed from the current entry under the scope lock,
   * so read-modify-write updates (e.g. recall counts) cannot lose a concurrent
   * change; returning `{}` leaves the entry unwritten.
   */
  updateEpisode(scope: ScopeId, episode: EpisodeId, patch: EpisodeMetaPatch | ((meta: EpisodeMeta) => EpisodeMetaPatch)): Promise<EpisodeMeta>
  readRaw(scope: ScopeId, episode: EpisodeId, page: { readonly offset: number; readonly limit: number }): Promise<RawPage>
  readTier(scope: ScopeId, episode: EpisodeId, tier: 'summary' | 'gist'): Promise<string | undefined>
  writeRollup(scope: ScopeId, entry: RollupEntry, text: string): Promise<void>
  readRollup(scope: ScopeId, id: string): Promise<string | undefined>
  /** Persist one injected memory block or checkpoint; returns its path relative to the scope root. */
  writeSnapshot(scope: ScopeId, ref: { readonly sessionId: string; readonly n: number }, text: string): Promise<string>
  /** User-editable `profile.md`, if present. */
  readProfile(scope: ScopeId): Promise<string | undefined>
  readState(): Promise<StoreState>
  updateState(change: (state: StoreState) => StoreState): Promise<StoreState>
  /** Serialize one read-modify-write cycle on the scope's index across processes. */
  withLock<T>(scope: ScopeId, operation: () => Promise<T>): Promise<T>
}

// ---------------------------------------------------------------------------
// Token estimation, levels, and budgets
// ---------------------------------------------------------------------------

/** `(cjkWeight × CJK chars + otherWeight × other chars) × safetyMargin`, rounded up. */
export interface TokenEstimatorOptions {
  readonly cjkWeight: number
  readonly otherWeight: number
  readonly safetyMargin: number
}

export const DEFAULT_TOKEN_ESTIMATOR_OPTIONS: TokenEstimatorOptions = {
  cjkWeight: 0.6,
  otherWeight: 0.3,
  safetyMargin: 1.15,
}

export interface TokenEstimator {
  estimate(text: string): number
  /** Feed provider-reported usage for text that was estimated, to correct future estimates. */
  calibrate?(estimated: number, actual: number): void
}

/** A token budget stated either absolutely or as a fraction of a window-derived base. */
export type TokenBudget =
  | { readonly kind: 'tokens'; readonly tokens: number }
  | { readonly kind: 'ratio'; readonly ratio: number }

/** One row of the design §3.7 compression-level table. `K` = 1024 tokens. */
export interface LevelPreset {
  readonly level: CompressionLevel
  /** Working-memory ceiling that triggers compaction; ratio is of the context window W. */
  readonly workingMemory: TokenBudget
  /** Verbatim tail kept after compaction; ratio is of `W − O`. */
  readonly retain: TokenBudget
  /** Memory block budget M before window clamping. */
  readonly memoryBudgetTokens: number
  readonly recentSummaryCount: number
  readonly recentSummaryTokens: number
  /** Per-entry gist size. */
  readonly gistTokens: number
  /** Single `memory_read` ceiling. */
  readonly recallLimitTokens: number
}

const K = 1024

export const LEVEL_PRESETS: Readonly<Record<CompressionLevel, LevelPreset>> = {
  1: { level: 1, workingMemory: { kind: 'ratio', ratio: 0.8 }, retain: { kind: 'ratio', ratio: 0.16 }, memoryBudgetTokens: 48 * K, recentSummaryCount: 10, recentSummaryTokens: 1500, gistTokens: 80, recallLimitTokens: 16 * K },
  2: { level: 2, workingMemory: { kind: 'tokens', tokens: 256 * K }, retain: { kind: 'tokens', tokens: 48 * K }, memoryBudgetTokens: 32 * K, recentSummaryCount: 8, recentSummaryTokens: 1000, gistTokens: 60, recallLimitTokens: 12 * K },
  3: { level: 3, workingMemory: { kind: 'tokens', tokens: 128 * K }, retain: { kind: 'tokens', tokens: 24 * K }, memoryBudgetTokens: 24 * K, recentSummaryCount: 6, recentSummaryTokens: 800, gistTokens: 50, recallLimitTokens: 8 * K },
  4: { level: 4, workingMemory: { kind: 'tokens', tokens: 64 * K }, retain: { kind: 'tokens', tokens: 12 * K }, memoryBudgetTokens: 12 * K, recentSummaryCount: 4, recentSummaryTokens: 500, gistTokens: 35, recallLimitTokens: 4 * K },
  5: { level: 5, workingMemory: { kind: 'tokens', tokens: 32 * K }, retain: { kind: 'tokens', tokens: 6 * K }, memoryBudgetTokens: 6 * K, recentSummaryCount: 2, recentSummaryTokens: 300, gistTokens: 25, recallLimitTokens: 2 * K },
}

/** User overrides applied over the active level's preset; every field is optional and clamped. */
export interface LevelOverrides {
  readonly workingMemoryTokens?: number
  readonly retainTokens?: number
  readonly memoryBudgetTokens?: number
  readonly recentSummaryCount?: number
  readonly recentSummaryTokens?: number
  readonly gistTokens?: number
  readonly recallLimitTokens?: number
}

/** Model capacity facts from `ctx.llm.resolveModelInfo()` and the routed request header. */
export interface ModelCapacity {
  /** W: `LlmResolvedModelInfo.context.contextWindow`. */
  readonly contextWindow: number
  /** O: routed `maxTokens`, else adapter `defaultMaxTokens`, else 0. */
  readonly reservedOutputTokens: number
}

export interface BudgetInput {
  readonly level: CompressionLevel
  readonly overrides?: LevelOverrides
  readonly capacity: ModelCapacity
  /** H: extra headroom kept free beyond O (compaction-basic `headroomTokens`). */
  readonly headroomTokens: number
  /** r: share of `W − O − H` the memory block may take. */
  readonly memoryShare: number
}

/** Per-tier allocation of M: profile 10% → recent 55% → distant 35%, unused shares roll forward. */
export interface TierQuotas {
  readonly profile: number
  readonly recent: number
  readonly distant: number
  /** Separate small budget for in-progress items, checkpoint mode only. */
  readonly ongoing: number
}

export interface ResolvedBudget {
  readonly level: CompressionLevel
  /** Absolute compaction trigger in tokens. */
  readonly thresholdTokens: number
  /** `thresholdTokens / W`, ready for compaction-basic `thresholdRatio` (0, 1]. */
  readonly thresholdRatio: number
  readonly retainTokens: number
  /** M after `clamp(min(preset, r × (W − O − H)), 2K, Mmax)`. */
  readonly memoryBudgetTokens: number
  readonly quotas: TierQuotas
  readonly recentSummaryCount: number
  readonly recentSummaryTokens: number
  readonly gistTokens: number
  readonly recallLimitTokens: number
}

export interface BudgetResolver {
  resolve(input: BudgetInput): ResolvedBudget
}

// ---------------------------------------------------------------------------
// Packing (pure)
// ---------------------------------------------------------------------------

/** An index entry with whichever tier texts are available. */
export interface PackCandidate {
  readonly meta: EpisodeMeta
  readonly gist?: string
  readonly summary?: string
  /** Structured commitments from `summary.md` frontmatter; still-open ones are rendered with the profile. */
  readonly promises?: readonly Commitment[]
  /** Structured dated facts from `summary.md` frontmatter; upcoming ones are rendered with the profile. */
  readonly dates?: readonly DatedFact[]
}

export interface PackInput {
  readonly candidates: readonly PackCandidate[]
  readonly rollups: readonly { readonly entry: RollupEntry; readonly text: string }[]
  readonly profile?: string
  /** In-progress items; rendered only in checkpoint mode. */
  readonly ongoing?: readonly string[]
  readonly budget: ResolvedBudget
  /** `session-start` for the injected block, `checkpoint` for an engine-mode compaction checkpoint. */
  readonly mode: 'session-start' | 'checkpoint'
  readonly halfLifeDays: number
  readonly now: Millis
  /** Hard ceiling on `text.length` (UTF-16 units, DSH's heuristic unit), e.g. {@link CheckpointRequest.maxChars}. */
  readonly maxChars?: number
}

export type PackedTier = 'profile' | 'rollup' | 'gist' | 'summary' | 'ongoing'

export interface PackStats {
  readonly tokens: number
  readonly byTier: Readonly<Record<PackedTier, number>>
  readonly included: readonly { readonly id: EpisodeId | string; readonly tier: PackedTier }[]
  /** Entries dropped after rollups could not absorb the overflow; rendered as a one-line notice. */
  readonly omitted: number
}

export interface PackResult {
  /** Complete `<memory-cloud>` block, `<` escaped, labelled as historical data rather than instructions. */
  readonly text: string
  readonly stats: PackStats
}

export interface MemoryPacker {
  pack(input: PackInput): PackResult
}

/** Retention score `T = 0.5^(Δt/(h·S)) × (0.5 + I/20)`. */
export type RetentionScore = (meta: Pick<EpisodeMeta, 'endedAt' | 'startedAt' | 'strength' | 'importance' | 'lastRecalledAt'>, now: Millis, halfLifeDays: number) => number

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

/** Text-only model call, abstracted from `ctx.llm.stream()` + `BlockAssembler`. */
export interface LlmCompletionRequest {
  /** Empty provider/model inherits the conversation route. */
  readonly provider: string
  readonly model: string
  readonly system?: string
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[]
  /**
   * Opaque DSH `Message[]`/`ToolSchema[]` replayed verbatim before `messages`
   * so the call shares the conversation's provider prefix cache (engine mode).
   * `toolHistory` is the session's `ToolHistory` (`agent.session.toolHistory()`),
   * so developer tool-update messages survive route projection.
   */
  readonly replay?: { readonly messages: readonly unknown[]; readonly tools?: readonly unknown[]; readonly toolHistory?: unknown }
  /** Structured-output tool the model should call; parsed from `toolCalls`. */
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> }[]
  readonly maxTokens: number
  readonly reasoningEffort?: string
  /** Declared `LlmRequestPurposeMap` key; also the session-log upload exclusion key. */
  readonly purpose: string
  readonly sessionId?: string
}

export type LlmFinish = 'stop' | 'tool-calls' | 'max-tokens' | 'error' | 'aborted'

export interface LlmCompletion {
  readonly text: string
  readonly toolCalls: readonly { readonly name: string; readonly arguments: string }[]
  readonly finish: LlmFinish
  readonly error?: string
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens?: number }
  readonly provider: string
  readonly model: string
}

export interface LlmClient {
  complete(request: LlmCompletionRequest, signal?: AbortSignal): Promise<LlmCompletion>
}

export interface SummaryTargets {
  readonly gistTokens: number
  readonly summaryTokens: number
}

/** Model route for summarizer calls; empty provider/model inherit the conversation or default route. */
export interface SummaryRoute {
  readonly provider: string
  readonly model: string
  /** Empty or absent uses the adapter default. */
  readonly reasoningEffort?: string
}

export interface SummarizeRequest {
  readonly episode: Pick<EpisodeMeta, 'id' | 'startedAt' | 'endedAt' | 'sessionId'>
  /** Rendered transcript of the episode (the replay prefix carries it instead in engine mode). */
  readonly transcript: string
  readonly targets: SummaryTargets
  /** Anchor for converting relative dates to absolute ones. */
  readonly now: Millis
  readonly timeZone?: string
  readonly replay?: LlmCompletionRequest['replay']
  /** Per-call route override, e.g. the conversation route in engine mode so the replay hits its prefix cache. */
  readonly route?: SummaryRoute
}

export interface SummarizeOutcome {
  readonly result: EpisodeSummaryResult
  readonly provenance: SummaryProvenance
  readonly usage?: LlmCompletion['usage']
}

export interface Summarizer {
  summarize(request: SummarizeRequest, signal?: AbortSignal): Promise<SummarizeOutcome>
}

// ---------------------------------------------------------------------------
// Engine seam
// ---------------------------------------------------------------------------

/**
 * What the engine's `summarize()` override hands to the memory side. The
 * returned text becomes the checkpoint body that DSH wraps in its preamble and
 * `<compacted-summary>` tags; it must be smaller (DSH 4-chars/token heuristic)
 * than the shadowed span or DSH rejects it.
 */
export interface CheckpointRequest {
  readonly sessionId: string
  readonly scope: ScopeId
  /** Session-log seqs of the replayed region, in surface order (excludes the system head). */
  readonly regionSeqs?: readonly number[]
  /** Character length of the replayed region, for the shrink guard. */
  readonly regionChars: number
  /** Longest text that passes the engine's shrink guard; longer output falls back to `super.summarize()`. */
  readonly maxChars: number
  readonly replay: NonNullable<LlmCompletionRequest['replay']>
  /** The conversation's routed model, so a replayed summary call shares its prefix cache. */
  readonly route?: SummaryRoute
  readonly budget: ResolvedBudget
  readonly now: Millis
}

export interface CheckpointComposer {
  /** Resolve to checkpoint text, or reject so the engine falls back to `super.summarize()`. */
  compose(request: CheckpointRequest, signal?: AbortSignal): Promise<string>
}

// ---------------------------------------------------------------------------
// Scopes and time
// ---------------------------------------------------------------------------

/** Session facts available from `session.header` and agent metadata. */
export interface SessionDescriptor {
  readonly sessionId: string
  /** `SessionHeader.origin`; `'subagent'` sessions are never captured. */
  readonly origin?: 'subagent'
  readonly parentSession?: string
  readonly delegationDepth?: number
  readonly agentPreset?: string
  readonly cwd?: string
  /** Extra routing keys from chat bridges, e.g. `qqbot:<bot>:group:<id>`. */
  readonly tags?: readonly string[]
}

/** Glob-like rule mapping session tags to a scope. */
export interface ScopeRule {
  readonly match: string
  readonly scope: string
}

export interface ScopeDecision {
  readonly scope: ScopeId
  readonly capture: boolean
  /** Whether owner-private memory may be injected into this session. */
  readonly private: boolean
  readonly reason: string
}

export interface ScopeResolver {
  resolve(session: SessionDescriptor): ScopeDecision
}

export interface Clock {
  now(): Millis
}

// ---------------------------------------------------------------------------
// Shared identifiers
// ---------------------------------------------------------------------------

/** `UserMessage.source.kind` of injected memory blocks (declared in `MessageSourceMap`). */
export const MEMORY_SOURCE_KIND = 'memory-cloud'

/** `UserMessage.source.kind` of DSH compaction checkpoints. */
export const COMPACT_CHECKPOINT_SOURCE_KIND = 'compact-checkpoint'

/** `UserMessage.source.kind` of the agent loop's runtime-context snapshots. */
export const RUNTIME_CONTEXT_SOURCE_KIND = 'runtime-context'

/**
 * `user/message` source kinds that are never conversation:
 * our injected memory blocks, DSH compaction checkpoints, and runtime-context
 * snapshots. They never reach transcripts or summaries and never make an
 * episode non-empty.
 */
export const SYNTHETIC_SOURCE_KINDS: readonly string[] = [MEMORY_SOURCE_KIND, COMPACT_CHECKPOINT_SOURCE_KIND, RUNTIME_CONTEXT_SOURCE_KIND]

/** `LlmRequestPurposeMap` key for summarizer calls; also excluded from session-log upload. */
export const SUMMARIZE_PURPOSE = 'memory-cloud-summarize'

export const TOOL_NAMES = {
  search: 'memory_search',
  read: 'memory_read',
  timeline: 'memory_timeline',
  pin: 'memory_pin',
  unpin: 'memory_unpin',
  hide: 'memory_hide',
  unhide: 'memory_unhide',
  note: 'memory_note',
} as const

export const COMMAND_NAME = 'memory'
