import { hostSuccessKey, zh } from '../client/locales.ts'
import type { HostEngineOutcome, PresetTakeoverStatus } from '../engine/index.ts'
import type { MemoryCloudStatus, TakeoverActionResult } from '../runtime/status.ts'
import type { UnmatchedDecision } from '../scope/index.ts'

const PRESET_STATES: Readonly<Record<PresetTakeoverStatus['state'], string>> = {
  available: '可接管压缩',
  active: zh.takeoverState_active,
  outdated: zh.takeoverState_outdated,
  customized: zh.takeoverState_customized,
  unsupported: zh.takeoverState_unsupported,
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return String(tokens)
  if (Math.abs(tokens) < 1024) return String(Math.round(tokens))
  const k = tokens / 1024
  return `${Number.isInteger(k) ? k : k.toFixed(1)}K`
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** `/memory status` text (Chinese, with English identifiers). */
export function renderStatus(status: MemoryCloudStatus): string {
  const lines: string[] = ['记忆云 · 状态报告']
  const { agent } = status
  if (agent !== undefined) {
    lines.push(`- 模式：${agent.mode.mode}（配置 compactionMode=${status.configured.compactionMode}）— ${agent.mode.reason}`)
    const { capacity, budget } = agent
    const route = capacity.route === undefined ? '未知模型' : `${capacity.route.provider}/${capacity.route.model}`
    const window = `${formatTokens(capacity.capacity.contextWindow)}${capacity.known ? '' : '（未知，按默认估计）'}`
    lines.push(`- 压缩档位：${budget.level}（配置 level=${status.configured.level}）· 模型 ${route} 窗口 ${window}，输出预留 ${formatTokens(capacity.capacity.reservedOutputTokens)}`)
    lines.push(`  压缩阈值 ${formatTokens(budget.thresholdTokens)}（${budget.thresholdRatio.toFixed(3)}W）· 保留原文 ${formatTokens(budget.retainTokens)} · 记忆块 ${formatTokens(budget.memoryBudgetTokens)}（档案 ${formatTokens(budget.quotas.profile)} / 近期 ${formatTokens(budget.quotas.recent)} / 远期 ${formatTokens(budget.quotas.distant)} / 进行中 ${formatTokens(budget.quotas.ongoing)}）`)
    lines.push(`  近期摘要 ${budget.recentSummaryCount}×${formatTokens(budget.recentSummaryTokens)} · 每条总结 ${formatTokens(budget.gistTokens)} · 单次回忆 ${formatTokens(budget.recallLimitTokens)} · 上下文压力 ${percent(agent.pressure)}`)
    lines.push(`- 作用域：${agent.scope.scope}（${agent.scope.private ? '私有' : '非私有'}${agent.scope.capture ? '' : '，不捕获'}）— ${agent.scope.reason}`)
    if (agent.subagent) lines.push(`- ${zh.budgetSubagent}`)
  } else {
    lines.push(`- 配置：level=${status.configured.level} · compactionMode=${status.configured.compactionMode}`)
    lines.push('  预算给活跃会话留了一个座位。打开或继续对话，再运行 /memory status 查看数值。')
  }
  if (status.firewall !== undefined) lines.push(renderFirewall(status.firewall))

  if (status.scopes.length === 0) lines.push(`- 记忆片段：${zh.episodesNone}`)
  for (const scope of status.scopes) {
    if (scope.error !== undefined) {
      lines.push(`- 读取作用域 ${scope.scope} 的记忆片段失败 — ${scope.error}`)
      continue
    }
    const { open, sealed, summarized, failed } = scope.episodes
    lines.push(`- 记忆片段（作用域 ${scope.scope}）：open ${open} · sealed ${sealed} · summarized ${summarized} · failed ${failed}（置顶 ${scope.pinned}，隐藏 ${scope.hidden}，时期总结 ${scope.rollups}）`)
  }

  const { jobs } = status
  const running = jobs.running === undefined ? '' : ` · 运行中 ${jobs.running.job.kind === 'summarize' ? jobs.running.job.episode : jobs.running.job.period.key}`
  const quota = Number.isFinite(jobs.quota.limit) ? `${jobs.quota.used}/${jobs.quota.limit}` : `${jobs.quota.used}`
  const breaker = jobs.breaker.open ? `打开（连续失败 ${jobs.breaker.consecutiveFailures} 次）` : '关闭'
  lines.push(`- 后台任务：队列 ${jobs.queue.length}${running} · 今日 ${quota} · 断路器 ${breaker} · 成功 ${jobs.totals.succeeded} 失败 ${jobs.totals.failed}${jobs.started ? '' : ' · 未启动'}`)
  if (jobs.lastError !== undefined) lines.push(`  上次后台任务失败（${jobs.lastError.job}）— ${jobs.lastError.message}`)

  lines.push(...renderTakeoverStatus(status.takeover))

  for (const warning of status.coexistence.warnings.zh) lines.push(`- 共存提示：${warning}`)
  lines.push(`- 回忆工具：${status.registrations.tools ? '已注册' : '未注册'} · /memory 命令：${status.registrations.command ? '已注册' : '未注册'}`)
  for (const problem of status.registrations.problems) lines.push(`  ${problem}`)
  const fallback = status.fallbacks.at(-1)
  if (fallback !== undefined) {
    const stage = fallback.stage === 'threshold' ? '宿主压缩阈值' : '宿主摘要'
    lines.push(`- 最近一次回退到${stage}：${fallback.kind}（${fallback.stage}，会话 ${fallback.sessionId}${fallback.detail === undefined ? '' : `，${fallback.detail}`}），最近记录 ${status.fallbacks.length} 次回退`)
  }
  lines.push(`- 存储：${status.storageRoot}${status.profile === undefined ? '' : ` · profile ${status.profile}`}`)
  return lines.join('\n')
}

function renderFirewall(firewall: UnmatchedDecision): string {
  const setting = `unmatchedSessions=${firewall.setting}`
  if (firewall.mode === 'owner') {
    return `- 未匹配规则的会话：使用私有 owner 作用域，可以读取主人记忆（${setting}${firewall.setting === 'auto' ? '，未检测到已知聊天桥接插件' : ''}）`
  }
  const bridges = firewall.bridges.length === 0 ? '' : `，检测到聊天桥接插件 ${firewall.bridges.join('、')}`
  return `- 未匹配规则的会话：各自隔离，无权读取主人记忆（${setting}${bridges}）。只把你独用的会话标签映射到 owner。`
}

function renderTakeoverStatus(takeover: MemoryCloudStatus['takeover']): string[] {
  if (takeover.error !== undefined) return [`- 读取压缩接管状态失败 — ${takeover.error}`]
  if (takeover.kind === 'host') {
    const host = takeover.host
    if (host === undefined) return [`- 接管压缩：${zh.takeoverHostMissing}`]
    const state = host.active ? zh.takeoverHostActive : host.engine === undefined ? zh.takeoverHostMissing : `${zh.takeoverHostInactive} 可用 /memory takeover 接管，可能需要重启。`
    return [`- 接管压缩（宿主级）：${state}`]
  }
  if (!takeover.editable) return [`- 接管压缩：${zh.takeoverNoEditor}`]
  if (takeover.presets.length === 0) return [`- 接管压缩：${zh.takeoverNoPresets}`]
  return takeover.presets.map(preset => `- 接管压缩（预设 ${preset.presetId}）：${PRESET_STATES[preset.state]}${preset.detail === undefined ? '' : `（${preset.detail}）`}`)
}

export function renderTakeoverResult(result: TakeoverActionResult, restoring: boolean): string {
  if (result.kind === 'host') return renderHostOutcome(result.outcome, restoring)
  if (!result.ok) return `${restoring ? '还原压缩' : '接管压缩'}失败（${result.code}）— ${result.message}`
  const action = {
    applied: zh.noticeTakeoverApplied,
    unchanged: restoring ? zh.noticeRestoreUnchanged : zh.noticeTakeoverUnchanged,
    restored: zh.noticeRestored,
  }[result.action]
  const preset = result.preset === undefined ? '' : `\n预设 ${result.preset.presetId} · ${PRESET_STATES[result.preset.state]}`
  return `${action}${preset}${result.warning === undefined ? '' : `\n接管记录或预设详情 — ${result.warning}`}`
}

function renderHostOutcome(outcome: HostEngineOutcome, restoring: boolean): string {
  const key = hostSuccessKey(outcome.application, restoring)
  const done = key === undefined ? outcome.message : zh[key]
  const result = outcome.ok ? done : `${restoring ? '还原' : '接管'}宿主级压缩失败（${outcome.application}）— ${outcome.message}`
  const restart = outcome.restartReasons.length > 0 ? `\nDSH 重启原因：${outcome.restartReasons.join('、')}` : ''
  return `${result}${restart}`
}
