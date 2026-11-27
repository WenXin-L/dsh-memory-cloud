import { describe, expect, it } from 'vitest'
import { en, zh } from '../../src/client/locales.ts'
import {
  effectiveMode,
  formatPercent,
  formatTokens,
  languageOf,
  levelTable,
  modeOptions,
  modeView,
  noticeView,
  shortId,
  statusFacts,
  takeoverControls,
} from '../../src/client/view-model.ts'
import type { Fact } from '../../src/client/view-model.ts'
import { COMPACTION_MODES, COMPRESSION_LEVELS } from '../../src/contracts.ts'
import type { TakeoverReport } from '../../src/runtime/status.ts'
import { decideMode } from '../../src/runtime/mode.ts'
import { decideUnmatched, detectCoexistence } from '../../src/scope/index.ts'
import { agentReport, translator, wireStatus } from './fixtures.ts'

const tEn = translator(en)
const tZh = translator(zh)

const fact = (facts: readonly Fact[], key: string): Fact => {
  const found = facts.find(item => item.key === key)
  if (found === undefined) throw new Error(`no fact ${key}`)
  return found
}
const texts = (item: Fact): string[] => item.lines.map(line => line.text)

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort()

describe('dictionaries', () => {
  it('give zh and en the same keys and the same placeholders', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]))
  })
})

describe('formatting', () => {
  it('formats tokens in K units and ratios as percents', () => {
    expect(formatTokens(512)).toBe('512')
    expect(formatTokens(24576)).toBe('24K')
    expect(formatTokens(1536)).toBe('1.5K')
    expect(formatTokens(8064)).toBe('7.9K')
    expect(formatTokens(8190)).toBe('8K')
    expect(formatPercent(0.875)).toBe('88%')
  })

  it('shortens session ids without their prefix', () => {
    expect(shortId('session-230a74ec-8f54-422f-a364-764000231f97')).toBe('230a74ec')
    expect(shortId('sess-1234567890')).toBe('sess-123')
    expect(shortId('abc')).toBe('abc')
  })

  it('picks the host language from the active locale', () => {
    expect(languageOf('zh')).toBe('zh')
    expect(languageOf('zh-CN')).toBe('zh')
    expect(languageOf('en')).toBe('en')
    expect(languageOf('ja')).toBe('en')
    expect(languageOf(undefined)).toBe('en')
  })
})

describe('level table', () => {
  it('describes every level from LEVEL_PRESETS', () => {
    const rows = levelTable(tEn)
    expect(rows.map(row => row.level)).toEqual([...COMPRESSION_LEVELS])
    expect(rows[0]).toEqual({
      level: 1,
      title: 'Most context (DSH default thresholds)',
      detail: 'compacts at 80% of the window · keeps 16% verbatim · memory block 48K · 10 recent summaries × 1.5K · gists of 80 · recall up to 16K',
    })
    expect(rows[2]).toEqual({
      level: 3,
      title: 'Balanced (default)',
      detail: 'compacts at 128K · keeps 24K verbatim · memory block 24K · 6 recent summaries × 800 · gists of 50 · recall up to 8K',
    })
  })

  it('is localized', () => {
    expect(levelTable(tZh)[4]).toEqual({
      level: 5,
      title: '最精简，最早压缩',
      detail: '达到 32K 时压缩 · 保留 6K 原文 · 记忆块 6K · 近期摘要 2 条 × 300 · 每条总结 25 · 单次回忆 ≤ 2K',
    })
  })

  it('lists every compaction mode with a hint', () => {
    expect(modeOptions(tEn).map(option => [option.mode, option.label])).toEqual([['auto', 'Auto'], ['engine', 'Engine'], ['assist', 'Assist'], ['off', 'Off']])
    expect(modeOptions(tZh).every(option => option.hint.length > 0)).toBe(true)
  })
})

