/**
 * Pure presentation of `MemoryCloudStatus` and action results for the
 * settings page: everything the component shows, localized through `t`.
 */
import type { CompactionMode, CompressionLevel, EffectiveMode, LevelPreset, TokenBudget } from '../contracts.ts'
import { COMPACTION_MODES, COMPRESSION_LEVELS, LEVEL_PRESETS } from '../contracts.ts'
import type { MemoryCloudStatus, TakeoverReport } from '../runtime/status.ts'
import type { UnmatchedDecision } from '../scope/guard.ts'
import { hostSuccessKey, type MemoryCloudKey } from './locales.ts'
import type { ActionNotice } from './store.ts'

export type Translate = (key: MemoryCloudKey, params?: Readonly<Record<string, string | number>>) => string
export type Language = 'zh' | 'en'
export type Tone = 'success' | 'info' | 'warn' | 'error' | 'neutral'

const STANDARD_PRESET = 'standard'
const TAKEN_OVER: ReadonlySet<string> = new Set(['active', 'outdated', 'customized'])

export function languageOf(active: string | undefined): Language {
  return active?.toLowerCase().startsWith('zh') === true ? 'zh' : 'en'
}

/** Tokens as `512`, `24K`, or `1.5K` (`K` = 1024). */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return String(tokens)
  if (Math.abs(tokens) < 1024) return String(Math.round(tokens))
  const k = tokens / 1024
  return `${Number.isInteger(k) ? k : k.toFixed(1).replace(/\.0$/, '')}K`
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/** The first 8 characters of a session id, without DSH's `session-` prefix. */
export function shortId(id: string): string {
  const bare = id.replace(/^session-/, '')
  return bare.length > 8 ? bare.slice(0, 8) : bare
}

function budgetText(budget: TokenBudget, ratioKey: MemoryCloudKey, tokensKey: MemoryCloudKey, t: Translate): string {
  return budget.kind === 'ratio'
    ? t(ratioKey, { percent: formatPercent(budget.ratio) })
    : t(tokensKey, { tokens: formatTokens(budget.tokens) })
}

/** One level-table row as text: threshold, retained tail, memory block, summaries, gists, recall limit. */
export function levelDetail(preset: LevelPreset, t: Translate): string {
  return [
    budgetText(preset.workingMemory, 'levelThresholdRatio', 'levelThresholdTokens', t),
    budgetText(preset.retain, 'levelRetainRatio', 'levelRetainTokens', t),
    t('levelMemory', { tokens: formatTokens(preset.memoryBudgetTokens) }),
    t('levelRecent', { count: preset.recentSummaryCount, tokens: formatTokens(preset.recentSummaryTokens) }),
    t('levelGist', { tokens: formatTokens(preset.gistTokens) }),
    t('levelRecall', { tokens: formatTokens(preset.recallLimitTokens) }),
  ].join(' · ')
}

export function levelTitle(level: CompressionLevel, t: Translate): string {
  return t(`level_${level}`)
}

export interface LevelRow {
  readonly level: CompressionLevel
  readonly title: string
  readonly detail: string
}

export function levelTable(t: Translate): readonly LevelRow[] {
  return COMPRESSION_LEVELS.map(level => ({ level, title: levelTitle(level, t), detail: levelDetail(LEVEL_PRESETS[level], t) }))
}

export function modeLabel(mode: CompactionMode, t: Translate): string {
  return t(`mode_${mode}`)
}

export interface ModeOption {
  readonly mode: CompactionMode
  readonly label: string
  readonly hint: string
}

export function modeOptions(t: Translate): readonly ModeOption[] {
  return COMPACTION_MODES.map(mode => ({ mode, label: modeLabel(mode, t), hint: t(`modeHint_${mode}`) }))
}

/** The effective mode rule of `decideMode` (`src/runtime/mode.ts`), for sessions not created yet. */
export function effectiveMode(configured: CompactionMode, engineActive: boolean, otherCompaction: readonly string[]): EffectiveMode {
  switch (configured) {
    case 'off':
    case 'assist':
      return configured
    case 'engine':
      return engineActive ? 'engine' : 'assist'
    case 'auto':
      return engineActive && otherCompaction.length === 0 ? 'engine' : 'assist'
  }
}

export function modeReason(configured: CompactionMode, engineActive: boolean, mode: EffectiveMode, otherCompaction: readonly string[], t: Translate): string {
  switch (configured) {
    case 'off':
      return t('reasonOff')
    case 'assist':
      return t('reasonAssist')
    case 'engine':
      return t(engineActive ? 'reasonEngine' : 'reasonEngineFallback')
    case 'auto':
      if (!engineActive) return t('reasonAutoHost')
      return mode === 'engine' ? t('reasonAutoEngine') : t('reasonAutoOthers', { plugins: otherCompaction.join(', ') })
  }
}

