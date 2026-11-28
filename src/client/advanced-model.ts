/**
 * Pure model of the Advanced section: a form draft seeded from the live
 * settings, its validation, and the `setConfig` patch it implies.
 */
import type { CompressionLevel, ResolvedBudget, ScopeRule, TokenBudget } from '../contracts.ts'
import { LEVEL_PRESETS } from '../contracts.ts'
import type { UnmatchedSessions } from '../scope/guard.ts'
import type { ConfigNotice } from './config-store.ts'
import type { ConfigPatch, NumberField, OverrideField, SummarizerField, VolatileConfig } from './contract.ts'
import { NUMBER_FIELDS, OVERRIDE_FIELDS, SUMMARIZER_FIELDS } from './contract.ts'
import type { NoticeView, Translate } from './view-model.ts'
import { formatPercent } from './view-model.ts'

export interface NumberLimit {
  readonly min?: number
  readonly max?: number
  readonly integer?: true
}

/** Mirrors the Config schema (`src/config.ts`); the host validates again. */
export const NUMBER_LIMITS: Readonly<Record<NumberField, NumberLimit>> = {
  idleMinutes: { min: 1 },
  idleCompactRatio: { min: 0, max: 1 },
  halfLifeDays: { min: 0.1 },
  maxEpisodeTokens: { min: 0, integer: true },
}

/** Every override is a natural number. */
export const OVERRIDE_LIMIT: NumberLimit = { min: 0, integer: true }

export interface DraftRule {
  /** Local key for rendering and errors; not persisted. */
  readonly id: number
  readonly match: string
  readonly scope: string
}

export interface ConfigDraft {
  readonly timeAwareness: boolean
  readonly summarizer: Readonly<Record<SummarizerField, string>>
  readonly numbers: Readonly<Record<NumberField, string>>
  readonly captureReasoning: boolean
  /** An empty string keeps the level's own value. */
  readonly overrides: Readonly<Record<OverrideField, string>>
  readonly scopeRules: readonly DraftRule[]
  readonly unmatchedSessions: UnmatchedSessions
}

export function draftOf(config: VolatileConfig): ConfigDraft {
  return {
    timeAwareness: config.timeAwareness,
    summarizer: { ...config.summarizer },
    numbers: Object.fromEntries(NUMBER_FIELDS.map(field => [field, String(config[field])])) as Record<NumberField, string>,
    captureReasoning: config.captureReasoning,
    overrides: Object.fromEntries(OVERRIDE_FIELDS.map((field) => {
      const value = config.overrides[field]
      return [field, value === undefined ? '' : String(value)]
    })) as Record<OverrideField, string>,
    scopeRules: config.scopeRules.map((rule, id) => ({ id, match: rule.match, scope: rule.scope })),
    unmatchedSessions: config.unmatchedSessions,
  }
}

/** Number of `*`/`?` wildcards (each one capture) in a scope-rule pattern; `\` escapes. */
export function wildcardCount(pattern: string): number {
  let count = 0
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '\\') index++
    else if (char === '*' || char === '?') count++
  }
  return count
}

/** Highest `$1`–`$9` capture a scope template uses (`$$` is a literal `$`, `$&`/`$0` the whole tag). */
export function highestCapture(template: string): number {
  let highest = 0
  for (const [, key] of template.matchAll(/\$([$&\d])/g)) {
    const index = Number(key)
    if (Number.isInteger(index) && index > highest) highest = index
  }
  return highest
}

type NumberReading = { readonly value: number } | { readonly error: string }

export function readNumber(text: string, limit: NumberLimit, t: Translate): NumberReading {
  const trimmed = text.trim()
  if (trimmed === '') return { error: t('advErrorRequired') }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { error: t('advErrorNumber') }
  if (limit.integer === true && !Number.isInteger(value)) return { error: t('advErrorInteger') }
  if (limit.min !== undefined && value < limit.min) return { error: t('advErrorMin', { min: limit.min }) }
  if (limit.max !== undefined && value > limit.max) return { error: t('advErrorMax', { max: limit.max }) }
  return { value }
}

export interface DraftReading {
  /** Localized problems keyed by field: `idleMinutes`, `overrides.gistTokens`, `scopeRules.<id>.scope`, … */
  readonly errors: Readonly<Record<string, string>>
  /** Fields that differ from `base`; only meaningful without errors. */
  readonly patch: ConfigPatch
  /** Whether the form differs from `base` (including invalid edits). */
  readonly changed: boolean
}

