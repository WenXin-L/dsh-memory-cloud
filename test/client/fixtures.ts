import type { ConfigView, VolatileConfig } from '../../src/client/contract.ts'
import type { MemoryCloudKey } from '../../src/client/locales.ts'
import type { Translate } from '../../src/client/view-model.ts'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import type { AgentStatusReport, MemoryCloudStatus } from '../../src/runtime/status.ts'
import { decideUnmatched, detectCoexistence } from '../../src/scope/index.ts'

export function translator(dictionary: Readonly<Record<MemoryCloudKey, string>>): Translate {
  return (key, params = {}) => dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(params, name) ? String(params[name]) : match)
}

export function agentReport(overrides: Partial<AgentStatusReport> = {}): AgentStatusReport {
  return {
    sessionId: 'sess-1234567890',
    subagent: false,
    scope: { scope: OWNER_SCOPE, capture: true, private: true, reason: 'no scope rule matched' },
    mode: { mode: 'assist', configured: 'auto', engineActive: false, reason: 'auto：此 agent 的压缩由宿主引擎负责' },
    capacity: { route: { provider: 'deepseek', model: 'deepseek-chat' }, capacity: { contextWindow: 131072, reservedOutputTokens: 8192 }, known: true },
    budget: {
      level: 3, thresholdTokens: 114688, thresholdRatio: 0.875, retainTokens: 24576, memoryBudgetTokens: 24576,
      quotas: { profile: 2304, recent: 12672, distant: 8064, ongoing: 1536 },
      recentSummaryCount: 6, recentSummaryTokens: 800, gistTokens: 50, recallLimitTokens: 8192,
    },
    pressure: 0.42,
    ...overrides,
  }
}

/** A status as the browser receives it (no live session unless `agent` is given). */
export function wireStatus(overrides: Partial<MemoryCloudStatus> = {}): MemoryCloudStatus {
  return {
    storageRoot: '/home/u/.dsh/memory-cloud',
    profile: 'web',
    configured: { level: 3, compactionMode: 'auto', unmatchedSessions: 'auto' },
    firewall: decideUnmatched('auto'),
    scopes: [{ scope: 'owner', episodes: { open: 1, sealed: 0, summarized: 12, failed: 1 }, pinned: 1, hidden: 0, rollups: 2 }],
    jobs: {
      started: true, stopped: false, queue: [], quota: { day: '2026-11-23', used: 3, limit: 200 },
      breaker: { open: false, consecutiveFailures: 0 }, totals: { succeeded: 3, failed: 0, timedOut: 0, cancelled: 0, deferred: 0 },
    },
    takeover: { kind: 'preset', editable: true, presets: [{ entryId: 'preset-standard', presetId: 'standard', state: 'available', recorded: false }] },
    coexistence: detectCoexistence([]),
    registrations: { tools: true, command: true, problems: [] },
    fallbacks: [],
    ...overrides,
  }
}

/** The Config schema defaults as plain live values. */
export function volatileConfig(overrides: Partial<VolatileConfig> = {}): VolatileConfig {
  return {
    level: 3,
    compactionMode: 'auto',
    timeAwareness: false,
    idleMinutes: 30,
    idleCompactRatio: 0.5,
    halfLifeDays: 14,
    maxEpisodeTokens: 32768,
    captureReasoning: true,
    summarizer: { provider: '', model: 'deepseek-flash', reasoningEffort: 'off' },
    overrides: {},
    scopeRules: [],
    unmatchedSessions: 'auto',
    ...overrides,
  }
}

export function configView(config: Partial<VolatileConfig> = {}): ConfigView {
  return { config: volatileConfig(config), defaults: volatileConfig() }
}