/** Whether new sessions will be compacted by this plugin's engine. */
export function engineTakenOver(takeover: TakeoverReport): boolean {
  if (takeover.kind === 'host') return takeover.host?.active === true
  return takeover.presets.some(preset => preset.presetId === STANDARD_PRESET && TAKEN_OVER.has(preset.state))
}

export interface ModeView {
  readonly mode: EffectiveMode
  readonly configured: CompactionMode
  readonly reason: string
  readonly context: string
}

/** The live session's mode decision when the status carries one, else the mode new sessions will get. */
export function modeView(status: MemoryCloudStatus, t: Translate): ModeView {
  const others = status.coexistence.compactionPlugins.map(plugin => plugin.id)
  const agent = status.agent
  if (agent !== undefined) {
    const { mode, configured, engineActive } = agent.mode
    return {
      mode,
      configured,
      reason: modeReason(configured, engineActive, mode, others, t),
      context: t('modeOfSession', { session: shortId(agent.sessionId), configured: modeLabel(configured, t) }),
    }
  }
  const configured = status.configured.compactionMode
  const engineActive = engineTakenOver(status.takeover)
  const mode = effectiveMode(configured, engineActive, others)
  return {
    mode,
    configured,
    reason: modeReason(configured, engineActive, mode, others, t),
    context: t('modeExpected', { configured: modeLabel(configured, t) }),
  }
}

export const MODE_TONES: Readonly<Record<EffectiveMode, Tone>> = { engine: 'success', assist: 'info', off: 'neutral' }

export interface FactLine {
  readonly text: string
  readonly tone?: Tone
  readonly muted?: true
}

export interface Fact {
  readonly key: string
  readonly label: string
  readonly tag?: { readonly text: string; readonly tone: Tone }
  readonly lines: readonly FactLine[]
}

function budgetLines(status: MemoryCloudStatus, t: Translate): FactLine[] {
  const agent = status.agent
  if (agent === undefined) return [{ text: t('budgetNone'), muted: true }]
  const { capacity, budget } = agent
  const window = formatTokens(capacity.capacity.contextWindow)
  const lines: FactLine[] = [
    {
      text: t('budgetModel', {
        route: capacity.route === undefined ? t('budgetUnknownRoute') : `${capacity.route.provider}/${capacity.route.model}`,
        window: capacity.known ? window : t('budgetUnknownWindow', { window }),
        reserved: formatTokens(capacity.capacity.reservedOutputTokens),
      }),
    },
    {
      text: t('budgetThreshold', {
        threshold: formatTokens(budget.thresholdTokens),
        ratio: formatPercent(budget.thresholdRatio),
        retain: formatTokens(budget.retainTokens),
        memory: formatTokens(budget.memoryBudgetTokens),
      }),
    },
    {
      text: t('budgetQuotas', {
        profile: formatTokens(budget.quotas.profile),
        recent: formatTokens(budget.quotas.recent),
        distant: formatTokens(budget.quotas.distant),
        ongoing: formatTokens(budget.quotas.ongoing),
      }),
      muted: true,
    },
    {
      text: t('budgetDetail', {
        count: budget.recentSummaryCount,
        size: formatTokens(budget.recentSummaryTokens),
        gist: formatTokens(budget.gistTokens),
        recall: formatTokens(budget.recallLimitTokens),
        pressure: formatPercent(agent.pressure),
      }),
      muted: true,
    },
  ]
  if (agent.subagent) lines.push({ text: t('budgetSubagent'), tone: 'warn' })
  return lines
}

function episodeLines(status: MemoryCloudStatus, t: Translate): FactLine[] {
  if (status.scopes.length === 0) return [{ text: t('episodesNone'), muted: true }]
  return status.scopes.flatMap((scope): FactLine[] => {
    if (scope.error !== undefined) return [{ text: t('episodesError', { scope: scope.scope, message: scope.error }), tone: 'error' }]
    return [
      { text: t('episodesLine', { scope: scope.scope, ...scope.episodes }) },
      { text: t('episodesExtra', { pinned: scope.pinned, hidden: scope.hidden, rollups: scope.rollups }), muted: true },
    ]
  })
}

