import type { ConfigPatch, ConfigView, VolatileConfig } from '../client/contract.ts'
import { Config } from '../config.ts'
import { compileGlob, templateCaptures } from '../scope/index.ts'
import type { ConfigEditorLike } from '../engine/index.ts'
import type { SettingsLike } from './host.ts'
import { errorMessage } from './host.ts'

export type SettingWriteResult =
  | { readonly ok: true; readonly via: 'settings' | 'config-editor' }
  | { readonly ok: false; readonly message: string }

/** The part of a Cordis fiber's Loader entry that names its row. */
export interface LoaderEntryLike {
  readonly options?: { readonly id?: string }
}

/**
 * The row id `ctx.settings` and `ctx.configEditor` key this plugin by: the
 * entry's own `options.id`. `entry.id` is the nested tree path instead
 * (`include:<id>` for rows a bundle patch inserts) and matches no settings
 * namespace.
 */
export function rowIdOf(entry: LoaderEntryLike | undefined, fallback: string): string {
  const id = entry?.options?.id
  return typeof id === 'string' && id.length > 0 ? id : fallback
}

/** One field write: `value` replaces whatever the row holds at `path`. */
export interface ConfigEdit {
  readonly path: readonly string[]
  readonly value: unknown
}

/** Top-level fields to replace, or explicit path edits. */
export type ConfigWrite = Readonly<Record<string, unknown>> | readonly ConfigEdit[]

/** `ctx.settings.mutate()` (dsh-settings ≥ 0.2.2-rc.5): path edits that replace objects instead of deep-merging them. */
interface SettingsMutateLike {
  mutate(ns: string, ops: readonly { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }[]): Promise<void>
}

