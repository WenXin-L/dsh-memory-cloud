import type { CompactionMode, CompressionLevel, EpisodeStatus, ResolvedBudget, ScopeDecision } from '../contracts.ts'
import type {
  EngineFallbackKind,
  EngineHost,
  HostEngineOutcome,
  HostEngineState,
  PresetTakeoverStatus,
  TakeoverErrorCode,
} from '../engine/index.ts'
import type { CoexistenceReport, UnmatchedDecision, UnmatchedSessions } from '../scope/index.ts'
import type { JobRunnerStats } from '../summarize/jobs/index.ts'
import type { CapacityReport } from './budget.ts'
import type { ModeDecision } from './mode.ts'
import type { SettingWriteResult } from './settings.ts'

export interface AgentStatusReport {
  readonly sessionId: string
  readonly subagent: boolean
  readonly scope: ScopeDecision
  readonly mode: ModeDecision
  readonly capacity: CapacityReport
  readonly budget: ResolvedBudget
  /** Context pressure 0..1. */
  readonly pressure: number
}

export interface ScopeEpisodeCounts {
  readonly scope: string
  readonly episodes: Readonly<Record<EpisodeStatus, number>>
  readonly pinned: number
  readonly hidden: number
  readonly rollups: number
  readonly error?: string
}

export interface TakeoverReport {
  /** `preset`: configEditor takeover of agent presets (web/desktop); `host`: plugin-manager row toggle (headless/sdk). */
  readonly kind: 'preset' | 'host'
  readonly editable: boolean
  readonly presets: readonly PresetTakeoverStatus[]
  readonly host?: HostEngineState
  readonly error?: string
}

export interface FallbackRecord {
  readonly kind: EngineFallbackKind
  readonly stage: 'threshold' | 'summarize'
  readonly sessionId: string
  readonly detail?: string
  readonly at: number
}

/** JSON-serializable snapshot behind `/memory status` and the settings page. */
export interface MemoryCloudStatus {
  readonly storageRoot: string
  readonly profile?: string
  readonly configured: { readonly level: CompressionLevel; readonly compactionMode: CompactionMode; readonly unmatchedSessions: UnmatchedSessions }
  /** How sessions no scope rule matches are scoped right now (`unmatchedSessions` resolved against the loaded chat bridges). */
  readonly firewall?: UnmatchedDecision
  /** Present when a live agent (the command's caller, or the requested session) is known. */
  readonly agent?: AgentStatusReport
  readonly scopes: readonly ScopeEpisodeCounts[]
  readonly jobs: JobRunnerStats
  readonly takeover: TakeoverReport
  readonly coexistence: CoexistenceReport
  /** Whether the recall tools and `/memory` registered; problems explain failures such as name clashes. */
  readonly registrations: { readonly tools: boolean; readonly command: boolean; readonly problems: readonly string[] }
  /** Recent non-routine engine hand-backs to compaction-basic, newest last (at most 20). */
  readonly fallbacks: readonly FallbackRecord[]
  /** Counts of routine hand-backs (`subagent`, `no-capture`, `region-too-small`), which are not listed in `fallbacks`. */
  readonly routineFallbacks?: Readonly<Partial<Record<EngineFallbackKind, number>>>
}

export type TakeoverActionResult =
  | { readonly kind: 'preset'; readonly ok: true; readonly action: 'applied' | 'unchanged' | 'restored'; readonly preset?: PresetTakeoverStatus; readonly warning?: string }
  | { readonly kind: 'preset'; readonly ok: false; readonly code: TakeoverErrorCode; readonly message: string }
  | { readonly kind: 'host'; readonly ok: boolean; readonly outcome: HostEngineOutcome }

/**
 * Host-side API for the settings page (and other plugins), exposed as
 * `ctx.memoryCloud.api`. Every method resolves (never rejects) with plain
 * JSON data, so a Remote can forward it to the browser unchanged.
 */
export interface MemoryCloudApi {
  /** Status; pass a live session id to include that agent's mode, scope, and budget. */
  status(sessionId?: string): Promise<MemoryCloudStatus>
  /** Persist `level` (1–5) through the settings service or config editor; applies live. */
  setLevel(level: number): Promise<SettingWriteResult>
  /** Persist `compactionMode` (`auto` | `engine` | `assist` | `off`); applies live to new decisions. */
  setMode(mode: string): Promise<SettingWriteResult>
  /** Take over a preset's compaction (`standard` by default); headless profiles toggle the host engine row instead. */
  takeover(presetId?: string): Promise<TakeoverActionResult>
  /** Undo {@link takeover}. */
  restore(presetId?: string): Promise<TakeoverActionResult>
}

/** The `memoryCloud` Cordis service: the engine seam plus the settings API. */
export interface MemoryCloudService extends EngineHost {
  readonly api: MemoryCloudApi
  /** Chat-bridge routing tags for one session (e.g. `qqbot:<bot>:group:<id>`), matched by `scopeRules`. */
  setSessionTags(sessionId: string, tags: Iterable<string>): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryCloud: MemoryCloudService
  }
}