const sameOverrides = (a: VolatileConfig['overrides'], b: VolatileConfig['overrides']): boolean =>
  OVERRIDE_FIELDS.every(field => a[field] === b[field])

const sameRules = (a: readonly ScopeRule[], b: readonly ScopeRule[]): boolean =>
  a.length === b.length && a.every((rule, index) => rule.match === b[index]?.match.trim() && rule.scope === b[index]?.scope.trim())

/** Validate `draft` and derive the patch that turns `base` into it. Strings are trimmed. */
export function readDraft(draft: ConfigDraft, base: VolatileConfig, t: Translate): DraftReading {
  const errors: Record<string, string> = {}
  const patch: { -readonly [K in keyof ConfigPatch]: ConfigPatch[K] } = {}

  if (draft.timeAwareness !== base.timeAwareness) patch.timeAwareness = draft.timeAwareness

  const summarizer: Partial<Record<SummarizerField, string>> = {}
  for (const field of SUMMARIZER_FIELDS) {
    const value = draft.summarizer[field].trim()
    if (value !== base.summarizer[field].trim()) summarizer[field] = value
  }
  if (Object.keys(summarizer).length > 0) patch.summarizer = summarizer

  for (const field of NUMBER_FIELDS) {
    const reading = readNumber(draft.numbers[field], NUMBER_LIMITS[field], t)
    if ('error' in reading) errors[field] = reading.error
    else if (reading.value !== base[field]) patch[field] = reading.value
  }
  if (draft.captureReasoning !== base.captureReasoning) patch.captureReasoning = draft.captureReasoning

  const overrides: Partial<Record<OverrideField, number>> = {}
  for (const field of OVERRIDE_FIELDS) {
    if (draft.overrides[field].trim() === '') continue
    const reading = readNumber(draft.overrides[field], OVERRIDE_LIMIT, t)
    if ('error' in reading) errors[`overrides.${field}`] = reading.error
    else overrides[field] = reading.value
  }
  if (!sameOverrides(overrides, base.overrides)) patch.overrides = overrides

  const rules = draft.scopeRules.map((rule): ScopeRule => {
    const match = rule.match.trim()
    const scope = rule.scope.trim()
    if (match === '') errors[`scopeRules.${rule.id}.match`] = t('advErrorRequired')
    const capture = highestCapture(scope)
    const count = wildcardCount(match)
    if (scope === '') errors[`scopeRules.${rule.id}.scope`] = t('advErrorRequired')
    else if (match !== '' && capture > count) errors[`scopeRules.${rule.id}.scope`] = t('advErrorCapture', { capture, count })
    return { match, scope }
  })
  if (!sameRules(rules, base.scopeRules)) patch.scopeRules = rules
  if (draft.unmatchedSessions !== base.unmatchedSessions) patch.unmatchedSessions = draft.unmatchedSessions

  return { errors, patch, changed: Object.keys(errors).length > 0 || Object.keys(patch).length > 0 }
}

const sameText = (text: string, value: string): boolean => text.trim() === value.trim()

/** Whether a number field's text still means `value`; blank means unset. */
function sameNumber(text: string, value: number | undefined): boolean {
  const trimmed = text.trim()
  return trimmed === '' ? value === undefined : Number(trimmed) === value
}

/**
 * Carry an unsaved draft over to reloaded settings (a three-way rebase): start
 * from `next` and re-apply only the fields where `draft` differs from
 * `previous`, the settings it was edited against, so a value changed elsewhere
 * in the meantime is not written back by the next save.
 */
export function rebaseDraft(draft: ConfigDraft, previous: VolatileConfig, next: VolatileConfig): ConfigDraft {
  const fresh = draftOf(next)
  const rules = draft.scopeRules.map(rule => ({ match: rule.match.trim(), scope: rule.scope.trim() }))
  return {
    timeAwareness: draft.timeAwareness === previous.timeAwareness ? fresh.timeAwareness : draft.timeAwareness,
    summarizer: Object.fromEntries(SUMMARIZER_FIELDS.map(field =>
      [field, sameText(draft.summarizer[field], previous.summarizer[field]) ? fresh.summarizer[field] : draft.summarizer[field]],
    )) as Record<SummarizerField, string>,
    numbers: Object.fromEntries(NUMBER_FIELDS.map(field =>
      [field, sameNumber(draft.numbers[field], previous[field]) ? fresh.numbers[field] : draft.numbers[field]],
    )) as Record<NumberField, string>,
    captureReasoning: draft.captureReasoning === previous.captureReasoning ? fresh.captureReasoning : draft.captureReasoning,
    overrides: Object.fromEntries(OVERRIDE_FIELDS.map(field =>
      [field, sameNumber(draft.overrides[field], previous.overrides[field]) ? fresh.overrides[field] : draft.overrides[field]],
    )) as Record<OverrideField, string>,
    scopeRules: sameRules(rules, previous.scopeRules) ? fresh.scopeRules : draft.scopeRules,
    unmatchedSessions: draft.unmatchedSessions === previous.unmatchedSessions ? fresh.unmatchedSessions : draft.unmatchedSessions,
  }
}

