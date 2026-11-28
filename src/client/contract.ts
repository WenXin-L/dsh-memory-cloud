/**
 * Wire contract of the `memoryCloud` Remote namespace, shared by the host
 * binding (`src/runtime/remote.ts`) and the browser contribution. Pure: no
 * runtime imports, so it bundles into both halves.
 */
import type { CompactionMode, CompressionLevel, ScopeRule } from '../contracts.ts'
import { COMPACTION_MODES, COMPRESSION_LEVELS } from '../contracts.ts'
import { isUnmatchedSessions, UNMATCHED_SESSIONS } from '../scope/guard.ts'
import type { UnmatchedSessions } from '../scope/guard.ts'
import type { SettingWriteResult } from '../runtime/settings.ts'
import type { MemoryCloudApi } from '../runtime/status.ts'

export const PACKAGE_NAME = 'dsh-memory-cloud-brain'
export const REMOTE_NAMESPACE = 'memoryCloud'
/** Host Cordis service key of the Remote binding; distinct from the `memoryCloud` service itself. */
export const REMOTE_SERVICE = 'memoryCloudRemote'

export const SUMMARIZER_FIELDS = ['provider', 'model', 'reasoningEffort'] as const
export type SummarizerField = (typeof SUMMARIZER_FIELDS)[number]

export const NUMBER_FIELDS = ['idleMinutes', 'idleCompactRatio', 'halfLifeDays', 'maxEpisodeTokens'] as const
export type NumberField = (typeof NUMBER_FIELDS)[number]

/** `overrides.*` of the Config schema (`LevelOverrides`). */
export const OVERRIDE_FIELDS = [
  'workingMemoryTokens',
  'retainTokens',
  'memoryBudgetTokens',
  'recentSummaryCount',
  'recentSummaryTokens',
  'gistTokens',
  'recallLimitTokens',
] as const
export type OverrideField = (typeof OVERRIDE_FIELDS)[number]

/** Every live (`.volatile()`) field of the plugin Config, as plain values. */
export interface VolatileConfig {
  readonly level: CompressionLevel
  readonly compactionMode: CompactionMode
  readonly timeAwareness: boolean
  readonly idleMinutes: number
  readonly idleCompactRatio: number
  readonly halfLifeDays: number
  readonly maxEpisodeTokens: number
  readonly captureReasoning: boolean
  readonly summarizer: Readonly<Record<SummarizerField, string>>
  readonly overrides: Readonly<Partial<Record<OverrideField, number>>>
  readonly scopeRules: readonly ScopeRule[]
  readonly unmatchedSessions: UnmatchedSessions
}

/**
 * A `setConfig` change. `summarizer` lists only the fields to change;
 * `overrides` and `scopeRules` are complete replacements (an override left out
 * falls back to the level default).
 */
export type ConfigPatch = {
  readonly [K in Exclude<keyof VolatileConfig, 'summarizer'>]?: VolatileConfig[K]
} & {
  readonly summarizer?: Readonly<Partial<Record<SummarizerField, string>>>
}

/** `getConfig()`: live values and the schema defaults. */
export interface ConfigView {
  readonly config: VolatileConfig
  readonly defaults: VolatileConfig
}

/** Live-settings endpoints served next to {@link MemoryCloudApi}. */
export interface MemoryCloudConfigApi {
  getConfig(): ConfigView
  setConfig(patch: ConfigPatch): Promise<SettingWriteResult>
}

/** Wire parameters of every endpoint, in host signature order. */
export const REMOTE_METHODS = {
  status: ['sessionId'],
  setLevel: ['level'],
  setMode: ['mode'],
  takeover: ['presetId'],
  restore: ['presetId'],
  getConfig: [],
  setConfig: ['patch'],
} as const satisfies Readonly<Record<keyof MemoryCloudApi | keyof MemoryCloudConfigApi, readonly string[]>>

export type RemoteMethod = keyof typeof REMOTE_METHODS
export type RemoteParameter = (typeof REMOTE_METHODS)[RemoteMethod][number]

export function parseLevel(value: unknown): CompressionLevel {
  if (typeof value === 'number' && (COMPRESSION_LEVELS as readonly number[]).includes(value)) return value as CompressionLevel
  throw new TypeError(`请选择一个有效的压缩档位。 / level must be one of ${COMPRESSION_LEVELS.join(', ')}`)
}

