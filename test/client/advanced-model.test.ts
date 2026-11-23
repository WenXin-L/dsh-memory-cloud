import { describe, expect, it } from 'vitest'
import {
  addRule,
  configNoticeView,
  draftOf,
  editRule,
  highestCapture,
  moveRule,
  NUMBER_LIMITS,
  OVERRIDE_LIMIT,
  overridePlaceholder,
  readDraft,
  rebaseDraft,
  removeRule,
  wildcardCount,
} from '../../src/client/advanced-model.ts'
import type { ConfigDraft } from '../../src/client/advanced-model.ts'
import { NUMBER_FIELDS, OVERRIDE_FIELDS } from '../../src/client/contract.ts'
import { en, zh } from '../../src/client/locales.ts'
import { Config } from '../../src/config.ts'
import { resolveBudget } from '../../src/pack/budget.ts'
import { compileGlob } from '../../src/scope/glob.ts'
import { templateCaptures, UNMATCHED_SESSIONS } from '../../src/scope/index.ts'
import { translator, volatileConfig } from './fixtures.ts'

const tEn = translator(en)
const tZh = translator(zh)

interface MetaNode {
  readonly meta: { readonly min?: number; readonly max?: number; readonly step?: number; readonly description?: string }
  readonly dict?: Readonly<Record<string, MetaNode>>
}
const schema = Config as unknown as MetaNode

const withNumbers = (draft: ConfigDraft, numbers: Partial<ConfigDraft['numbers']>): ConfigDraft => ({ ...draft, numbers: { ...draft.numbers, ...numbers } })

describe('limits', () => {
  it('mirror the Config schema', () => {
    for (const field of NUMBER_FIELDS) {
      const meta = schema.dict?.[field]?.meta
      const limit = NUMBER_LIMITS[field]
      expect(limit.min, field).toBe(meta?.min)
      expect(limit.max, field).toBe(meta?.max)
      expect(limit.integer === true, field).toBe(meta?.step === 1)
    }
    for (const field of OVERRIDE_FIELDS) {
      const meta = schema.dict?.overrides?.dict?.[field]?.meta
      expect([OVERRIDE_LIMIT.min, OVERRIDE_LIMIT.integer === true], field).toEqual([meta?.min, meta?.step === 1])
    }
  })
})