function jobLines(status: MemoryCloudStatus, t: Translate): FactLine[] {
  const { jobs } = status
  const limit: unknown = jobs.quota.limit
  const quota = typeof limit === 'number' && Number.isFinite(limit) ? `${jobs.quota.used}/${limit}` : String(jobs.quota.used)
  const summary = [t('jobsLine', { queue: jobs.queue.length, quota, succeeded: jobs.totals.succeeded, failed: jobs.totals.failed })]
  if (jobs.running !== undefined) {
    const job = jobs.running.job
    summary.push(t('jobsRunning', { job: job.kind === 'summarize' ? job.episode : job.period.key }))
  }
  if (!jobs.started) summary.push(t('jobsNotStarted'))
  const lines: FactLine[] = [
    { text: summary.join(' · ') },
    jobs.breaker.open
      ? { text: t('jobsBreakerOpen', { count: jobs.breaker.consecutiveFailures }), tone: 'warn' }
      : { text: t('jobsBreakerClosed'), muted: true },
  ]
  if (jobs.lastError !== undefined) lines.push({ text: t('jobsLastError', { job: jobs.lastError.job, message: jobs.lastError.message }), tone: 'error' })
  return lines
}

function takeoverLines(takeover: TakeoverReport, t: Translate): FactLine[] {
  if (takeover.error !== undefined) return [{ text: t('takeoverError', { message: takeover.error }), tone: 'warn' }]
  if (takeover.kind === 'host') {
    const host = takeover.host
    if (host === undefined) return [{ text: t('takeoverHostMissing'), tone: 'warn' }]
    if (host.active) return [{ text: t('takeoverHostActive'), tone: 'success' }]
    return [{ text: host.engine === undefined ? t('takeoverHostMissing') : t('takeoverHostInactive') }]
  }
  if (!takeover.editable) return [{ text: t('takeoverNoEditor'), muted: true }]
  if (takeover.presets.length === 0) return [{ text: t('takeoverNoPresets'), muted: true }]
  return takeover.presets.map(preset => ({
    text: `${t('takeoverPreset', { preset: preset.presetId, state: t(`takeoverState_${preset.state}`) })}${preset.detail === undefined ? '' : ` — ${preset.detail}`}`,
    ...TAKEN_OVER.has(preset.state) ? { tone: 'success' as const } : {},
  }))
}

function firewallFact(firewall: UnmatchedDecision, t: Translate): Fact {
  const lines: FactLine[] = firewall.mode === 'owner'
    ? [{ text: firewall.setting === 'auto' ? t('firewallOwnerAuto') : t('firewallOwner', { setting: firewall.setting }) }]
    : [
        { text: t('firewallIsolated', { setting: firewall.setting }) },
        ...firewall.bridges.length === 0 ? [] : [{ text: t('firewallBridges', { bridges: firewall.bridges.join(', ') }) }],
        { text: t('firewallRuleHint'), muted: true as const },
      ]
  return {
    key: 'firewall',
    label: t('rowFirewall'),
    tag: { text: t(`firewall_${firewall.mode}`), tone: firewall.mode === 'owner' ? 'neutral' : 'info' },
    lines,
  }
}

/** The status table, row by row; `language` selects the host's bilingual coexistence warnings. */
export function statusFacts(status: MemoryCloudStatus, t: Translate, language: Language): readonly Fact[] {
  const mode = modeView(status, t)
  const level = status.agent?.budget.level ?? status.configured.level
  const facts: Fact[] = [
    {
      key: 'mode',
      label: t('rowMode'),
      tag: { text: `${modeLabel(mode.mode, t)} · ${mode.mode}`, tone: MODE_TONES[mode.mode] },
      lines: [{ text: mode.reason }, { text: mode.context, muted: true }],
    },
    {
      key: 'level',
      label: t('rowLevel'),
      lines: [
        { text: t('levelValue', { level, title: levelTitle(level, t) }) },
        { text: levelDetail(LEVEL_PRESETS[level], t), muted: true },
      ],
    },
    { key: 'budget', label: t('rowBudget'), lines: budgetLines(status, t) },
    { key: 'episodes', label: t('rowEpisodes'), lines: episodeLines(status, t) },
    { key: 'jobs', label: t('rowJobs'), lines: jobLines(status, t) },
    { key: 'takeover', label: t('rowTakeover'), lines: takeoverLines(status.takeover, t) },
  ]
  if (status.firewall !== undefined) facts.push(firewallFact(status.firewall, t))
  const warnings = status.coexistence.warnings[language]
  facts.push({
    key: 'coexistence',
    label: t('rowCoexistence'),
    lines: warnings.length === 0 ? [{ text: t('coexistenceNone'), muted: true }] : warnings.map(text => ({ text, tone: 'warn' as const })),
  })
  const { registrations } = status
  facts.push({
    key: 'registrations',
    label: t('rowRegistrations'),
    lines: [
      {
        text: t('registrationsLine', {
          tools: t(registrations.tools ? 'registered' : 'notRegistered'),
          command: t(registrations.command ? 'registered' : 'notRegistered'),
        }),
        ...registrations.tools && registrations.command ? {} : { tone: 'error' as const },
      },
      ...registrations.problems.map(text => ({ text, tone: 'error' as const })),
    ],
  })
  const fallback = status.fallbacks.at(-1)
  if (fallback !== undefined) {
    facts.push({
      key: 'fallback',
      label: t('rowFallback'),
      lines: [
        { text: t('fallbackLine', { kind: fallback.kind, stage: fallback.stage, session: shortId(fallback.sessionId), count: status.fallbacks.length }) },
        ...fallback.detail === undefined ? [] : [{ text: fallback.detail, muted: true as const }],
      ],
    })
  }
  facts.push({
    key: 'storage',
    label: t('rowStorage'),
    lines: [{ text: status.profile === undefined ? t('storageLine', { root: status.storageRoot }) : t('storageProfile', { root: status.storageRoot, profile: status.profile }) }],
  })
  return facts
}

