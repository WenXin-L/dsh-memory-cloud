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
  '/memory status — 让记忆云报个数。查看实际模式、压缩档位、预算、作用域、记忆片段、后台队列、接管和共存情况。',
  '/memory level <1-5> — 保存压缩档位，立即生效。1 保留最多上下文，5 保留最少。',
  '/memory mode <auto|engine|assist|off> — 保存压缩模式。会话下次使用时重新选择实际模式。',
  '/memory compact-now — 立即尝试压缩当前会话的上下文。',
  '/memory summarize-now — 封存当前会话尚未封存的尾部，唤起后台总结队列。用 /memory status 查看进度。',
  '/memory rebuild — 把本作用域已总结的记忆片段重新排队，按当前压缩档位生成摘要和总结。新文本写好前继续使用旧文本。',
  '/memory takeover [preset] — 写入预设压缩组，让记忆云接管压缩。默认预设为 standard，对新会话生效。无预设时改动宿主插件配置，可能需要重启。',
  '/memory restore [preset] — 撤销指定预设的压缩接管，默认预设为 standard。对使用该预设的新会话生效。无预设时还原宿主插件配置，可能需要重启。',
  '/memory backfill — 导入安装前旧会话的功能尚未实现。此命令会说明原因。',
].join('\n')

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function settingResult(result: SettingWriteResult, setting: string, success: string): CommandResult {
  return result.ok ? { kind: 'success', text: success } : { kind: 'error', text: `保存${setting}失败 — ${result.message}` }
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
        if (!(COMPRESSION_LEVELS as readonly number[]).includes(level)) {
          return { kind: 'error', text: `压缩档位需要 1 到 5 的整数。当前输入为 ${JSON.stringify(args[0] ?? '')}。用法：/memory level <1-5>` }
        }
        return settingResult(await deps.setLevel(level), '压缩档位', `压缩档位 ${level} 已保存，即刻上岗。`)
      }
      case 'mode': {
        const mode = (args[0] ?? '').toLowerCase()
        if (!(COMPACTION_MODES as readonly string[]).includes(mode)) {
          return { kind: 'error', text: `压缩模式不识别输入 ${JSON.stringify(args[0] ?? '')}。用法：/memory mode <${COMPACTION_MODES.join('|')}>` }
        }
        return settingResult(await deps.setMode(mode), '压缩模式', `压缩模式 ${mode} 已保存。会话下次使用时重新选择实际模式，用 /memory status 查看结果。`)
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
      description: '让记忆云报个数，或调整压缩档位与模式。运行 /memory help 查看整理、总结和接管压缩命令。',
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