export function addRule(draft: ConfigDraft): ConfigDraft {
  const id = draft.scopeRules.reduce((highest, rule) => Math.max(highest, rule.id + 1), 0)
  return { ...draft, scopeRules: [...draft.scopeRules, { id, match: '', scope: '' }] }
}

export function removeRule(draft: ConfigDraft, id: number): ConfigDraft {
  return { ...draft, scopeRules: draft.scopeRules.filter(rule => rule.id !== id) }
}

/** Move a rule `delta` places (rules are tried in order); out-of-range moves change nothing. */
export function moveRule(draft: ConfigDraft, id: number, delta: number): ConfigDraft {
  const from = draft.scopeRules.findIndex(rule => rule.id === id)
  const to = from + delta
  const rule = draft.scopeRules[from]
  if (rule === undefined || to < 0 || to >= draft.scopeRules.length) return draft
  const rules = draft.scopeRules.filter(candidate => candidate.id !== id)
  rules.splice(to, 0, rule)
  return { ...draft, scopeRules: rules }
}

export function editRule(draft: ConfigDraft, id: number, field: 'match' | 'scope', value: string): ConfigDraft {
  return { ...draft, scopeRules: draft.scopeRules.map(rule => rule.id === id ? { ...rule, [field]: value } : rule) }
}

function budgetValue(budget: TokenBudget, t: Translate): string {
  return budget.kind === 'ratio' ? t('advWindowShare', { percent: formatPercent(budget.ratio) }) : String(budget.tokens)
}

const RESOLVED_FIELDS: Readonly<Record<OverrideField, Exclude<keyof ResolvedBudget, 'level' | 'quotas' | 'thresholdRatio'>>> = {
  workingMemoryTokens: 'thresholdTokens',
  retainTokens: 'retainTokens',
  memoryBudgetTokens: 'memoryBudgetTokens',
  recentSummaryCount: 'recentSummaryCount',
  recentSummaryTokens: 'recentSummaryTokens',
  gistTokens: 'gistTokens',
  recallLimitTokens: 'recallLimitTokens',
}

/** A live session's resolved budget and the overrides it was resolved with. */
export interface LiveBudget {
  readonly budget: ResolvedBudget
  readonly overrides: VolatileConfig['overrides']
}

/**
 * Input placeholder of an empty override at `level`. With a live budget at that
 * level that does not override `field`, the value it resolved to on the
 * session's model; otherwise the level's preset ceiling, which lower levels and
 * the window may cap further (an override skips the lower-level cap).
 */
export function overridePlaceholder(field: OverrideField, level: CompressionLevel, t: Translate, live?: LiveBudget): string {
  const resolved: unknown = live?.budget.level === level && live.overrides[field] === undefined ? live.budget[RESOLVED_FIELDS[field]] : undefined
  if (typeof resolved === 'number' && Number.isFinite(resolved)) return t('advLevelResolved', { level, value: String(resolved) })
  const preset = LEVEL_PRESETS[level]
  const value = field === 'workingMemoryTokens'
    ? budgetValue(preset.workingMemory, t)
    : field === 'retainTokens'
      ? budgetValue(preset.retain, t)
      : String(preset[field])
  return t('advLevelCeiling', { level, value })
}

export function configNoticeView(notice: ConfigNotice, t: Translate): NoticeView {
  if ('failure' in notice) return { tone: 'error', lines: [t('noticeRemoteFailed', { code: notice.failure.code, message: notice.failure.message })] }
  return notice.result.ok
    ? { tone: 'success', lines: [t('advSaved')] }
    : { tone: 'error', lines: [t('noticeSettingFailed', { message: notice.result.message })] }
}