describe('mode', () => {
  it('follows the host rule (decideMode) for new sessions', () => {
    for (const rows of [[], ['dsh-taskfold/plugins']]) {
      const coexistence = detectCoexistence(rows)
      const others = coexistence.compactionPlugins.map(plugin => plugin.id)
      for (const configured of COMPACTION_MODES) {
        for (const engineActive of [false, true]) {
          expect(effectiveMode(configured, engineActive, others), `${configured}/${engineActive}/${rows.join()}`)
            .toBe(decideMode(configured, engineActive, coexistence).mode)
        }
      }
    }
  })

  it("explains a live session's decision", () => {
    const view = modeView(wireStatus({ agent: agentReport() }), tEn)
    expect(view).toEqual({
      mode: 'assist',
      configured: 'auto',
      reason: "In auto, DSH owns compaction here, so memory cloud uses assist mode. After takeover, new sessions can use its engine if Memory Cloud detects no other known compaction plugin.",
      context: 'session sess-123 · configured Auto',
    })
  })

  it('predicts new sessions from the takeover state without a live session', () => {
    expect(modeView(wireStatus(), tZh)).toMatchObject({ mode: 'assist', context: '新会话预计使用此模式 · 暂无活跃会话 · 配置为自动' })
    const takenOver: TakeoverReport = { kind: 'preset', editable: true, presets: [{ entryId: 'preset-standard', presetId: 'standard', state: 'active', recorded: true }] }
    expect(modeView(wireStatus({ takeover: takenOver }), tEn)).toMatchObject({
      mode: 'engine',
      reason: "In auto, memory cloud uses its engine because it owns compaction and it detects no other known compaction plugin.",
    })
    expect(modeView(wireStatus({ takeover: takenOver, coexistence: detectCoexistence(['dsh-taskfold/plugins']) }), tEn)).toMatchObject({
      mode: 'assist',
      reason: 'In auto, memory cloud uses assist mode because another compaction plugin is loaded (dsh-taskfold).',
    })
    expect(modeView(wireStatus({ configured: { level: 3, compactionMode: 'engine', unmatchedSessions: 'auto' } }), tEn)).toMatchObject({ mode: 'assist', configured: 'engine' })
    expect(modeView(wireStatus({ configured: { level: 3, compactionMode: 'off', unmatchedSessions: 'auto' } }), tEn)).toMatchObject({ mode: 'off' })
  })
})

