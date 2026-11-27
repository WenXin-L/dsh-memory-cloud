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
    zh.push(`记忆插件 ${ids.join('、')} 也会注入或存档记忆。同一段记忆若进来两次，就占两份上下文。每份配置只启用一个负责注入记忆的插件即可避免重复。`)
    en.push(`Other memory plugins detected: ${ids.join(', ')}. They also inject or archive memory. Keep one memory-injecting plugin per profile to avoid spending context on the same memory twice.`)
  }
  if (compactionPlugins.length > 0) {
    const ids = compactionPlugins.map(plugin => plugin.id)
    zh.push(`检测到压缩插件 ${ids.join('、')}。在 auto 设置下，记忆云会选择辅助模式，由现有引擎压缩，再由记忆云补回记忆块。`)
    en.push(`Other compaction plugins detected: ${ids.join(', ')}. In auto mode, Memory Cloud selects assist mode. The existing engine handles compaction, then Memory Cloud adds the memory block back.`)
  }
  if (bridgePlugins.length > 0) {
    const ids = bridgePlugins.map(plugin => plugin.id)
    zh.push(`已加载聊天桥接插件 ${ids.join('、')}。桥接标签需要由插件或集成方提供。当 unmatchedSessions=auto 时，未匹配规则的会话各自隔离，看不到主人的记忆。要让自己的会话访问主人记忆，请为它设置作用域规则，例如 cwd:/你的目录/* → owner。`)
    en.push(`Chat bridge plugins loaded: ${ids.join(', ')}. Bridge tags must come from a plugin or integration. With unmatchedSessions=auto, each unmatched session is isolated from the owner's memory. To grant your own sessions access, map them to owner with a rule such as cwd:/your/dir/* -> owner.`)
  }
  for (const conflict of toolConflicts) {
    zh.push(`${conflict.plugin} 也使用工具名 ${conflict.tools.join('、')}。DSH 仅接受第一次注册，后注册的插件会遇到重名错误。`)
    en.push(`${conflict.plugin} also uses the tool names ${conflict.tools.join(', ')}. DSH accepts the first registration. The next plugin to register the same name gets a duplicate-name error.`)
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