describe('draft', () => {
  const base = volatileConfig({
    overrides: { retainTokens: 4096 },
    scopeRules: [{ match: 'qqbot:*:group:*', scope: 'qq-group-$2' }, { match: 'preset:ptc', scope: 'work' }],
  })

  it('round-trips the live settings without changes', () => {
    const draft = draftOf(base)
    expect(draft.numbers).toEqual({ idleMinutes: '30', idleCompactRatio: '0.5', halfLifeDays: '14', maxEpisodeTokens: '32768' })
    expect(draft.overrides).toMatchObject({ retainTokens: '4096', gistTokens: '' })
    expect(draft.scopeRules).toEqual([{ id: 0, match: 'qqbot:*:group:*', scope: 'qq-group-$2' }, { id: 1, match: 'preset:ptc', scope: 'work' }])
    expect(readDraft(draft, base, tEn)).toEqual({ errors: {}, patch: {}, changed: false })
  })

  it('patches only changed fields; summarizer per field, overrides and rules whole', () => {
    let draft = draftOf(base)
    draft = { ...draft, summarizer: { ...draft.summarizer, provider: '  deepseek ', reasoningEffort: '' } }
    draft = withNumbers(draft, { idleMinutes: '45', halfLifeDays: '14.0' })
    draft = { ...draft, captureReasoning: false, overrides: { ...draft.overrides, retainTokens: '', gistTokens: '40' } }
    draft = moveRule(draft, 1, -1)
    expect(readDraft(draft, base, tEn)).toEqual({
      errors: {},
      changed: true,
      patch: {
        summarizer: { provider: 'deepseek', reasoningEffort: '' },
        idleMinutes: 45,
        captureReasoning: false,
        overrides: { gistTokens: 40 },
        scopeRules: [{ match: 'preset:ptc', scope: 'work' }, { match: 'qqbot:*:group:*', scope: 'qq-group-$2' }],
      },
    })
  })

  it('round-trips and patches the unmatched-session setting', () => {
    const draft = draftOf(base)
    expect(draft.unmatchedSessions).toBe('auto')
    expect(readDraft({ ...draft, unmatchedSessions: 'isolated' }, base, tEn)).toEqual({ errors: {}, changed: true, patch: { unmatchedSessions: 'isolated' } })
    expect(readDraft(draftOf(volatileConfig({ unmatchedSessions: 'owner' })), volatileConfig({ unmatchedSessions: 'owner' }), tEn).changed).toBe(false)
  })

  it('labels every unmatched-session choice in both languages', () => {
    for (const value of UNMATCHED_SESSIONS) {
      expect(tEn(`advUnmatched_${value}`)).not.toBe('')
      expect(tZh(`advUnmatched_${value}`)).not.toBe('')
    }
    expect(tEn('advUnmatchedHint')).toContain('owner')
    expect(tZh('advUnmatchedHint')).toContain('owner')
  })

  it('rebases an unsaved draft onto reloaded settings, re-applying only the fields the user changed', () => {
    let draft = draftOf(base)
    draft = { ...draft, summarizer: { ...draft.summarizer, model: 'deepseek-pro' } }
    draft = withNumbers(draft, { idleMinutes: ' 30 ', halfLifeDays: '7' })
    draft = { ...draft, overrides: { ...draft.overrides, gistTokens: '40' } }
    const next = volatileConfig({
      idleMinutes: 45,
      summarizer: { provider: 'other', model: 'deepseek-flash', reasoningEffort: 'off' },
      overrides: { retainTokens: 2048, recallLimitTokens: 1024 },
      scopeRules: [{ match: 'cwd:/srv/*', scope: 'owner' }],
      unmatchedSessions: 'owner',
    })
    const rebased = rebaseDraft(draft, base, next)
    expect(readDraft(rebased, next, tEn)).toEqual({
      errors: {},
      changed: true,
      patch: { summarizer: { model: 'deepseek-pro' }, halfLifeDays: 7, overrides: { retainTokens: 2048, recallLimitTokens: 1024, gistTokens: 40 } },
    })
    expect(rebased.scopeRules).toEqual(draftOf(next).scopeRules)

    const invalid = rebaseDraft(withNumbers(draftOf(base), { idleMinutes: 'abc' }), base, next)
    expect(invalid.numbers.idleMinutes).toBe('abc')
    const ruled = rebaseDraft(editRule(draftOf(base), 1, 'scope', 'office'), base, next)
    expect(readDraft(ruled, next, tEn).patch).toMatchObject({ scopeRules: [{ match: 'qqbot:*:group:*', scope: 'qq-group-$2' }, { match: 'preset:ptc', scope: 'office' }] })
    const cleared = rebaseDraft({ ...draftOf(base), overrides: { ...draftOf(base).overrides, retainTokens: '' }, unmatchedSessions: 'isolated' }, base, next)
    expect(readDraft(cleared, next, tEn).patch).toEqual({ overrides: { recallLimitTokens: 1024 }, unmatchedSessions: 'isolated' })
    expect(rebaseDraft(draftOf(base), base, next)).toEqual(draftOf(next))
  })

  it('clears every override when all fields are empty', () => {
    const draft = draftOf(base)
    const cleared = { ...draft, overrides: { ...draft.overrides, retainTokens: ' ' } }
    expect(readDraft(cleared, base, tEn).patch).toEqual({ overrides: {} })
  })

  it('validates numbers with localized messages', () => {
    const draft = withNumbers(draftOf(base), { idleMinutes: '0.5', idleCompactRatio: '1.5', halfLifeDays: 'abc', maxEpisodeTokens: '' })
    const withOverride = { ...draft, overrides: { ...draft.overrides, gistTokens: '2.5', recallLimitTokens: '-1' } }
    const reading = readDraft(withOverride, base, tEn)
    expect(reading.errors).toEqual({
      idleMinutes: 'Must be at least 1.',
      idleCompactRatio: 'Must be at most 1.',
      halfLifeDays: 'Enter a number.',
      maxEpisodeTokens: 'Required.',
      'overrides.gistTokens': 'Enter a whole number.',
      'overrides.recallLimitTokens': 'Must be at least 0.',
    })
    expect(reading.changed).toBe(true)
    expect(readDraft(withNumbers(draftOf(base), { maxEpisodeTokens: '1.5' }), base, tZh).errors).toEqual({ maxEpisodeTokens: '请输入整数。' })
  })

  it('validates scope rules: required fields and captures the pattern provides', () => {
    let draft = addRule(addRule(draftOf(volatileConfig())))
    draft = editRule(draft, 0, 'scope', 'room-$1')
    draft = editRule(editRule(draft, 1, 'match', 'qqbot:*:group:\\*'), 1, 'scope', 'qq-$2')
    expect(readDraft(draft, volatileConfig(), tEn).errors).toEqual({
      'scopeRules.0.match': 'Required.',
      'scopeRules.1.scope': 'Uses $2, but the pattern has only 1 wildcard(s).',
    })
    const fixed = editRule(editRule(draft, 0, 'match', 'cwd:/srv/*'), 1, 'scope', 'qq-$1-$&-$$')
    expect(readDraft(fixed, volatileConfig(), tEn)).toMatchObject({
      errors: {},
      patch: { scopeRules: [{ match: 'cwd:/srv/*', scope: 'room-$1' }, { match: 'qqbot:*:group:\\*', scope: 'qq-$1-$&-$$' }] },
    })
  })
})