describe('status facts', () => {
  it('renders every section for a live session', () => {
    const facts = statusFacts(wireStatus({ agent: agentReport() }), tEn, 'en')
    expect(facts.map(item => item.key)).toEqual(['mode', 'level', 'budget', 'episodes', 'jobs', 'takeover', 'firewall', 'coexistence', 'registrations', 'storage'])
    expect(fact(facts, 'mode').tag).toEqual({ text: 'Assist · assist', tone: 'info' })
    expect(texts(fact(facts, 'level'))[0]).toBe('Level 3 — Balanced (default)')
    expect(texts(fact(facts, 'budget'))).toEqual([
      'deepseek/deepseek-chat · window 128K · output reserve 8K',
      'compacts at 112K (88% of the window) · keeps 24K verbatim · memory block 24K',
      `profile ${formatTokens(2304)} / recent ${formatTokens(12672)} / distant ${formatTokens(8064)} / ongoing 1.5K`,
      '6 recent summaries × 800 · gists of 50 · recall up to 8K · context pressure 42%',
    ])
    expect(texts(fact(facts, 'episodes'))).toEqual(['owner: open 1 · sealed 0 · summarized 12 · failed 1', 'pinned 1, hidden 0, period rollups 2'])
    expect(texts(fact(facts, 'jobs'))).toEqual(['queue 0 · today 3/200 · succeeded 3 · failed 0', 'circuit breaker closed'])
    expect(texts(fact(facts, 'takeover'))).toEqual(['preset standard: not taken over'])
    expect(fact(facts, 'firewall')).toEqual({
      key: 'firewall',
      label: 'Unmatched sessions',
      tag: { text: 'owner scope', tone: 'neutral' },
      lines: [{ text: 'No recognized chat bridge was detected. Unmatched sessions use the private owner scope and can read owner memory (unmatchedSessions: auto).' }],
    })
    expect(texts(fact(facts, 'coexistence'))).toEqual(['Memory cloud has taken attendance. No other memory or compaction plugins were detected.'])
    expect(texts(fact(facts, 'registrations'))).toEqual(['recall tools: registered · /memory: registered'])
    expect(texts(fact(facts, 'storage'))).toEqual(['/home/u/.dsh/memory-cloud · profile web'])
  })

  it('shows how unmatched sessions are scoped, and leaves the row out for a status without it', () => {
    const bridged = fact(statusFacts(wireStatus({ firewall: decideUnmatched('auto', ['qqbot']) }), tZh, 'zh'), 'firewall')
    expect(bridged.tag).toEqual({ text: '隔离', tone: 'info' })
    expect(texts(bridged)).toEqual([
      '每个未匹配规则的会话各有隔离作用域，无权读取主人记忆（unmatchedSessions：auto）。',
      '已加载聊天桥接插件：qqbot。',
      '要让自己的会话读取主人记忆，请只匹配你独用的标签，例如 cwd:/your/dir/* → owner。',
    ])
    expect(texts(fact(statusFacts(wireStatus({ firewall: decideUnmatched('isolated') }), tEn, 'en'), 'firewall'))).toEqual([
      'Each unmatched session gets an isolated scope without access to owner memory (unmatchedSessions: isolated).',
      'Give your own sessions access to owner memory with a rule for a tag only they use, such as cwd:/your/dir/* → owner.',
    ])
    expect(texts(fact(statusFacts(wireStatus({ firewall: decideUnmatched('owner') }), tEn, 'en'), 'firewall'))).toEqual([
      'Unmatched sessions use the private owner scope and can read owner memory (unmatchedSessions: owner).',
    ])
    const { firewall: _firewall, ...legacy } = wireStatus()
    expect(statusFacts(legacy, tEn, 'en').some(item => item.key === 'firewall')).toBe(false)
  })

  it('asks for a live session before showing a resolved budget', () => {
    const budget = fact(statusFacts(wireStatus(), tEn, 'en'), 'budget')
    expect(budget.lines).toEqual([{ text: 'The budget is holding a seat for a live session. Open or resume a conversation, then refresh to see its numbers.', muted: true }])
  })

  it('handles the wire form of an unlimited quota and shows job trouble', () => {
    const status = wireStatus()
    const jobs = {
      ...status.jobs,
      quota: { day: '2026-11-23', used: 7, limit: null as unknown as number },
      queue: [{ kind: 'summarize' as const, scope: status.scopes[0]?.scope as never, episode: 'ep-1' as never, notBefore: 0, attempts: 0 }],
      running: { job: { kind: 'rollup' as const, scope: 'owner' as never, period: { kind: 'week' as const, key: '2026-W47' }, notBefore: 0, attempts: 0 }, startedAt: 0 },
      breaker: { open: true, consecutiveFailures: 4 },
      lastError: { job: 'summarize:owner/ep-1', message: 'timeout', at: 0 },
    }
    const lines = fact(statusFacts({ ...status, jobs }, tEn, 'en'), 'jobs').lines
    expect(lines).toEqual([
      { text: 'queue 1 · today 7 · succeeded 3 · failed 0 · running 2026-W47' },
      { text: 'circuit breaker open after 4 consecutive failures', tone: 'warn' },
      { text: 'Last job failure (summarize:owner/ep-1) — timeout', tone: 'error' },
    ])
  })

  it('shows coexistence warnings in the page language, registration problems, and the last fallback', () => {
    const coexistence = detectCoexistence(['dsh-taskfold/plugins'])
    const status = wireStatus({
      coexistence,
      registrations: { tools: false, command: true, problems: ['回忆工具注册失败：duplicate tool memory_search'] },
      fallbacks: [{ kind: 'compose-failed' as never, stage: 'summarize', sessionId: 'sess-abcdefghijk', detail: 'timeout', at: 1 }],
    })
    const zhFacts = statusFacts(status, tZh, 'zh')
    expect(texts(fact(zhFacts, 'coexistence'))).toEqual([...coexistence.warnings.zh])
    expect(texts(fact(statusFacts(status, tEn, 'en'), 'coexistence'))).toEqual([...coexistence.warnings.en])
    expect(fact(zhFacts, 'registrations').lines).toEqual([
      { text: '回忆工具：未注册 · /memory 命令：已注册', tone: 'error' },
      { text: '回忆工具注册失败：duplicate tool memory_search', tone: 'error' },
    ])
    expect(texts(fact(zhFacts, 'fallback'))).toEqual(['compose-failed（summarize，会话 sess-abc）· 最近记录 1 次回退', 'timeout'])
  })

  it('describes takeover states for presets and host rows', () => {
    const preset = (state: 'active' | 'customized', detail?: string): TakeoverReport => ({
      kind: 'preset', editable: true, presets: [{ entryId: 'preset-standard', presetId: 'standard', state, recorded: true, ...detail === undefined ? {} : { detail } }],
    })
    expect(fact(statusFacts(wireStatus({ takeover: preset('active') }), tEn, 'en'), 'takeover').lines).toEqual([{ text: 'preset standard: taken over', tone: 'success' }])
    expect(texts(fact(statusFacts(wireStatus({ takeover: preset('customized', 'edited') }), tZh, 'zh'), 'takeover')))
      .toEqual(['预设 standard：含有自定义设置。要继续跟随 DSH 升级，请从未经修改的内置预设重新接管。 — edited'])
    expect(texts(fact(statusFacts(wireStatus({ takeover: { kind: 'preset', editable: false, presets: [] } }), tEn, 'en'), 'takeover')))
      .toEqual(['Taking over a preset needs the config editor. Start DSH with dsh --profile to make it available.'])
    const unavailable: TakeoverReport = { kind: 'preset', editable: false, presets: [], error: 'profile /test unavailable' }
    expect(texts(fact(statusFacts(wireStatus({ takeover: unavailable }), tEn, 'en'), 'takeover')))
      .toEqual(['Reading the compaction takeover state failed — profile /test unavailable'])
    const host: TakeoverReport = {
      kind: 'host', editable: true, presets: [],
      host: { engine: { entryId: 'dsh-memory-cloud-brain-engine', moduleName: 'dsh-memory-cloud-brain/engine', enabled: false }, active: false },
    }
    expect(texts(fact(statusFacts(wireStatus({ takeover: host }), tEn, 'en'), 'takeover'))).toEqual(['The memory engine is installed. It does not currently own host-level compaction.'])
  })
})

