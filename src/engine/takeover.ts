/**
 * One-click takeover of an agent preset's isolated `compaction` group through
 * `ctx.configEditor`. The profile patch gets a copy of the
 * preset row with our engine first and `compaction-basic` disabled. The
 * transforms are pure; the controller adds hashing so the override follows
 * DSH upgrades while it is still an untouched takeover.
 */
import { createHash } from 'node:crypto'
import type { Millis } from '../contracts.ts'
import { ENGINE_ROW } from './host.ts'

export const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'
export const COMPACTION_BASIC_ROW = { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' } as const
export const DEFAULT_PRESET_ID = 'standard'

type Row = Record<string, unknown>
type CompactionGroup = Row & { readonly config: readonly unknown[] }

/** Whether the preset config has an isolated compaction group the engine can be mounted in. */
export function hasCompactionGroup(config: unknown): boolean {
  return pluginsOf(config)?.some(isCompactionGroup) ?? false
}

/** Whether some compaction group of the preset mounts our engine row enabled. */
export function isTakenOver(config: unknown): boolean {
  return pluginsOf(config)?.some(row => isCompactionGroup(row) && row.config.some(child => isEngineRow(child) && child['disabled'] !== true)) ?? false
}

/**
 * Put our engine first in every compaction group and disable
 * `compaction-basic`, keeping every other row (and user edits) as is.
 * An existing engine row keeps its config. Configs without plugins are returned unchanged.
 */
export function takeOverPreset<T extends Record<string, unknown>>(config: T): T {
  const plugins = pluginsOf(config)
  if (plugins === undefined) return config
  return {
    ...config,
    plugins: plugins.map((row) => {
      if (!isCompactionGroup(row)) return row
      const existing = row.config.find(isEngineRow)
      const engine = existing === undefined ? { id: ENGINE_ROW.id, name: ENGINE_ROW.name } : enabled(existing)
      return {
        ...row,
        config: [engine, ...row.config.filter(child => !isEngineRow(child)).map(child => isBasicRow(child) ? { ...child, disabled: true } : child)],
      }
    }),
  }
}

/** Inverse of {@link takeOverPreset}: drop our engine row and re-enable `compaction-basic`. */
export function releasePreset<T extends Record<string, unknown>>(config: T): T {
  const plugins = pluginsOf(config)
  if (plugins === undefined) return config
  return {
    ...config,
    plugins: plugins.map((row) => {
      if (!isCompactionGroup(row)) return row
      return {
        ...row,
        config: row.config.filter(child => !isEngineRow(child)).map(child => isBasicRow(child) && child['disabled'] === true ? enabled(child) : child),
      }
    }),
  }
}

/** Order-insensitive SHA-256 of a raw config; keys holding `undefined` are ignored. */
export function configHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function sameConfig(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** The subset of a Loader `Entry` the controller reads. */
export interface ConfigEditorEntryLike {
  readonly options: { readonly id: string; readonly name: string; readonly config?: unknown }
}

/** The subset of `@deepseek-ai/dsh-config-editor`'s `ConfigEditor` the controller uses. */
export interface ConfigEditorLike {
  entries(): readonly ConfigEditorEntryLike[]
  configuration(): readonly { readonly entry: ConfigEditorEntryLike; readonly inherited: Record<string, unknown>; readonly override: Record<string, unknown> }[]
  edit(entry: ConfigEditorEntryLike, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

/** What was taken over, so a later start can tell an untouched takeover from a customized preset. */
export interface TakeoverRecord {
  readonly entryId: string
  readonly presetId: string
  /** {@link configHash} of the inherited (shipped) preset config at takeover time. */
  readonly inheritedHash: string
  /** {@link configHash} of `takeOverPreset(inherited)` at takeover time. */
  readonly takeoverHash: string
  readonly at: Millis
}

/** Records keyed by preset entry id. Persist them per DSH profile: each profile has its own patch. */
export type TakeoverRecords = Readonly<Record<string, TakeoverRecord>>

export interface TakeoverStateStore {
  get(): TakeoverRecords | undefined | Promise<TakeoverRecords | undefined>
  set(records: TakeoverRecords): void | Promise<void>
}

export interface TakeoverControllerOptions {
  /** The service itself or a lazy getter (`() => ctx.get('configEditor')`); absent outside `dsh --profile` launches. */
  readonly configEditor: ConfigEditorLike | undefined | (() => ConfigEditorLike | undefined)
  readonly state: TakeoverStateStore
  readonly now?: () => Millis
}

/**
 * - `available`: compaction group present, engine not mounted.
 * - `active`: the override is exactly the takeover of the shipped preset.
 * - `outdated`: an untouched takeover of an older shipped preset, or one written by an older version of
 *   this plugin; `refreshAfterUpgrade()` re-applies it.
 * - `customized`: taken over but edited since, so it no longer follows DSH upgrades.
 * - `unsupported`: no compaction group to take over.
 */
export type PresetTakeoverState = 'available' | 'active' | 'outdated' | 'customized' | 'unsupported'

export interface PresetTakeoverStatus {
  readonly entryId: string
  readonly presetId: string
  readonly state: PresetTakeoverState
  readonly recorded: boolean
  readonly detail?: string
}

export interface TakeoverStatus {
  /** False when no config editor is available (no profile context). */
  readonly editable: boolean
  readonly presets: readonly PresetTakeoverStatus[]
  readonly error?: string
}

export type TakeoverErrorCode = 'no-config-editor' | 'preset-not-found' | 'no-compaction-group' | 'overridden' | 'edit-failed'

export type TakeoverOutcome =
  | { readonly ok: true; readonly action: 'applied' | 'unchanged' | 'restored'; readonly preset?: PresetTakeoverStatus; readonly warning?: string }
  | { readonly ok: false; readonly code: TakeoverErrorCode; readonly message: string; readonly error?: unknown }

export interface RefreshOutcome {
  readonly entryId: string
  readonly presetId?: string
  /** `released`: the takeover was removed outside this controller; `missing`: a recorded preset is not in this profile. */
  readonly action: 'unchanged' | 'reapplied' | 'released' | 'customized' | 'missing' | 'failed'
  readonly code?: TakeoverErrorCode
  readonly detail?: string
}

export interface TakeoverController {
  status(): Promise<TakeoverStatus>
  takeOver(presetId?: string): Promise<TakeoverOutcome>
  restore(presetId?: string): Promise<TakeoverOutcome>
  /** Re-apply untouched takeovers whose shipped preset or takeover transform changed; safe to run detached at startup (never rejects). */
  refreshAfterUpgrade(): Promise<readonly RefreshOutcome[]>
}

const OVERRIDDEN_PATTERN = /overridden by a home patch or command-line overlay/i
const NO_CONFIG_EDITOR = '编辑预设需要配置编辑器。请用 `dsh --profile` 启动。 / Start DSH with `dsh --profile` to edit presets.'
const SHIPPED_GROUP_MISSING = '新版 DSH 预设已移除压缩组。 / The shipped preset no longer has a compaction group.'

class TakeoverFailure extends Error {
  constructor(readonly code: TakeoverErrorCode, message: string) {
    super(message)
  }
}

interface PresetRow {
  readonly entry: ConfigEditorEntryLike
  readonly entryId: string
  readonly presetId: string
  readonly current: Record<string, unknown>
}

export function createTakeoverController(options: TakeoverControllerOptions): TakeoverController {
  const now = options.now ?? Date.now
  const editorOf = (): ConfigEditorLike | undefined => {
    try {
      return typeof options.configEditor === 'function' ? options.configEditor() : options.configEditor
    } catch {
      return undefined
    }
  }

  const readRecords = async (): Promise<TakeoverRecords> => {
    try {
      return (await options.state.get()) ?? {}
    } catch {
      return {}
    }
  }

  const writeRecords = async (records: TakeoverRecords): Promise<string | undefined> => {
    try {
      await options.state.set(records)
      return undefined
    } catch (error: unknown) {
      return `接管记录保存失败，升级时的自动刷新可能受影响。 / Could not save the takeover records used for automatic refresh after DSH upgrades. ${errorMessage(error)}`
    }
  }

  const recordFor = (row: Pick<PresetRow, 'entryId' | 'presetId'>, inherited: Record<string, unknown>): TakeoverRecord => ({
    entryId: row.entryId,
    presetId: row.presetId,
    inheritedHash: configHash(inherited),
    takeoverHash: configHash(takeOverPreset(inherited)),
    at: now(),
  })

  const describe = (editor: ConfigEditorLike, presetId: string, records: TakeoverRecords): PresetTakeoverStatus | undefined => {
    try {
      const rows = editor.configuration()
      for (const { entry, inherited } of rows) {
        const row = presetRow(entry)
        if (row?.presetId === presetId) return statusOf(row, inherited, records[row.entryId])
      }
    } catch {}
    return undefined
  }

  return {
    async status() {
      const editor = editorOf()
      if (editor === undefined) return { editable: false, presets: [] }
      const records = await readRecords()
      try {
        const presets: PresetTakeoverStatus[] = []
        for (const { entry, inherited } of editor.configuration()) {
          const row = presetRow(entry)
          if (row !== undefined) presets.push(statusOf(row, inherited, records[row.entryId]))
        }
        return { editable: true, presets }
      } catch (error: unknown) {
        return { editable: true, presets: [], error: errorMessage(error) }
      }
    },

    async takeOver(presetId = DEFAULT_PRESET_ID) {
      const editor = editorOf()
      if (editor === undefined) return failure('no-config-editor', NO_CONFIG_EDITOR)
      try {
        const row = findPreset(editor, presetId)
        if (!hasCompactionGroup(row.current)) throw new TakeoverFailure('no-compaction-group', `此预设没有可接管的压缩组。 / No compaction group in preset "${presetId}".`)
        const records = await readRecords()
        const known = records[row.entryId]
        const inherited = inheritedOf(editor, row.entry)
        if (inherited !== undefined && isTakenOver(row.current) && sameConfig(row.current, takeOverPreset(inherited))) {
          const fresh = recordFor(row, inherited)
          const warning = known?.takeoverHash === fresh.takeoverHash && known.inheritedHash === fresh.inheritedHash
            ? undefined
            : await writeRecords({ ...records, [row.entryId]: fresh })
          return succeed('unchanged', describe(editor, presetId, { ...records, [row.entryId]: fresh }), warning)
        }
        const captured: { inherited?: Record<string, unknown> } = {}
        await editor.edit(row.entry, (current, inheritedNow) => {
          captured.inherited = inheritedNow
          if (known !== undefined && configHash(current) === known.takeoverHash && hasCompactionGroup(inheritedNow)) return takeOverPreset(inheritedNow)
          if (!hasCompactionGroup(current)) throw new TakeoverFailure('no-compaction-group', `此预设没有可接管的压缩组。 / No compaction group in preset "${presetId}".`)
          return takeOverPreset(current)
        })
        const next = captured.inherited === undefined ? records : { ...records, [row.entryId]: recordFor(row, captured.inherited) }
        const warning = captured.inherited === undefined ? undefined : await writeRecords(next)
        return succeed('applied', describe(editor, presetId, next), warning)
      } catch (error: unknown) {
        return editFailure(error)
      }
    },

    async restore(presetId = DEFAULT_PRESET_ID) {
      const editor = editorOf()
      if (editor === undefined) return failure('no-config-editor', NO_CONFIG_EDITOR)
      try {
        const row = findPreset(editor, presetId)
        const records = await readRecords()
        const record = records[row.entryId]
        const remaining: Record<string, TakeoverRecord> = { ...records }
        delete remaining[row.entryId]
        if (!isTakenOver(row.current)) {
          const warning = record === undefined ? undefined : await writeRecords(remaining)
          return succeed('unchanged', describe(editor, presetId, remaining), warning)
        }
        const edited = { kept: false }
        await editor.edit(row.entry, (current, inherited) => {
          if (hasCompactionGroup(inherited) && sameConfig(current, takeOverPreset(inherited))) return inherited
          if (record !== undefined && configHash(current) === record.takeoverHash) return inherited
          edited.kept = true
          return releasePreset(current)
        })
        const saveWarning = record === undefined ? undefined : await writeRecords(remaining)
        const keptWarning = edited.kept ? '已撤销接管。预设中其余的自定义项仍会覆盖内置设置。 / Takeover removed. Any other preset edits still override the shipped settings.' : undefined
        const warning = [keptWarning, saveWarning].filter(text => text !== undefined).join(' ')
        return succeed('restored', describe(editor, presetId, remaining), warning.length > 0 ? warning : undefined)
      } catch (error: unknown) {
        return editFailure(error)
      }
    },

    async refreshAfterUpgrade() {
      try {
        const editor = editorOf()
        if (editor === undefined) return []
        const records = await readRecords()
        const next: Record<string, TakeoverRecord> = { ...records }
        let dirty = false
        const outcomes: RefreshOutcome[] = []
        const seen = new Set<string>()
        for (const { entry, inherited } of editor.configuration()) {
          const row = presetRow(entry)
          if (row === undefined) continue
          seen.add(row.entryId)
          const record = records[row.entryId]
          const base = { entryId: row.entryId, presetId: row.presetId }
          if (!isTakenOver(row.current)) {
            if (record !== undefined) {
              delete next[row.entryId]
              dirty = true
              outcomes.push({ ...base, action: 'released' })
            }
            continue
          }
          if (hasCompactionGroup(inherited) && sameConfig(row.current, takeOverPreset(inherited))) {
            const fresh = recordFor(row, inherited)
            if (record?.inheritedHash !== fresh.inheritedHash || record.takeoverHash !== fresh.takeoverHash) {
              next[row.entryId] = fresh
              dirty = true
            }
            outcomes.push({ ...base, action: 'unchanged' })
            continue
          }
          if (record === undefined || configHash(row.current) !== record.takeoverHash) {
            outcomes.push({ ...base, action: 'customized', detail: '已跳过自动刷新，以保留自定义设置。要跟随 DSH 升级，请从内置预设的原始配置重新接管。 / Auto-refresh skipped this customized preset. To follow DSH upgrades, take over the unmodified shipped preset.' })
            continue
          }
          if (!hasCompactionGroup(inherited)) {
            outcomes.push({ ...base, action: 'failed', code: 'no-compaction-group', detail: SHIPPED_GROUP_MISSING })
            continue
          }
          try {
            const captured: { inherited?: Record<string, unknown> } = {}
            await editor.edit(row.entry, (current, inheritedNow) => {
              if (configHash(current) !== record.takeoverHash) throw new TakeoverFailure('edit-failed', '刷新接管设置时预设已更改，本次刷新已停止。 / The preset changed during the refresh. The refresh stopped.')
              if (!hasCompactionGroup(inheritedNow)) throw new TakeoverFailure('no-compaction-group', SHIPPED_GROUP_MISSING)
              captured.inherited = inheritedNow
              return takeOverPreset(inheritedNow)
            })
            if (captured.inherited !== undefined) {
              next[row.entryId] = recordFor(row, captured.inherited)
              dirty = true
            }
            outcomes.push({ ...base, action: 'reapplied' })
          } catch (error: unknown) {
            const failed = editFailure(error)
            outcomes.push({ ...base, action: 'failed', ...failed.ok ? {} : { code: failed.code, detail: failed.message } })
          }
        }
        for (const [entryId, record] of Object.entries(records)) {
          if (!seen.has(entryId)) outcomes.push({ entryId, presetId: record.presetId, action: 'missing' })
        }
        if (dirty) {
          const warning = await writeRecords(next)
          if (warning !== undefined) outcomes.push({ entryId: '*', action: 'failed', code: 'edit-failed', detail: warning })
        }
        return outcomes
      } catch (error: unknown) {
        return [{ entryId: '*', action: 'failed', code: 'edit-failed', detail: errorMessage(error) }]
      }
    },
  }
}

function statusOf(row: PresetRow, inherited: Record<string, unknown>, record: TakeoverRecord | undefined): PresetTakeoverStatus {
  const base = { entryId: row.entryId, presetId: row.presetId, recorded: record !== undefined }
  if (!isTakenOver(row.current)) {
    return hasCompactionGroup(row.current)
      ? { ...base, state: 'available' }
      : { ...base, state: 'unsupported', detail: '预设没有压缩组 / No compaction group in this preset.' }
  }
  if (hasCompactionGroup(inherited) && sameConfig(row.current, takeOverPreset(inherited))) return { ...base, state: 'active' }
  if (record !== undefined && configHash(row.current) === record.takeoverHash) {
    const detail = configHash(inherited) === record.inheritedHash
      ? '记忆云的接管方式已更新，这份预设还用着旧版接管设置。 / Memory Cloud updated how it takes over presets. This preset still uses the earlier settings.'
      : 'DSH 已更新内置预设，当前接管设置仍基于上一版。 / DSH updated the shipped preset. The takeover still uses the earlier version.'
    return { ...base, state: 'outdated', detail }
  }
  return { ...base, state: 'customized', detail: '已保留自定义设置，此预设不再自动跟随 DSH 升级。 / This preset keeps its custom settings and no longer follows DSH upgrades automatically.' }
}

function presetRow(entry: ConfigEditorEntryLike): PresetRow | undefined {
  const config = entry.options.config
  if (entry.options.name !== PRESET_MODULE || !isRecord(config) || typeof config['id'] !== 'string' || !Array.isArray(config['plugins'])) return undefined
  return { entry, entryId: entry.options.id, presetId: config['id'], current: config }
}

function findPreset(editor: ConfigEditorLike, presetId: string): PresetRow {
  for (const entry of editor.entries()) {
    const row = presetRow(entry)
    if (row?.presetId === presetId) return row
  }
  throw new TakeoverFailure('preset-not-found', `当前配置没有这个代理预设。 / Preset "${presetId}" was not found in this profile.`)
}

function inheritedOf(editor: ConfigEditorLike, entry: ConfigEditorEntryLike): Record<string, unknown> | undefined {
  const rows = editor.configuration()
  return (rows.find(row => row.entry === entry) ?? rows.find(row => row.entry.options.id === entry.options.id))?.inherited
}

function succeed(action: 'applied' | 'unchanged' | 'restored', preset: PresetTakeoverStatus | undefined, warning: string | undefined): TakeoverOutcome {
  return { ok: true, action, ...preset === undefined ? {} : { preset }, ...warning === undefined ? {} : { warning } }
}

function failure(code: TakeoverErrorCode, message: string, error?: unknown): TakeoverOutcome {
  return { ok: false, code, message, ...error === undefined ? {} : { error } }
}

function editFailure(error: unknown): TakeoverOutcome {
  if (error instanceof TakeoverFailure) return failure(error.code, error.message)
  const message = errorMessage(error)
  if (OVERRIDDEN_PATTERN.test(message)) {
    return failure('overridden', `上层补丁覆盖了这个预设。请先移除相应的预设覆盖项。 / Remove the preset override from $DSH_HOME/cordis.patch.yml or the --patch overlay first. ${message}`, error)
  }
  return failure('edit-failed', message, error)
}

function pluginsOf(config: unknown): readonly unknown[] | undefined {
  if (!isRecord(config)) return undefined
  const plugins = config['plugins']
  return Array.isArray(plugins) ? plugins : undefined
}

function isCompactionGroup(row: unknown): row is CompactionGroup {
  if (!isRecord(row) || row['group'] !== true || !Array.isArray(row['config'])) return false
  const isolate = row['isolate']
  return row['id'] === 'compaction' || (isRecord(isolate) && isolate['compaction'] === true)
}

function isEngineRow(row: unknown): row is Row {
  return isRecord(row) && row['id'] === ENGINE_ROW.id
}

function isBasicRow(row: unknown): row is Row {
  return isRecord(row) && (row['id'] === COMPACTION_BASIC_ROW.id || row['name'] === COMPACTION_BASIC_ROW.name)
}

function enabled(row: Row): Row {
  const { disabled: _disabled, ...rest } = row
  return rest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : stableJson(item)).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
