import z from '@deepseek-ai/schemastery'
import { COMPACTION_MODES, COMPRESSION_LEVELS } from './contracts.ts'
import { UNMATCHED_SESSIONS } from './scope/guard.ts'

const tokens = () => z.natural()

const overrides = z.object({
  workingMemoryTokens: tokens().description('Working-memory ceiling that triggers compaction.'),
  retainTokens: tokens().description('Verbatim recent tail kept after compaction.'),
  memoryBudgetTokens: tokens().description('Memory block budget.'),
  recentSummaryCount: z.natural().description('Number of recent episodes shown as summaries.'),
  recentSummaryTokens: tokens().description('Size of each recent summary.'),
  gistTokens: tokens().description('Size of each distant gist.'),
  recallLimitTokens: tokens().description('Upper bound for one memory_read call.'),
})

const summarizer = z.object({
  provider: z.string().default('').volatile().description('Provider route for background summaries; empty uses the conversation provider.'),
  model: z.string().default('deepseek-flash').volatile().description('Model for background summaries.'),
  reasoningEffort: z.string().default('off').volatile().description('Reasoning effort for background summaries; empty uses the adapter default.'),
})

const scopeRule = z.object({
  match: z.string().required().description('Glob matched against session tags, e.g. qqbot:*:group:*.'),
  scope: z.string().required().description('Scope id used by matching sessions; $1–$9 insert the wildcard captures and $& the whole tag, e.g. qq-group-$2 for qqbot:*:group:*. $n must not exceed the number of * and ? in match, otherwise the rule is skipped; an empty capture is replaced by a hash of the tag. Only the literal scope owner sees owner memory. Ids are sanitized to lowercase [a-z0-9_-].'),
})

/** Plugin configuration (design §3). Volatile fields apply live; the rest restart the plugin. */
export const Config = z.object({
  level: z.union(COMPRESSION_LEVELS).default(3).volatile().description('Compression level: 1 keeps the most context, 5 the least.'),
  compactionMode: z.union(COMPACTION_MODES).default('auto').volatile().description('auto picks engine mode when this plugin owns compaction, otherwise assist mode.'),
  storageRoot: z.string().description('Storage root; empty uses $DSH_HOME/memory-cloud.'),
  idleMinutes: z.number().min(1).default(30).volatile().description('Idle time before the open tail is sealed as an episode.'),
  idleCompactRatio: z.number().min(0).max(1).default(0.5).volatile().description('Context pressure above which an idle agent is compacted with compactNow().'),
  halfLifeDays: z.number().min(0.1).default(14).volatile().description('Forgetting half-life used by the retention score.'),
  maxEpisodeTokens: tokens().default(32768).volatile().description('Seal an episode once its raw text exceeds this many tokens; 0 disables size-based sealing.'),
  captureReasoning: z.boolean().default(true).volatile().description('Keep model reasoning blocks in the raw archive.'),
  summarizer,
  overrides: overrides.default({}).volatile().description('Per-field overrides applied over the active level, clamped to the model window.'),
  scopeRules: z.array(scopeRule).default([]).volatile().description('Map sessions to isolated memory scopes; sessions no rule matches follow unmatchedSessions.'),
  unmatchedSessions: z.union(UNMATCHED_SESSIONS).default('auto').volatile().description('Sessions no scope rule matches: owner uses the private owner scope, isolated gives each session its own scope without owner memory, auto isolates them while a chat-bridge plugin is loaded and uses owner otherwise. Map your own sessions to owner with a rule such as cwd:/home/me/* or preset:standard.'),
})

export type Config = ReturnType<typeof Config>