describe('takeover controls', () => {
  const report = (state?: 'available' | 'active' | 'outdated' | 'customized' | 'unsupported', editable = true): TakeoverReport => ({
    kind: 'preset', editable, presets: state === undefined ? [] : [{ entryId: 'preset-standard', presetId: 'standard', state, recorded: false }],
  })

  it('offers takeover or restore for the standard preset', () => {
    expect(takeoverControls(report('available'))).toEqual({ kind: 'preset', canTakeOver: true, canRestore: false })
    expect(takeoverControls(report('outdated'))).toEqual({ kind: 'preset', canTakeOver: true, canRestore: true })
    expect(takeoverControls(report('active'))).toEqual({ kind: 'preset', canTakeOver: false, canRestore: true })
    expect(takeoverControls(report('customized'))).toEqual({ kind: 'preset', canTakeOver: false, canRestore: true })
    expect(takeoverControls(report('unsupported'))).toEqual({ kind: 'preset', canTakeOver: false, canRestore: false })
    expect(takeoverControls(report())).toEqual({ kind: 'preset', canTakeOver: false, canRestore: false })
    expect(takeoverControls(report('available', false))).toEqual({ kind: 'preset', canTakeOver: false, canRestore: false })
  })

  it('toggles host engine rows in profiles without presets', () => {
    const engine = (enabled: boolean) => ({ entryId: 'dsh-memory-cloud-brain-engine', moduleName: 'dsh-memory-cloud-brain/engine', enabled })
    expect(takeoverControls({ kind: 'host', editable: true, presets: [], host: { engine: engine(false), active: false } }))
      .toEqual({ kind: 'host', canTakeOver: true, canRestore: false })
    expect(takeoverControls({ kind: 'host', editable: true, presets: [], host: { engine: engine(true), active: true } }))
      .toEqual({ kind: 'host', canTakeOver: false, canRestore: true })
    expect(takeoverControls({ kind: 'host', editable: false, presets: [], error: 'plugin manager unavailable' }))
      .toEqual({ kind: 'host', canTakeOver: false, canRestore: false })
  })
})

