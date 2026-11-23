import { TOOL_NAMES } from '../contracts.ts'
import { compileGlob } from './glob.ts'

export type CoexistenceKind = 'memory' | 'compaction' | 'bridge'

/**
 * One known third-party plugin. A Loader row matches when its module
 * specifier resolves to one of `packages` (compared without npm scope) and its
 * subpath matches `subpaths` (any subpath when omitted) but none of
 * `excludeSubpaths`. Subpath globs use the {@link compileGlob} dialect and are
 * tested against the subpath with and without its file extension.
 */
export interface KnownPlugin {
  readonly id: string
  readonly kind: CoexistenceKind
  readonly packages: readonly string[]
  readonly subpaths?: readonly string[]
  readonly excludeSubpaths?: readonly string[]
  /** Tool names the plugin is known to register; DSH rejects a second registration of the same name. */
  readonly tools?: readonly string[]
  /** Where the classification comes from. */
  readonly reference: string
}

const DSH_WORLD_COMPACTION = ['compaction', 'compaction/*', '*/compaction', '*/compaction/*']

export const KNOWN_PLUGINS: readonly KnownPlugin[] = [
  { id: 'dsh-dafeiyu-life', kind: 'memory', packages: ['dsh-dafeiyu-life'], reference: 'design §2, 大肥鱼 ecosystem' },
  { id: 'dsh-pbyugujia', kind: 'memory', packages: ['dsh-pbyugujia'], reference: 'design §2, 大肥鱼 ecosystem' },
  { id: 'dsh-engramory', kind: 'memory', packages: ['dsh-engramory'], reference: 'tinqiao-oss/engramory README (npm dsh-engramory)' },
  { id: 'dsh-auto-memory', kind: 'memory', packages: ['dsh-auto-memory'], reference: 'design §2, Aik358/dsh-auto-memory' },
  { id: 'dsh-memory', kind: 'memory', packages: ['dsh-memory'], tools: ['memory_search', 'memory_read'], reference: 'design §2, yan5236/dsh-memory' },
  { id: 'dsh-codex-memories', kind: 'memory', packages: ['dsh-codex-memories'], tools: ['memory_search', 'memory_read'], reference: 'design §2, Lushdawn/dsh-codex-memories' },
  { id: 'dsh-qq-bridge', kind: 'memory', packages: ['dsh-qq-bridge'], reference: 'design §2, 大肥鱼 ecosystem (qq-bridge memory; row layout unverified)' },
  { id: 'dsh-world', kind: 'memory', packages: ['dsh-world'], excludeSubpaths: DSH_WORLD_COMPACTION, tools: ['memory_find', 'memory_read', 'memory_image'], reference: 'chenkezhen480/dsh-world README' },
  { id: 'dsh-taskfold', kind: 'compaction', packages: ['dsh-taskfold', 'dsh-taskfold-client'], reference: 'yindf/taskfold README (rows dsh-taskfold/plugins, dsh-taskfold-client)' },
  { id: 'dsh-ebbing-context', kind: 'compaction', packages: ['dsh-ebbing-context'], reference: 'design §2, Light-EI/dsh-ebbing-context' },
  { id: 'dsh-ctxopt-compaction', kind: 'compaction', packages: ['dsh-ctxopt-compaction'], reference: 'design §2, chunsi-w/dsh-ctxopt-compaction' },
  { id: 'dsh-context-maid', kind: 'compaction', packages: ['dsh-context-maid'], reference: 'design §2, Icstick/dsh-context-maid' },
  { id: 'dsh-world/compaction', kind: 'compaction', packages: ['dsh-world'], subpaths: DSH_WORLD_COMPACTION, reference: 'chenkezhen480/dsh-world README (row name dsh-world/compaction)' },
  { id: 'dsh-brain-compaction', kind: 'compaction', packages: ['dsh-brain-compaction'], reference: 'task brief' },
  { id: 'flowctx-dsh', kind: 'compaction', packages: ['flowctx-dsh'], reference: 'task brief' },
  { id: 'dsh-qq-bridge', kind: 'bridge', packages: ['dsh-qq-bridge'], reference: 'design §2, 大肥鱼 ecosystem qq-bridge' },
  { id: 'dsh-qqbot', kind: 'bridge', packages: ['dsh-qqbot'], reference: 'design §2/§3.8 qqbot (npm @tencent-connect/dsh-qqbot)' },
  { id: 'dsh-qq-rooms', kind: 'bridge', packages: ['dsh-qq-rooms'], reference: 'design §3.8 qq-rooms' },
  { id: 'dsh-onebot-qq', kind: 'bridge', packages: ['dsh-onebot-qq'], reference: 'firewall review brief (OneBot QQ bridge)' },
  { id: 'dsh-wechat', kind: 'bridge', packages: ['dsh-wechat'], reference: 'firewall review brief (WeChat bridge)' },
]