export function parseMode(value: unknown): CompactionMode {
  if (typeof value === 'string' && (COMPACTION_MODES as readonly string[]).includes(value)) return value as CompactionMode
  throw new TypeError(`请选择一个有效的压缩模式。 / mode must be one of ${COMPACTION_MODES.join(', ')}`)
}

/** An optional identifier (session or preset id): absent, or a non-empty string. */
export function parseOptionalId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.trim().length > 0) return value
  throw new TypeError('会话或预设 ID 需要填写非空字符串。 / identifier must be a non-empty string')
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function checkRecord(value: unknown, path: string, keys: readonly string[], check: (field: unknown, path: string) => void): void {
  if (!isRecord(value)) throw new TypeError(`此字段需要填写一个对象。 / ${path} must be an object`)
  for (const [key, field] of Object.entries(value)) {
    if (!keys.includes(key)) throw new TypeError(`未识别此设置项，请核对字段名。 / unknown setting "${path}.${key}"`)
    check(field, `${path}.${key}`)
  }
}

function checkString(value: unknown, path: string): void {
  if (typeof value !== 'string') throw new TypeError(`此字段需要填写字符串。 / ${path} must be a string`)
}

function checkNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`此字段需要填写有限数值。 / ${path} must be a finite number`)
}

/**
 * Shape check of a `setConfig` patch: a non-empty object of known live fields
 * with the right JSON types. Ranges are left to the host, which validates the
 * merged result against the Config schema.
 */
export function parseConfigPatch(value: unknown): ConfigPatch {
  if (!isRecord(value)) throw new TypeError('要保存设置，请传入一个对象。 / settings patch must be an object')
  const entries = Object.entries(value)
  if (entries.length === 0) throw new TypeError('请至少填写一项要保存的设置。 / settings patch changes nothing')
  for (const [key, field] of entries) {
    switch (key) {
      case 'level':
        parseLevel(field)
        break
      case 'compactionMode':
        parseMode(field)
        break
      case 'timeAwareness':
        if (typeof field !== 'boolean') throw new TypeError('时间感知需要填写 true 或 false。 / timeAwareness must be a boolean')
        break
      case 'idleMinutes':
      case 'idleCompactRatio':
      case 'halfLifeDays':
      case 'maxEpisodeTokens':
        checkNumber(field, key)
        break
      case 'captureReasoning':
        if (typeof field !== 'boolean') throw new TypeError('是否记录推理内容需要填写 true 或 false。 / captureReasoning must be a boolean')
        break
      case 'summarizer':
        checkRecord(field, key, SUMMARIZER_FIELDS, checkString)
        break
      case 'overrides':
        checkRecord(field, key, OVERRIDE_FIELDS, checkNumber)
        break
      case 'unmatchedSessions':
        if (!isUnmatchedSessions(field)) throw new TypeError(`请选择未匹配会话的处理方式。 / unmatchedSessions must be one of ${UNMATCHED_SESSIONS.join(', ')}`)
        break
      case 'scopeRules':
        if (!Array.isArray(field)) throw new TypeError('作用域规则需要按顺序放在一个数组里。 / scopeRules must be an array')
        field.forEach((rule: unknown, index) => {
          const path = `scopeRules[${index}]`
          checkRecord(rule, path, ['match', 'scope'], checkString)
          for (const required of ['match', 'scope']) {
            if (!Object.hasOwn(rule as object, required)) throw new TypeError(`请补全这条作用域规则的必填字段。 / ${path}.${required} is required`)
          }
        })
        break
      default:
        throw new TypeError(`未识别此设置项，请核对字段名。 / unknown setting "${key}"`)
    }
  }
  return value as ConfigPatch
}

const PATCH_JSON_SCHEMA = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    level: { type: 'integer', enum: [...COMPRESSION_LEVELS] },
    compactionMode: { type: 'string', enum: [...COMPACTION_MODES] },
    timeAwareness: { type: 'boolean' },
    ...Object.fromEntries(NUMBER_FIELDS.map(field => [field, { type: 'number' }])),
    captureReasoning: { type: 'boolean' },
    summarizer: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(SUMMARIZER_FIELDS.map(field => [field, { type: 'string' }])),
    },
    overrides: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(OVERRIDE_FIELDS.map(field => [field, { type: 'number' }])),
    },
    scopeRules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['match', 'scope'],
        properties: { match: { type: 'string' }, scope: { type: 'string' } },
      },
    },
    unmatchedSessions: { type: 'string', enum: [...UNMATCHED_SESSIONS] },
  },
}

