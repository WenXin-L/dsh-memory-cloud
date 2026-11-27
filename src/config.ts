import z from '@deepseek-ai/schemastery'
import { COMPACTION_MODES, COMPRESSION_LEVELS } from './contracts.ts'
import { UNMATCHED_SESSIONS } from './scope/guard.ts'

const tokens = () => z.natural()
const description = (en: string, zh: string) => ({ '': en, en, zh })

const overrides = z.object({
  workingMemoryTokens: tokens().extra('description', description('Token threshold for context compaction.', '上下文达到此 token 数时触发压缩。')),
  retainTokens: tokens().extra('description', description('Recent tokens kept verbatim after compaction.', '压缩后保留多少 token 的近期原文。')),
  memoryBudgetTokens: tokens().extra('description', description('How many tokens fit in the memory block.', '记忆块可以容纳多少 token。')),
  recentSummaryCount: z.natural().extra('description', description('How many recent episodes return as summaries.', '多少条近期记忆片段以摘要的身份回来。')),
  recentSummaryTokens: tokens().extra('description', description('Token budget for each recent summary.', '每条近期摘要的 token 预算。')),
  gistTokens: tokens().extra('description', description('Token budget for each distant gist.', '每条远期总结的 token 预算。')),
  recallLimitTokens: tokens().extra('description', description('Maximum tokens returned by one memory_read call.', '一次 memory_read 调用最多返回多少 token。')),
})

const summarizer = z.object({
  provider: z.string().default('').volatile().extra('description', description(
    'Provider for background summaries. Leave empty to use the provider of the DSH default model.',
    '后台摘要使用的模型提供方。留空时使用 DSH 默认模型的提供方。',
  )),
  model: z.string().default('deepseek-flash').volatile().extra('description', description(
    'Model for episode summaries and period rollups. Leave empty to use the DSH default model.',
    '它负责给记忆片段写摘要，也负责按时期汇总。留空使用 DSH 默认模型。',
  )),
  reasoningEffort: z.string().default('off').volatile().extra('description', description(
    'Use off to turn off reasoning for summaries. Leave empty to let the adapter choose.',
    '填 off 会关闭生成摘要时的推理。留空时由适配器选择推理强度。',
  )),
})

const scopeRule = z.object({
  match: z.string().required().extra('description', description(
    'Match a session tag with a glob such as qqbot:*:group:*. The first matching rule wins.',
    '用 qqbot:*:group:* 这样的通配式匹配会话标签。第一条匹配的规则生效。',
  )),
  scope: z.string().required().extra('description', description(
    'Scope ID for matching sessions. $1–$9 insert wildcard captures and $& inserts the whole tag. For example, qqbot:*:group:* → qq-group-$2. A $n beyond the number of * and ? in match skips the rule. An empty capture uses a hash of the tag. IDs use lowercase [a-z0-9_-]. Only a rule set literally to owner grants access to owner memory.',
    '匹配后使用的作用域 ID。$1–$9 代入通配符捕获的内容，$& 代入整个标签，例如 qqbot:*:group:* → qq-group-$2。$n 超出 match 中 * 和 ? 的总数时跳过此规则。捕获内容为空时使用标签的哈希值。ID 使用小写的 [a-z0-9_-]。只有把规则的作用域明确写成 owner，才会授予读取主人记忆的权限。',
  )),
})

/** Plugin configuration (design §3). Volatile fields apply live; the rest restart the plugin. */
export const Config = z.object({
  level: z.union(COMPRESSION_LEVELS).default(3).volatile().extra('description', description(
    'Choose a compression level from 1 to 5. Level 1 keeps the most context and level 5 the least. A saved level goes straight to work.',
    '压缩档位从 1 到 5。1 保留最多上下文，5 保留最少。保存的档位即刻上岗。',
  )),
  compactionMode: z.union(COMPACTION_MODES).default('auto').volatile().extra('description', description(
    'In auto, Memory Cloud uses engine mode when it owns compaction and detects no other known compaction plugin. Otherwise it uses assist mode. Each session checks the saved mode on its next use.',
    'auto 在记忆云已接管压缩、也未检测到其他已知压缩插件时选择引擎模式，其余情况选择辅助模式。保存后从下一次模式判断起生效。',
  )),
  storageRoot: z.string().extra('description', description(
    'Local directory for memory files. Leave empty for $DSH_HOME/memory-cloud. Changing this path requires a restart.',
    '存放记忆文件的本地目录。留空使用 $DSH_HOME/memory-cloud。修改路径后需重启。',
  )),
  idleMinutes: z.number().min(1).default(30).volatile().extra('description', description(
    'Idle minutes before the open conversation tail is sealed as a memory episode. Enter at least 1.',
    '会话空闲满这些分钟，尚未封存的对话尾部就封成记忆片段。至少填 1。',
  )),
  idleCompactRatio: z.number().min(0).max(1).default(0.5).volatile().extra('description', description(
    'Try compactNow() when an idle session’s context pressure exceeds this ratio (0–1).',
    '空闲会话的上下文压力超过此比例时，尝试调用 compactNow() 压缩。可填 0–1。',
  )),
  halfLifeDays: z.number().min(0.1).default(14).volatile().extra('description', description(
    'Base half-life of a retention score in days. An episode’s strength multiplies this interval. The minimum is 0.1 days.',
    '记忆片段保留分的基础半衰期，以天为单位。实际半衰期等于此数值乘以片段强度。至少填 0.1 天。',
  )),
  maxEpisodeTokens: tokens().default(32768).volatile().extra('description', description(
    'Seal an episode when its raw text exceeds this token count. Enter 0 to turn off size-based sealing.',
    '记忆片段原文超过此 token 数时封存。填 0 则不按大小封存。',
  )),
  captureReasoning: z.boolean().default(true).volatile().extra('description', description(
    'Write model reasoning blocks to the raw archive when enabled.',
    '启用后，会把模型推理内容写入原文存档。',
  )),
  summarizer,
  overrides: overrides.default({}).volatile().extra('description', description(
    'Set individual budgets for the active compression level. Entered values skip the lower-level cap. The model window still sets the limit.',
    '逐项覆盖当前压缩档位的预算。手动填写的值跳过更低档位的限制，模型窗口仍是上限。',
  )),
  scopeRules: z.array(scopeRule).default([]).volatile().extra('description', description(
    'Route sessions to memory scopes in rule order. Sessions that match none follow unmatchedSessions.',
    '按规则顺序把会话分到记忆作用域。一条也未匹配的会话按 unmatchedSessions 设置分配。',
  )),
  unmatchedSessions: z.union(UNMATCHED_SESSIONS).default('auto').volatile().extra('description', description(
    'For unmatched sessions, owner grants access to owner memory and isolated gives each session a separate scope with no owner access. Auto isolates them when it detects a known chat bridge and uses owner otherwise. With an unlisted bridge, choose isolated. Grant owner only through a tag exclusive to your own sessions, such as cwd:/home/me/*.',
    '对未匹配的会话，owner 授予读取主人记忆的权限，isolated 为每个会话单设作用域。auto 检测到已知聊天桥接时隔离，否则使用 owner。接入名单外的桥接时请选择 isolated，再用仅自己的会话拥有的标签授予 owner 权限，例如 cwd:/home/me/*。',
  )),
})

export type Config = ReturnType<typeof Config>
