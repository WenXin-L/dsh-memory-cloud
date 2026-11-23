import type { HostEngineOutcome, PresetTakeoverStatus } from '../engine/index.ts'
import type { MemoryCloudStatus, TakeoverActionResult } from '../runtime/status.ts'
import type { UnmatchedDecision } from '../scope/index.ts'

const PRESET_STATES: Readonly<Record<PresetTakeoverStatus['state'], string>> = {
  available: '未接管，可接管',
  active: '已接管',
  outdated: '已接管（DSH 预设已更新，将自动重新应用）',
  customized: '已接管但被手动修改，不再跟随 DSH 升级',
  unsupported: '无压缩组，无法接管',
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
  const lines: string[] = ['记忆云 Memory Cloud 状态']
  const { agent } = status
  if (agent !== undefined) {
    lines.push(`- 模式：${agent.mode.mode}（配置 compactionMode=${status.configured.compactionMode}）— ${agent.mode.reason}`)
    const { capacity, budget } = agent
    const route = capacity.route === undefined ? '未知模型' : `${capacity.route.provider}/${capacity.route.model}`
    const window = `${formatTokens(capacity.capacity.contextWindow)}${capacity.known ? '' : '（未知，按默认估计）'}`
    lines.push(`- 档位：${budget.level}（配置 level=${status.configured.level}）· 模型 ${route} 窗口 ${window}，输出预留 ${formatTokens(capacity.capacity.reservedOutputTokens)}`)
    lines.push(`  压缩阈值 ${formatTokens(budget.thresholdTokens)}（${budget.thresholdRatio.toFixed(3)}W）· 保留原文 ${formatTokens(budget.retainTokens)} · 记忆块 ${formatTokens(budget.memoryBudgetTokens)}（档案 ${formatTokens(budget.quotas.profile)} / 近期 ${formatTokens(budget.quotas.recent)} / 远期 ${formatTokens(budget.quotas.distant)} / 进行中 ${formatTokens(budget.quotas.ongoing)}）`)
    lines.push(`  近期摘要 ${budget.recentSummaryCount}×${formatTokens(budget.recentSummaryTokens)} · 每条总结 ${formatTokens(budget.gistTokens)} · 单次回忆 ${formatTokens(budget.recallLimitTokens)} · 上下文压力 ${percent(agent.pressure)}`)
    lines.push(`- 作用域：${agent.scope.scope}（${agent.scope.private ? '私有' : '非私有'}${agent.scope.capture ? '' : '，不捕获'}）— ${agent.scope.reason}`)
    if (agent.subagent) lines.push('- 当前会话是子 agent：不捕获、不注入，压缩使用宿主默认摘要')
  } else {
    lines.push(`- 配置：level=${status.configured.level} · compactionMode=${status.configured.compactionMode}`)
  }
  if (status.firewall !== undefined) lines.push(renderFirewall(status.firewall))

  if (status.scopes.length === 0) lines.push('- 片段：尚无记忆')
  for (const scope of status.scopes) {
    if (scope.error !== undefined) {
      lines.push(`- 片段 ${scope.scope}：读取失败（${scope.error}）`)
      continue
    }
    const { open, sealed, summarized, failed } = scope.episodes
    lines.push(`- 片段 ${scope.scope}：open ${open} · sealed ${sealed} · summarized ${summarized} · failed ${failed}（置顶 ${scope.pinned}，隐藏 ${scope.hidden}，时期总结 ${scope.rollups}）`)
  }

  const { jobs } = status
  const running = jobs.running === undefined ? '' : ` · 运行中 ${jobs.running.job.kind === 'summarize' ? jobs.running.job.episode : jobs.running.job.period.key}`
  const quota = Number.isFinite(jobs.quota.limit) ? `${jobs.quota.used}/${jobs.quota.limit}` : `${jobs.quota.used}`
  const breaker = jobs.breaker.open ? `打开（连续失败 ${jobs.breaker.consecutiveFailures} 次）` : '关闭'
  lines.push(`- 后台任务：队列 ${jobs.queue.length}${running} · 今日 ${quota} · 断路器 ${breaker} · 成功 ${jobs.totals.succeeded} 失败 ${jobs.totals.failed}${jobs.started ? '' : ' · 未启动'}`)
  if (jobs.lastError !== undefined) lines.push(`  最近错误：${jobs.lastError.job}: ${jobs.lastError.message}`)

  lines.push(...renderTakeoverStatus(status.takeover))

  for (const warning of status.coexistence.warnings.zh) lines.push(`- 共存提示：${warning}`)
  lines.push(`- 回忆工具：${status.registrations.tools ? '已注册' : '未注册'} · /memory 命令：${status.registrations.command ? '已注册' : '未注册'}`)
  for (const problem of status.registrations.problems) lines.push(`  ${problem}`)
  const fallback = status.fallbacks.at(-1)
  if (fallback !== undefined) {
    lines.push(`- 最近一次回退到宿主摘要：${fallback.kind}（${fallback.stage}，会话 ${fallback.sessionId}${fallback.detail === undefined ? '' : `，${fallback.detail}`}），共 ${status.fallbacks.length} 次`)
  }
  lines.push(`- 存储：${status.storageRoot}${status.profile === undefined ? '' : ` · profile ${status.profile}`}`)
  return lines.join('\n')
}