export interface ConfigWriterDeps {
  /** Loader row id of this plugin (the settings namespace). */
  readonly rowId: string
  readonly settings: () => SettingsLike | undefined
  readonly configEditor: () => ConfigEditorLike | undefined
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const isEditList = (write: ConfigWrite): write is readonly ConfigEdit[] => Array.isArray(write)

function editsOf(write: ConfigWrite): readonly ConfigEdit[] {
  return isEditList(write) ? write : Object.entries(write).map(([key, value]) => ({ path: [key], value }))
}

function setPath(target: Readonly<Record<string, unknown>>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path
  if (head === undefined) return { ...target }
  const child = target[head]
  return { ...target, [head]: rest.length === 0 ? value : setPath(isPlainObject(child) ? child : {}, rest, value) }
}

const applyEdits = (base: Readonly<Record<string, unknown>>, edits: readonly ConfigEdit[]): Record<string, unknown> =>
  edits.reduce<Record<string, unknown>>((config, edit) => setPath(config, edit.path, edit.value), { ...base })

function canMutate(settings: SettingsLike): settings is SettingsLike & SettingsMutateLike {
  return typeof (settings as Partial<SettingsMutateLike>).mutate === 'function'
}

/**
 * Persist volatile fields of this plugin's row: `ctx.settings` when the
 * settings service runs, else `ctx.configEditor.edit()` on our row. The Loader
 * then updates the live `Volatile` refs in place.
 *
 * Profile patches replace a row's whole `config`, so every path merges into
 * the row's current config. `settings.update()` deep-merges objects, which
 * cannot drop a key, so an edit whose value is an object (`overrides`) goes
 * through `settings.mutate()` when available.
 */
export function createConfigWriter(deps: ConfigWriterDeps): (write: ConfigWrite) => Promise<SettingWriteResult> {
  return async (write) => {
    const edits = editsOf(write)
    const settings = deps.settings()
    if (settings !== undefined) {
      try {
        if (canMutate(settings) && edits.some(edit => isPlainObject(edit.value))) {
          await settings.mutate(deps.rowId, edits.map(edit => ({ op: 'set' as const, path: edit.path, value: edit.value })))
        } else {
          await settings.update(deps.rowId, applyEdits({}, edits))
        }
        return { ok: true, via: 'settings' }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    }
    const editor = deps.configEditor()
    const entry = editor?.entries().find(candidate => candidate.options.id === deps.rowId)
    if (editor !== undefined && entry !== undefined) {
      try {
        await editor.edit(entry, current => applyEdits(current, edits))
        return { ok: true, via: 'config-editor' }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    }
    return { ok: false, message: `此配置行没有可用的设置服务或编辑器。请编辑当前 profile 的 cordis.patch.yml。 / No live settings writer for row "${deps.rowId}". Edit cordis.patch.yml in the current profile.` }
  }
}

/** Plain copies of every live field. */
export function readVolatileConfig(config: Config): VolatileConfig {
  return {
    level: config.level.get(),
    compactionMode: config.compactionMode.get(),
    idleMinutes: config.idleMinutes.get(),
    idleCompactRatio: config.idleCompactRatio.get(),
    halfLifeDays: config.halfLifeDays.get(),
    maxEpisodeTokens: config.maxEpisodeTokens.get(),
    captureReasoning: config.captureReasoning.get(),
    summarizer: {
      provider: config.summarizer.provider.get(),
      model: config.summarizer.model.get(),
      reasoningEffort: config.summarizer.reasoningEffort.get(),
    },
    overrides: { ...config.overrides.get() },
    scopeRules: config.scopeRules.get().map(rule => ({ match: rule.match, scope: rule.scope })),
    unmatchedSessions: config.unmatchedSessions.get(),
  }
}

/** `current` with `patch` applied: summarizer fields merge, every other field is replaced. */
export function mergeConfigPatch(current: VolatileConfig, patch: ConfigPatch): VolatileConfig {
  const { summarizer, ...rest } = patch
  return { ...current, ...rest, summarizer: { ...current.summarizer, ...summarizer } }
}

/** The row edits that persist `patch`: one per summarizer field, one per other field. */
export function configEdits(patch: ConfigPatch): ConfigEdit[] {
  return Object.entries(patch).flatMap(([key, value]): ConfigEdit[] => key === 'summarizer'
    ? Object.entries(value as object).map(([field, text]) => ({ path: ['summarizer', field], value: text }))
    : [{ path: [key], value }])
}

interface SchemaNode {
  readonly type: string
  readonly meta: { readonly volatile?: boolean }
  readonly dict?: Readonly<Record<string, SchemaNode>>
  readonly inner?: SchemaNode
}

function schemaProblem(value: unknown, node: SchemaNode, path: string, live: boolean): string | undefined {
  const volatile = live || node.meta.volatile === true
  if (node.type === 'object' && node.dict !== undefined && isPlainObject(value)) {
    for (const [key, field] of Object.entries(value)) {
      const child = Object.hasOwn(node.dict, key) ? node.dict[key] : undefined
      const childPath = path === '' ? key : `${path}.${key}`
      if (child === undefined) return `未识别此设置项，请核对字段名。 / unknown setting "${childPath}"`
      const problem = schemaProblem(field, child, childPath, volatile)
      if (problem !== undefined) return problem
    }
    return undefined
  }
  if (!volatile) return `此项设置在启动时读取。请编辑当前 profile 的 cordis.patch.yml，然后重启 DSH。 / "${path}" takes effect at startup. Edit cordis.patch.yml in the current profile and restart DSH.`
  if (node.type === 'array' && node.inner !== undefined && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const problem = schemaProblem(item, node.inner, `${path}[${index}]`, true)
      if (problem !== undefined) return problem
    }
  }
  return undefined
}

/**
 * Why `patch` cannot be applied to `current`, if it cannot: a field the Config
 * schema does not declare or does not mark volatile, a value the schema
 * rejects once merged, or a scope rule with an empty pattern or scope or a
 * scope that uses more `$n` captures than its pattern has wildcards.
 */
export function configPatchProblem(current: VolatileConfig, patch: ConfigPatch): string | undefined {
  const unknown = schemaProblem(patch, Config as unknown as SchemaNode, '', false)
  if (unknown !== undefined) return unknown
  const next = mergeConfigPatch(current, patch)
  try {
    Config(structuredClone(next) as Parameters<typeof Config>[0])
  } catch (error) {
    return errorMessage(error)
  }
  for (const [index, rule] of next.scopeRules.entries()) {
    if (rule.match.trim().length === 0) return `请填写作用域规则的匹配式。 / scopeRules[${index}].match must not be empty`
    if (rule.scope.trim().length === 0) return `请填写匹配后的作用域。 / scopeRules[${index}].scope must not be empty`
    const needed = templateCaptures(rule.scope)
    const wildcards = compileGlob(rule.match).wildcards
    if (needed > wildcards) return `作用域模板引用了匹配式中不存在的捕获组。 / scopeRules[${index}].scope uses $${needed}. Wildcards in the pattern: ${wildcards}.`
  }
  return undefined
}

export interface ConfigAccessDeps {
  readonly config: Config
  readonly write: (write: ConfigWrite) => Promise<SettingWriteResult>
  /** Called after a successful write, e.g. to drop cached mode decisions. */
  readonly changed: () => void
}

/** The live settings behind the `getConfig`/`setConfig` endpoints. */
export interface ConfigAccess {
  get(): ConfigView
  set(patch: ConfigPatch): Promise<SettingWriteResult>
}

export function createConfigAccess(deps: ConfigAccessDeps): ConfigAccess {
  const defaults = readVolatileConfig(Config({}))
  return {
    get: () => ({ config: readVolatileConfig(deps.config), defaults }),
    async set(patch) {
      try {
        const problem = configPatchProblem(readVolatileConfig(deps.config), patch)
        if (problem !== undefined) return { ok: false, message: problem }
        const result = await deps.write(configEdits(patch))
        if (result.ok) deps.changed()
        return result
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },
  }
}