/** Package identity of a Loader module specifier. */
export interface ModuleIdentity {
  /** Candidate package names, unscoped and lowercase, each with the subpath that follows it. */
  readonly candidates: readonly { readonly name: string; readonly subpath: string }[]
}

function splitPackage(path: string): { name: string; subpath: string } | undefined {
  const parts = path.split('/').filter(part => part !== '')
  const first = parts[0]
  if (first === undefined) return undefined
  if (first.startsWith('@')) {
    const second = parts[1]
    if (second === undefined) return undefined
    return { name: second.toLowerCase(), subpath: parts.slice(2).join('/') }
  }
  return { name: first.toLowerCase(), subpath: parts.slice(1).join('/') }
}

/**
 * Best-effort package identity of a Loader row `name`: bare specifiers
 * (`dsh-world/compaction`, `@scope/pkg/sub`), `npm:` aliases, `file:` URLs and
 * absolute or relative paths (through the last `node_modules/`, otherwise
 * every path segment is a candidate package directory). `cordis:` builtins
 * have no identity.
 */
export function parseModuleSpecifier(specifier: string): ModuleIdentity {
  let spec = specifier.trim()
  if (spec === '' || spec.startsWith('cordis:')) return { candidates: [] }
  if (spec.startsWith('npm:')) spec = spec.slice(4)
  if (spec.startsWith('file:')) {
    try {
      spec = decodeURIComponent(new URL(spec).pathname)
    } catch {
      spec = spec.replace(/^file:\/*/, '/')
    }
  }
  spec = spec.replace(/\\/g, '/')
  const isPath = spec.startsWith('/') || spec.startsWith('.') || /^[a-z]:\//i.test(spec)
  if (!isPath) {
    const parsed = splitPackage(spec)
    return { candidates: parsed ? [parsed] : [] }
  }
  const marker = spec.lastIndexOf('/node_modules/')
  if (marker >= 0) {
    const parsed = splitPackage(spec.slice(marker + '/node_modules/'.length))
    return { candidates: parsed ? [parsed] : [] }
  }
  const parts = spec.split('/').filter(part => part !== '' && part !== '.' && part !== '..' && !/^[a-z]:$/i.test(part))
  return {
    candidates: parts.map((part, index) => ({ name: part.toLowerCase(), subpath: parts.slice(index + 1).join('/') })),
  }
}

function subpathMatches(patterns: readonly string[], subpath: string): boolean {
  const bare = subpath.replace(/\.[cm]?[jt]s$/i, '')
  return patterns.some((pattern) => {
    const glob = compileGlob(pattern, { caseInsensitive: true })
    return glob.match(subpath) !== undefined || glob.match(bare) !== undefined
  })
}

export function matchesKnownPlugin(plugin: KnownPlugin, specifier: string): boolean {
  const packages = plugin.packages.map(name => name.toLowerCase())
  return parseModuleSpecifier(specifier).candidates.some(({ name, subpath }) => packages.includes(name)
    && (plugin.subpaths === undefined || subpathMatches(plugin.subpaths, subpath))
    && (plugin.excludeSubpaths === undefined || !subpathMatches(plugin.excludeSubpaths, subpath)))
}

export interface DetectedPlugin {
  readonly id: string
  readonly kind: CoexistenceKind
  /** Loader row names that matched, in input order. */
  readonly rows: readonly string[]
}

export interface ToolConflict {
  readonly plugin: string
  readonly tools: readonly string[]
}

export interface CoexistenceReport {
  readonly memoryPlugins: readonly DetectedPlugin[]
  readonly compactionPlugins: readonly DetectedPlugin[]
  /** Chat bridges whose sessions reach this agent; `unmatchedSessions: auto` isolates unmatched sessions while one is loaded. */
  readonly bridgePlugins?: readonly DetectedPlugin[]
  /**
   * `assist` when another compaction plugin is present; otherwise `engine`.
   * Engine mode still requires this plugin to own the effective compaction
   * engine (e.g. the Web preset takeover), which the caller checks separately.
   */
  readonly recommendation: 'engine' | 'assist'
  /** Our tool names that a detected plugin also registers. */
  readonly toolConflicts: readonly ToolConflict[]
  readonly warnings: { readonly zh: readonly string[]; readonly en: readonly string[] }
}

const OWN_TOOLS: readonly string[] = Object.values(TOOL_NAMES)

/**
 * Classify loaded Loader row names against {@link KNOWN_PLUGINS} (design §3.1
 * mode choice, §3.8 coexistence). A plugin may appear once per kind.
 */
export function detectCoexistence(loadedRowNames: readonly string[], table: readonly KnownPlugin[] = KNOWN_PLUGINS): CoexistenceReport {
  const detected = new Map<string, { plugin: KnownPlugin; rows: string[] }>()
  for (const row of new Set(loadedRowNames)) {
    if (typeof row !== 'string') continue
    for (const plugin of table) {
      if (!matchesKnownPlugin(plugin, row)) continue
      const key = `${plugin.kind}\0${plugin.id}`
      const hit = detected.get(key)
      if (hit) hit.rows.push(row)
      else detected.set(key, { plugin, rows: [row] })
    }
  }
  const hits = [...detected.values()]
  const of = (kind: CoexistenceKind): DetectedPlugin[] => hits
    .filter(hit => hit.plugin.kind === kind)
    .map(hit => ({ id: hit.plugin.id, kind, rows: hit.rows }))
  const memoryPlugins = of('memory')
  const compactionPlugins = of('compaction')
  const bridgePlugins = of('bridge')
  const toolConflicts = hits.flatMap(({ plugin }) => {
    const tools = (plugin.tools ?? []).filter(tool => OWN_TOOLS.includes(tool))
    return tools.length === 0 ? [] : [{ plugin: plugin.id, tools }]
  })

  const zh: string[] = []
  const en: string[] = []
  if (memoryPlugins.length > 0) {
    const ids = memoryPlugins.map(plugin => plugin.id)
    zh.push(`检测到其他记忆插件：${ids.join('、')}。它们也会注入或存档记忆，可能与记忆云重复注入、重复占用上下文；建议同一 profile 只保留一个负责注入记忆的插件。`)
    en.push(`Other memory plugins detected: ${ids.join(', ')}. They also inject or archive memory, which can duplicate the memory block and waste context; keep a single memory-injecting plugin per profile.`)
  }
  if (compactionPlugins.length > 0) {
    const ids = compactionPlugins.map(plugin => plugin.id)
    zh.push(`检测到其他压缩插件：${ids.join('、')}。为避免压缩引擎冲突，记忆云将以辅助模式运行：保留现有压缩，压缩后再补充记忆块。`)
    en.push(`Other compaction plugins detected: ${ids.join(', ')}. To avoid compaction-engine conflicts, Memory Cloud runs in assist mode: the existing compaction stays and the memory block is re-added after each compaction.`)
  }
  if (bridgePlugins.length > 0) {
    const ids = bridgePlugins.map(plugin => plugin.id)
    zh.push(`检测到聊天桥接插件：${ids.join('、')}。桥接会话不带可供规则匹配的标签；unmatchedSessions 为 auto 时，未匹配任何作用域规则的会话各自使用隔离作用域，看不到主人的记忆。请用规则（如 cwd:/你的目录/* → owner）把自己的会话映射到 owner。`)
    en.push(`Chat bridge plugins detected: ${ids.join(', ')}. Bridge sessions carry no tags that rules could match; with unmatchedSessions set to auto, sessions no scope rule matches each get an isolated scope and never see the owner's memory. Map your own sessions to owner with a rule (e.g. cwd:/your/dir/* -> owner).`)
  }
  for (const conflict of toolConflicts) {
    zh.push(`${conflict.plugin} 也注册了同名工具 ${conflict.tools.join('、')}；DSH 不允许重名工具，后注册的一方会注册失败。`)
    en.push(`${conflict.plugin} also registers ${conflict.tools.join(', ')}; DSH rejects duplicate tool names, so whichever plugin registers second fails to register it.`)
  }
  return {
    memoryPlugins,
    compactionPlugins,
    bridgePlugins,
    recommendation: compactionPlugins.length > 0 ? 'assist' : 'engine',
    toolConflicts,
    warnings: { zh, en },
  }
}