interface ParameterSpec {
  readonly typeSymbol: string
  readonly parse: (value: unknown) => unknown
  readonly jsonSchema: Readonly<Record<string, unknown>>
  readonly optional: boolean
  readonly description: string
}

const PARAMETERS: Readonly<Record<RemoteParameter, ParameterSpec>> = {
  sessionId: {
    typeSymbol: `${PACKAGE_NAME}#SessionId`,
    parse: parseOptionalId,
    jsonSchema: { type: 'string', minLength: 1 },
    optional: true,
    description: '要查看的活跃会话。省略 ID 时取最近活跃的非子代理会话。 / Live session to describe. Omit the ID to use the most recently active session.',
  },
  level: {
    typeSymbol: `${PACKAGE_NAME}#CompressionLevel`,
    parse: parseLevel,
    jsonSchema: { type: 'integer', enum: [...COMPRESSION_LEVELS] },
    optional: false,
    description: '要保存的压缩档位。保存后立即生效，1 档保留最多上下文，5 档保留最少。 / Compression level to save. Level 1 keeps the most context and level 5 the least. A saved level applies immediately.',
  },
  mode: {
    typeSymbol: `${PACKAGE_NAME}#CompactionMode`,
    parse: parseMode,
    jsonSchema: { type: 'string', enum: [...COMPACTION_MODES] },
    optional: false,
    description: '要保存的压缩模式。会话在下次使用时重新判断。 / Compaction mode to save. Each session checks it on its next use.',
  },
  presetId: {
    typeSymbol: `${PACKAGE_NAME}#PresetId`,
    parse: parseOptionalId,
    jsonSchema: { type: 'string', minLength: 1 },
    optional: true,
    description: '预设 ID。省略时使用 standard，修改对新会话生效。 / Agent preset ID. Omit it to use standard. Changes to a preset apply to new sessions.',
  },
  patch: {
    typeSymbol: `${PACKAGE_NAME}#ConfigPatch`,
    parse: parseConfigPatch,
    jsonSchema: PATCH_JSON_SCHEMA,
    optional: false,
    description: '要为当前 profile 保存的热更新设置。传入 overrides 或 scopeRules 会替换该字段的全部内容。 / Live settings to save to this profile. Supplying overrides or scopeRules replaces that field in full.',
  },
}

/** The subset of DSH's `InvocationDescriptor` (`@deepseek-ai/dsh-typert-protocol`) this contribution fills. */
export interface RemoteDescriptor {
  readonly id: string
  readonly service: string
  readonly namespace: string
  readonly method: string
  readonly invocation: { readonly kind: 'direct' }
  readonly parameters: readonly {
    readonly name: string
    readonly description: string
    readonly wire: string
    readonly source: 'json'
    readonly codec: {
      readonly mode: 'strict'
      readonly typeSymbol: string
      readonly create: () => { parse(value: unknown): unknown }
      readonly jsonSchema: Readonly<Record<string, unknown>>
    }
    readonly acceptsUndefined?: true
  }[]
  readonly cancellation: { readonly parameter: 'signal' }
  readonly result: { readonly mode: 'src-json' }
}

/** DSH's `TypertRemoteContribution` shape, mounted with `ctx.remote.$mount()`. */
export interface RemoteContribution {
  readonly package: string
  readonly descriptors: readonly RemoteDescriptor[]
}

/**
 * The browser contribution. Client-supplied fields carry strict codecs (the
 * Client Gateway refuses others); results stay `src-json` because the host
 * method is discovered in SRC mode and returns plain JSON.
 */
export function memoryCloudContribution(): RemoteContribution {
  return {
    package: PACKAGE_NAME,
    descriptors: (Object.keys(REMOTE_METHODS) as RemoteMethod[]).map(method => ({
      id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
      service: REMOTE_SERVICE,
      namespace: REMOTE_NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      parameters: REMOTE_METHODS[method].map((name) => {
        const spec = PARAMETERS[name]
        return {
          name,
          description: spec.description,
          wire: name,
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: spec.typeSymbol,
            create: () => ({ parse: spec.parse }),
            jsonSchema: spec.jsonSchema,
          },
          ...spec.optional ? { acceptsUndefined: true } : {},
        }
      }),
      cancellation: { parameter: 'signal' },
      result: { mode: 'src-json' },
    })),
  }
}