describe('action notices', () => {
  it('words takeover and restore outcomes', () => {
    expect(noticeView({ action: 'takeover', result: { kind: 'preset', ok: true, action: 'applied', warning: 'home patch also edits presets' } }, tEn)).toEqual({
      tone: 'success',
      lines: ['Memory cloud has taken over this preset’s compaction group. New sessions using the preset get the memory engine. Open sessions keep their current engine.', 'Takeover record or preset details — home patch also edits presets'],
    })
    expect(noticeView({ action: 'takeover', result: { kind: 'preset', ok: true, action: 'unchanged' } }, tZh)).toEqual({ tone: 'info', lines: ['记忆云已接管压缩。接管这件事只需要发生一次。'] })
    expect(noticeView({ action: 'restore', result: { kind: 'preset', ok: true, action: 'unchanged' } }, tEn)).toEqual({ tone: 'info', lines: ['There is no memory cloud takeover to restore on this preset.'] })
    expect(noticeView({ action: 'restore', result: { kind: 'preset', ok: true, action: 'restored' } }, tZh)).toEqual({ tone: 'success', lines: ['此预设的压缩接管已撤销，对使用该预设的新会话生效。'] })
    expect(noticeView({ action: 'restore', result: { kind: 'preset', ok: false, code: 'overridden', message: 'home patch overrides it' } }, tEn))
      .toEqual({ tone: 'error', lines: ['Restoring compaction failed (overridden) — home patch overrides it'] })
  })

  it('words host engine outcomes with restart reasons', () => {
    const outcome = { ok: true, application: 'restart-required' as const, restartReasons: ['no-hmr'], steps: [], message: '已启用引擎行' }
    expect(noticeView({ action: 'takeover', result: { kind: 'host', ok: true, outcome } }, tEn)).toEqual({
      tone: 'success',
      lines: ['The plugin manager saved the host takeover. Restart DSH to apply it.', 'DSH restart reason — no-hmr'],
    })
    expect(noticeView({ action: 'restore', result: { kind: 'host', ok: true, outcome: { ...outcome, restartReasons: [] } } }, tZh)).toEqual({
      tone: 'success', lines: ['插件管理器已保存宿主级压缩还原设置。重启 DSH 后生效。'],
    })
    const failed = { ...outcome, ok: false, application: 'failed' as const, restartReasons: [], message: 'read-only row /profile/engine' }
    expect(noticeView({ action: 'takeover', result: { kind: 'host', ok: false, outcome: failed } }, tEn)).toEqual({
      tone: 'error', lines: ['Taking over compaction failed (failed) — Plugin manager — read-only row /profile/engine'],
    })
  })

  it('words setting writes and transport failures', () => {
    expect(noticeView({ action: 'level', level: 4, result: { ok: true, via: 'settings' } }, tEn)).toEqual({ tone: 'success', lines: ['Compression level 4 is saved and already on duty.'] })
    expect(noticeView({ action: 'mode', mode: 'engine', result: { ok: true, via: 'config-editor' } }, tZh)).toEqual({ tone: 'success', lines: ['压缩模式已保存（引擎）。会话下次使用时会重新选择实际模式。'] })
    expect(noticeView({ action: 'mode', mode: 'engine', result: { ok: false, message: 'overridden by --patch' } }, tEn)).toEqual({ tone: 'error', lines: ['Saving the compaction mode failed — overridden by --patch'] })
    expect(noticeView({ action: 'takeover', failure: { code: 'remote-access/denied', message: 'access denied' } }, tEn))
      .toEqual({ tone: 'error', lines: ['Taking over compaction failed (remote-access/denied) — access denied'] })
  })
})