export interface TakeoverControls {
  readonly kind: 'preset' | 'host'
  readonly canTakeOver: boolean
  readonly canRestore: boolean
}

/** Which takeover buttons apply to the standard preset (or the host engine rows). */
export function takeoverControls(takeover: TakeoverReport): TakeoverControls {
  if (takeover.kind === 'host') {
    const engine = takeover.host?.engine
    return { kind: 'host', canTakeOver: engine !== undefined && takeover.host?.active !== true, canRestore: engine?.enabled === true }
  }
  const standard = takeover.presets.find(preset => preset.presetId === STANDARD_PRESET)
  return {
    kind: 'preset',
    canTakeOver: takeover.editable && (standard?.state === 'available' || standard?.state === 'outdated'),
    canRestore: takeover.editable && standard !== undefined && TAKEN_OVER.has(standard.state),
  }
}

export interface NoticeView {
  readonly tone: Tone
  readonly lines: readonly string[]
}

export function noticeView(notice: ActionNotice, t: Translate): NoticeView {
  if ('failure' in notice) {
    const key = {
      level: 'noticeLevelRequestFailed', mode: 'noticeModeRequestFailed',
      takeover: 'noticeTakeoverFailed', restore: 'noticeRestoreFailed',
    } as const
    return { tone: 'error', lines: [t(key[notice.action], { code: notice.failure.code, message: notice.failure.message })] }
  }
  switch (notice.action) {
    case 'level':
      return notice.result.ok
        ? { tone: 'success', lines: [t('noticeLevelSaved', { level: notice.level })] }
        : { tone: 'error', lines: [t('noticeLevelWriteFailed', { message: notice.result.message })] }
    case 'mode':
      return notice.result.ok
        ? { tone: 'success', lines: [t('noticeModeSaved', { mode: modeLabel(notice.mode, t) })] }
        : { tone: 'error', lines: [t('noticeModeWriteFailed', { message: notice.result.message })] }
    case 'takeover':
    case 'restore': {
      const restoring = notice.action === 'restore'
      const { result } = notice
      if (result.kind === 'host') {
        const { outcome } = result
        const key = hostSuccessKey(outcome.application, restoring)
        const done = key === undefined ? t('noticeHostOk', { message: outcome.message }) : t(key)
        const lines = [outcome.ok ? done : t(restoring ? 'noticeRestoreFailed' : 'noticeTakeoverFailed', {
          code: outcome.application, message: t('noticeHostFailed', { message: outcome.message }),
        })]
        if (outcome.restartReasons.length > 0) lines.push(t('noticeRestart', { reasons: outcome.restartReasons.join(', ') }))
        return { tone: outcome.ok ? 'success' : 'error', lines }
      }
      if (!result.ok) {
        return { tone: 'error', lines: [t(restoring ? 'noticeRestoreFailed' : 'noticeTakeoverFailed', { code: result.code, message: result.message })] }
      }
      const done = result.action === 'applied'
        ? t('noticeTakeoverApplied')
        : result.action === 'restored'
          ? t('noticeRestored')
          : t(restoring ? 'noticeRestoreUnchanged' : 'noticeTakeoverUnchanged')
      return {
        tone: result.action === 'unchanged' ? 'info' : 'success',
        lines: result.warning === undefined ? [done] : [done, t('noticeWarning', { message: result.warning })],
      }
    }
  }
}
