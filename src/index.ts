import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { Config } from './config.ts'
import { PLUGIN_NAME, startMemoryCloud } from './runtime/runtime.ts'

export { Config }
export { MEMORY_CLOUD_SERVICE } from './engine/index.ts'
export type {
  AgentStatusReport,
  FallbackRecord,
  MemoryCloudApi,
  MemoryCloudService,
  MemoryCloudStatus,
  ScopeEpisodeCounts,
  TakeoverActionResult,
  TakeoverReport,
} from './runtime/status.ts'
export type { SettingWriteResult } from './runtime/settings.ts'

export const name = PLUGIN_NAME

export const inject = ['sessions', 'llm', 'tokenMeter', 'systemPrompt', 'tools', 'commands']

export function apply(ctx: Context, config: Config): void {
  startMemoryCloud(ctx, config)
  ctx.logger.info('记忆云已就位 / Memory Cloud is ready. 压缩档位 / level %d · 压缩模式 / mode %s', config.level.get(), config.compactionMode.get())
}