function renderFirewall(firewall: UnmatchedDecision): string {
  const setting = `unmatchedSessions=${firewall.setting}`
  if (firewall.mode === 'owner') {
    return `- 未匹配规则的会话：使用私有 owner 作用域（${setting}${firewall.setting === 'auto' ? '，未检测到聊天桥接插件' : ''}）`
  }
  const bridges = firewall.bridges.length === 0 ? '' : `，检测到聊天桥接插件 ${firewall.bridges.join('、')}`
  return `- 未匹配规则的会话：各自隔离，看不到主人的记忆（${setting}${bridges}）；用作用域规则把自己的会话映射到 owner`
}

function renderTakeoverStatus(takeover: MemoryCloudStatus['takeover']): string[] {
  if (takeover.kind === 'host') {
    const host = takeover.host
    if (host === undefined) return [`- 接管：宿主级引擎行不可用${takeover.error === undefined ? '' : `（${takeover.error}）`}`]
    const state = host.active ? '本插件引擎已接管宿主压缩' : host.engine === undefined ? '引擎行未安装' : '宿主压缩仍为 compaction-basic，可用 /memory takeover 接管（需重启）'
    return [`- 接管（宿主级）：${state}`]
  }
  if (!takeover.editable) return ['- 接管：当前进程没有 config editor（非 dsh --profile 启动），无法接管预设']
  if (takeover.presets.length === 0) return [`- 接管：未发现 agent 预设${takeover.error === undefined ? '' : `（${takeover.error}）`}`]
  return takeover.presets.map(preset => `- 接管 ${preset.presetId}：${PRESET_STATES[preset.state]}${preset.detail === undefined ? '' : `（${preset.detail}）`}`)
}

export function renderTakeoverResult(result: TakeoverActionResult, restoring: boolean): string {
  if (result.kind === 'host') return renderHostOutcome(result.outcome)
  if (!result.ok) return `${restoring ? '还原' : '接管'}失败（${result.code}）：${result.message}`
  const action = { applied: '已接管，新会话生效', unchanged: '无需改动', restored: '已还原为宿主默认压缩，新会话生效' }[result.action]
  const preset = result.preset === undefined ? '' : `（${result.preset.presetId}：${PRESET_STATES[result.preset.state]}）`
  return `${action}${preset}${result.warning === undefined ? '' : `\n注意：${result.warning}`}`
}

function renderHostOutcome(outcome: HostEngineOutcome): string {
  const restart = outcome.restartReasons.length > 0 ? `\n需要重启：${outcome.restartReasons.join('；')}` : ''
  return `${outcome.ok ? '' : '失败：'}${outcome.message}${restart}`
}
