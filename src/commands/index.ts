/** `/memory status | level | mode | compact-now | summarize-now | rebuild | takeover | restore | backfill` (design §3.6). */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { COMMAND_NAME, COMPACTION_MODES, COMPRESSION_LEVELS } from '../contracts.ts'
import type { MemoryCloudStatus, TakeoverActionResult } from '../runtime/status.ts'
import type { SettingWriteResult } from '../runtime/settings.ts'
import { renderStatus, renderTakeoverResult } from './render.ts'

export type { CompactionMode, CompressionLevel, EffectiveMode, MemoryStore, StoreState } from '../contracts.ts'
export { COMMAND_NAME, COMPACTION_MODES, COMPRESSION_LEVELS } from '../contracts.ts'
export { formatTokens, renderStatus, renderTakeoverResult } from './render.ts'

export interface CommandOutcome {
  readonly ok: boolean
  readonly text: string
}

/** What the runtime provides to the command; every method may reject, the handler reports it. */
export interface MemoryCommandDeps {
  status(agent: Agent): Promise<MemoryCloudStatus>
  setLevel(level: number): Promise<SettingWriteResult>
  setMode(mode: string): Promise<SettingWriteResult>
  compactNow(agent: Agent, signal: AbortSignal): Promise<CommandOutcome>
  summarizeNow(agent: Agent): Promise<CommandOutcome>
  rebuild(agent: Agent): Promise<CommandOutcome>
  takeover(presetId?: string): Promise<TakeoverActionResult>
  restore(presetId?: string): Promise<TakeoverActionResult>
  backfill(agent: Agent): Promise<CommandOutcome>
}

export const SUBCOMMANDS = ['status', 'level', 'mode', 'compact-now', 'summarize-now', 'rebuild', 'takeover', 'restore', 'backfill'] as const

export const USAGE = [
  '/memory status — 模式、档位与预算、片段统计、后台任务、接管与共存情况',
  '/memory level <1-5> — 压缩档位：1 保留最多上下文，5 最少',
  '/memory mode <auto|engine|assist|off> — 运行模式',
  '/memory compact-now — 立即整理（压缩）当前会话',
  '/memory summarize-now — 封存当前尾部并立即处理后台总结队列',
  '/memory rebuild — 按当前档位的长度重新生成本作用域的总结/摘要',
  '/memory takeover [preset] — 让本插件接管压缩（默认 standard 预设）',
  '/memory restore [preset] — 还原宿主默认压缩',
  '/memory backfill — 导入安装前的旧会话',
].join('\n')

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function settingResult(result: SettingWriteResult, success: string): CommandResult {
  return result.ok ? { kind: 'success', text: success } : { kind: 'error', text: `保存失败：${result.message}` }
}

function outcome(result: CommandOutcome): CommandResult {
  return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text }
}

/** Parse and run one `/memory` invocation; never rejects. */
export async function runMemoryCommand(
  deps: MemoryCommandDeps,
  invocation: { readonly agent: Agent; readonly rawInput: string; readonly signal: AbortSignal },
): Promise<CommandResult> {
  const [verb = 'status', ...args] = invocation.rawInput.trim().split(/\s+/).filter(part => part.length > 0)
  const sub = verb.toLowerCase()
  try {
    switch (sub) {
      case 'status':
        return { kind: 'success', text: renderStatus(await deps.status(invocation.agent)) }
      case 'level': {
        const level = Number(args[0])
        if (!(COMPRESSION_LEVELS as readonly number[]).includes(level)) return { kind: 'error', text: `用法：/memory level <1-5>（当前输入 ${JSON.stringify(args[0] ?? '')}）` }
        return settingResult(await deps.setLevel(level), `压缩档位已设为 ${level}，立即生效`)
      }
      case 'mode': {
        const mode = (args[0] ?? '').toLowerCase()
        if (!(COMPACTION_MODES as readonly string[]).includes(mode)) return { kind: 'error', text: `用法：/memory mode <${COMPACTION_MODES.join('|')}>` }
        return settingResult(await deps.setMode(mode), `运行模式已设为 ${mode}，对新的判断立即生效（/memory status 查看实际模式）`)
      }
      case 'compact-now':
        return outcome(await deps.compactNow(invocation.agent, invocation.signal))
      case 'summarize-now':
        return outcome(await deps.summarizeNow(invocation.agent))
      case 'rebuild':
        return outcome(await deps.rebuild(invocation.agent))
      case 'takeover':
      case 'restore': {
        const restoring = sub === 'restore'
        const result = restoring ? await deps.restore(args[0]) : await deps.takeover(args[0])
        const text = renderTakeoverResult(result, restoring)
        return result.ok ? { kind: 'success', text } : { kind: 'error', text }
      }
      case 'backfill':
        return outcome(await deps.backfill(invocation.agent))
      case 'help':
        return { kind: 'success', text: USAGE }
      default:
        return { kind: 'error', text: `未知子命令 ${JSON.stringify(verb)}\n${USAGE}` }
    }
  } catch (error) {
    return { kind: 'error', text: `/memory ${sub} 失败：${errorText(error)}` }
  }
}

/**
 * Register `/memory` on `ctx.commands`. The returned disposer (also run when
 * `ctx` unloads) unregisters it and waits for in-flight handlers.
 */
export function registerMemoryCommand(ctx: Context, deps: MemoryCommandDeps): () => Promise<void> {
  return ctx.effect(() => {
    const running = new Set<Promise<CommandResult>>()
    const unregister = ctx.commands.register({
      name: COMMAND_NAME,
      description: '记忆云：状态、档位、模式、整理与接管（/memory help）',
      input: { hint: SUBCOMMANDS.join(' | ') },
      handler: (invocation) => {
        const task = runMemoryCommand(deps, invocation)
        running.add(task)
        void task.finally(() => running.delete(task))
        return task
      },
    })
    return async () => {
      unregister()
      await Promise.allSettled([...running])
    }
  }, 'memory-cloud command')
}