describe('scope rule helpers', () => {
  it('count captures the way the glob compiler does', () => {
    for (const pattern of ['qqbot:*:group:*', 'a?b*', 'literal', 'escaped\\*star*', 'trailing\\']) {
      expect(wildcardCount(pattern), pattern).toBe(compileGlob(pattern).match(pattern.replace(/\\(.)/g, '$1'))?.length ?? -1)
      expect(wildcardCount(pattern), pattern).toBe(compileGlob(pattern).wildcards)
    }
    for (const template of ['qq-group-$2', '$$9-$&-$0', 'plain', '$1-$3']) expect(highestCapture(template), template).toBe(templateCaptures(template))
    expect(wildcardCount('qqbot:*:group:*')).toBe(2)
    expect(wildcardCount('escaped\\*star*')).toBe(1)
    expect(highestCapture('qq-group-$2')).toBe(2)
    expect(highestCapture('$$9-$&-$0')).toBe(0)
    expect(highestCapture('plain')).toBe(0)
  })

  it('add, remove and reorder rules by id', () => {
    let draft = draftOf(volatileConfig({ scopeRules: [{ match: 'a', scope: 'x' }, { match: 'b', scope: 'y' }] }))
    draft = addRule(draft)
    expect(draft.scopeRules.map(rule => rule.id)).toEqual([0, 1, 2])
    draft = moveRule(draft, 2, -2)
    expect(draft.scopeRules.map(rule => rule.id)).toEqual([2, 0, 1])
    expect(moveRule(draft, 2, -1)).toBe(draft)
    expect(moveRule(draft, 1, 1)).toBe(draft)
    draft = removeRule(draft, 0)
    expect(draft.scopeRules.map(rule => [rule.id, rule.match])).toEqual([[2, ''], [1, 'b']])
    expect(addRule(draft).scopeRules.at(-1)?.id).toBe(3)
  })
})

describe('labels', () => {
  it('labels the preset value as a ceiling when no live session resolved the level', () => {
    expect(overridePlaceholder('workingMemoryTokens', 1, tEn)).toBe('level 1 ceiling: 80% of the window')
    expect(overridePlaceholder('retainTokens', 3, tEn)).toBe('level 3 ceiling: 24576')
    expect(overridePlaceholder('recentSummaryCount', 5, tZh)).toBe('档位 5 上限：2')
    expect(tEn('advOverridesHint')).toMatch(/ceiling.*skips the lower-level cap/)
    expect(tZh('advOverridesHint')).toMatch(/预设上限.*跳过更低档位的限制/)
  })

  it('shows what an empty override resolves to on the live session, not the ladder-capped preset', () => {
    const budget = resolveBudget({ level: 3, capacity: { contextWindow: 131072, reservedOutputTokens: 8192 }, headroomTokens: 8192, memoryShare: 0.25 })
    expect(budget.thresholdTokens).toBeLessThan(131072)
    const live = { budget, overrides: {} }
    expect(overridePlaceholder('workingMemoryTokens', 3, tEn, live)).toBe(`level 3, active session: ${budget.thresholdTokens}`)
    expect(overridePlaceholder('retainTokens', 3, tZh, live)).toBe(`档位 3，当前会话：${budget.retainTokens}`)
    expect(overridePlaceholder('recallLimitTokens', 3, tEn, live)).toBe(`level 3, active session: ${budget.recallLimitTokens}`)
    expect(overridePlaceholder('retainTokens', 3, tEn, { budget, overrides: { retainTokens: 4096 } })).toBe('level 3 ceiling: 24576')
    expect(overridePlaceholder('gistTokens', 3, tEn, { budget, overrides: { retainTokens: 4096 } })).toBe(`level 3, active session: ${budget.gistTokens}`)
    expect(overridePlaceholder('retainTokens', 4, tEn, live)).toBe('level 4 ceiling: 12288')
    expect(overridePlaceholder('gistTokens', 3, tEn, { budget: { ...budget, gistTokens: null as unknown as number }, overrides: {} })).toBe('level 3 ceiling: 50')
  })

  it('says that 0 turns size-based sealing off', () => {
    expect(tEn('advMaxEpisodeTokensHint')).toMatch(/0 turns size-based sealing off/)
    expect(tZh('advMaxEpisodeTokensHint')).toMatch(/填 0 则不按大小封存/)
    expect(schema.dict?.maxEpisodeTokens?.meta.description).toMatch(/0 disables size-based sealing/)
  })

  it('words save outcomes', () => {
    expect(configNoticeView({ result: { ok: true, via: 'settings' } }, tEn)).toEqual({ tone: 'success', lines: ['Settings saved; they apply live.'] })
    expect(configNoticeView({ result: { ok: false, message: 'overridden by --patch' } }, tZh)).toEqual({ tone: 'error', lines: ['未保存：overridden by --patch'] })
    expect(configNoticeView({ failure: { code: 'remote-access/denied', message: 'access denied' } }, tEn))
      .toEqual({ tone: 'error', lines: ['Request failed (remote-access/denied): access denied'] })
  })
})
