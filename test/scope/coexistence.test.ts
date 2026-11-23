import { describe, expect, it } from 'vitest'
import { TOOL_NAMES } from '../../src/contracts.ts'
import { detectCoexistence, KNOWN_PLUGINS, matchesKnownPlugin, parseModuleSpecifier, type KnownPlugin } from '../../src/scope/index.ts'

const ids = (plugins: readonly { id: string }[]) => plugins.map(plugin => plugin.id)

describe('parseModuleSpecifier', () => {
  it('reads bare, scoped and subpath specifiers', () => {
    expect(parseModuleSpecifier('dsh-world/compaction').candidates).toEqual([{ name: 'dsh-world', subpath: 'compaction' }])
    expect(parseModuleSpecifier('@yindf/DSH-Taskfold/plugins').candidates).toEqual([{ name: 'dsh-taskfold', subpath: 'plugins' }])
    expect(parseModuleSpecifier('npm:dsh-engramory').candidates).toEqual([{ name: 'dsh-engramory', subpath: '' }])
  })

  it('reads installed paths through the last node_modules', () => {
    const file = 'file:///home/u/.dsh/profiles/web/node_modules/.pnpm/dsh-taskfold@0.40.1/node_modules/dsh-taskfold/plugins/taskfold.mjs'
    expect(parseModuleSpecifier(file).candidates).toEqual([{ name: 'dsh-taskfold', subpath: 'plugins/taskfold.mjs' }])
    expect(parseModuleSpecifier('C:\\Users\\u\\.dsh\\node_modules\\@x\\dsh-memory\\lib\\index.js').candidates)
      .toEqual([{ name: 'dsh-memory', subpath: 'lib/index.js' }])
    expect(parseModuleSpecifier('file:///C:/Users/u/dev/dsh-context-maid/index.js').candidates.map(candidate => candidate.name))
      .toEqual(['users', 'u', 'dev', 'dsh-context-maid', 'index.js'])
    expect(parseModuleSpecifier('file:///home/u/my%20plugins/node_modules/flowctx-dsh/lib/index.js').candidates)
      .toEqual([{ name: 'flowctx-dsh', subpath: 'lib/index.js' }])
  })

  it('offers every segment of a checkout path as a candidate', () => {
    const names = parseModuleSpecifier('/Users/u/dev/dsh-world/lib/compaction.js').candidates.map(candidate => candidate.name)
    expect(names).toContain('dsh-world')
  })

  it('gives builtins and empty names no identity', () => {
    expect(parseModuleSpecifier('cordis:group').candidates).toEqual([])
    expect(parseModuleSpecifier('  ').candidates).toEqual([])
  })
})

describe('matchesKnownPlugin', () => {
  const world = KNOWN_PLUGINS.find(plugin => plugin.id === 'dsh-world')!
  const worldCompaction = KNOWN_PLUGINS.find(plugin => plugin.id === 'dsh-world/compaction')!

  it('splits dsh-world into its memory row and its compaction row', () => {
    expect(matchesKnownPlugin(world, 'dsh-world')).toBe(true)
    expect(matchesKnownPlugin(worldCompaction, 'dsh-world')).toBe(false)
    expect(matchesKnownPlugin(world, 'dsh-world/compaction')).toBe(false)
    expect(matchesKnownPlugin(worldCompaction, 'dsh-world/compaction')).toBe(true)
    expect(matchesKnownPlugin(worldCompaction, '/Users/u/dev/dsh-world/lib/compaction.js')).toBe(true)
    expect(matchesKnownPlugin(world, '/Users/u/dev/dsh-world/lib/index.js')).toBe(true)
  })
})

describe('detectCoexistence', () => {
  it('recommends engine mode when nothing else is loaded', () => {
    const report = detectCoexistence([
      'dsh-memory-cloud-brain',
      'dsh-memory-cloud-brain/engine',
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-command-compact',
      'cordis:group',
    ])
    expect(report).toMatchObject({ memoryPlugins: [], compactionPlugins: [], recommendation: 'engine', toolConflicts: [] })
    expect(report.warnings).toEqual({ zh: [], en: [] })
  })

  it('does not confuse similarly named packages with dsh-memory', () => {
    const report = detectCoexistence(['dsh-memory-cloud', 'dsh-memory-pyramid', 'my-dsh-memory', 'dsh-memoryx'])
    expect(report.memoryPlugins).toEqual([])
  })

  it('detects memory plugins without changing the recommendation', () => {
    const report = detectCoexistence(['dsh-engramory', '@someone/dsh-auto-memory', 'dsh-dafeiyu-life', 'dsh-pbyugujia', 'dsh-qq-bridge'])
    expect(ids(report.memoryPlugins)).toEqual(['dsh-engramory', 'dsh-auto-memory', 'dsh-dafeiyu-life', 'dsh-pbyugujia', 'dsh-qq-bridge'])
    expect(report.compactionPlugins).toEqual([])
    expect(report.recommendation).toBe('engine')
    expect(report.warnings.zh).toHaveLength(2)
    expect(report.warnings.zh[0]).toContain('dsh-engramory、dsh-auto-memory')
    expect(report.warnings.en[0]).toContain('dsh-engramory, dsh-auto-memory')
  })

  it('detects chat bridges, including scoped packages, and explains the unmatched-session isolation', () => {
    const report = detectCoexistence(['@tencent-connect/dsh-qqbot', 'dsh-qq-bridge', 'dsh-qq-rooms/plugin', 'dsh-onebot-qq', 'dsh-wechat'])
    expect(ids(report.bridgePlugins ?? [])).toEqual(['dsh-qqbot', 'dsh-qq-bridge', 'dsh-qq-rooms', 'dsh-onebot-qq', 'dsh-wechat'])
    expect(ids(report.memoryPlugins)).toEqual(['dsh-qq-bridge'])
    expect(report.recommendation).toBe('engine')
    expect(report.warnings.zh.some(warning => warning.includes('聊天桥接') && warning.includes('unmatchedSessions'))).toBe(true)
    expect(report.warnings.en.some(warning => warning.includes('Chat bridge') && warning.includes('unmatchedSessions'))).toBe(true)
    expect(detectCoexistence(['dsh-qqbot-tools', 'my-dsh-wechat']).bridgePlugins).toEqual([])
  })

  it('recommends assist mode for every known compaction plugin', () => {
    for (const row of ['dsh-taskfold/plugins', 'dsh-ebbing-context', 'dsh-ctxopt-compaction', 'dsh-context-maid', 'dsh-world/compaction', 'dsh-brain-compaction', 'flowctx-dsh']) {
      const report = detectCoexistence([row])
      expect(report.compactionPlugins, row).toHaveLength(1)
      expect(report.recommendation, row).toBe('assist')
      expect(report.warnings.zh.some(warning => warning.includes('辅助模式')), row).toBe(true)
      expect(report.warnings.en.some(warning => warning.includes('assist mode')), row).toBe(true)
    }
  })

  it('groups several rows of one plugin under a single detection', () => {
    const report = detectCoexistence(['dsh-taskfold/plugins', 'dsh-taskfold-client', 'dsh-taskfold/plugins'])
    expect(report.compactionPlugins).toEqual([{ id: 'dsh-taskfold', kind: 'compaction', rows: ['dsh-taskfold/plugins', 'dsh-taskfold-client'] }])
  })

  it('reports dsh-world as both a memory and a compaction plugin, with its tool clash', () => {
    const report = detectCoexistence(['dsh-world', 'dsh-world/compaction'])
    expect(ids(report.memoryPlugins)).toEqual(['dsh-world'])
    expect(ids(report.compactionPlugins)).toEqual(['dsh-world/compaction'])
    expect(report.recommendation).toBe('assist')
    expect(report.toolConflicts).toEqual([{ plugin: 'dsh-world', tools: [TOOL_NAMES.read] }])
    expect(report.warnings.zh).toHaveLength(3)
    expect(report.warnings.en.at(-1)).toContain('memory_read')
  })

  it('reports dsh-memory tool clashes on our tool names only', () => {
    const report = detectCoexistence(['dsh-memory'])
    expect(report.toolConflicts).toEqual([{ plugin: 'dsh-memory', tools: [TOOL_NAMES.search, TOOL_NAMES.read] }])
  })

  it('accepts a custom table', () => {
    const table: KnownPlugin[] = [{ id: 'x-fold', kind: 'compaction', packages: ['x-fold'], reference: 'test' }]
    expect(detectCoexistence(['x-fold/engine'], table).recommendation).toBe('assist')
    expect(detectCoexistence(['dsh-taskfold'], table).recommendation).toBe('engine')
  })

  it('keeps the table well-formed', () => {
    const seen = new Set<string>()
    for (const plugin of KNOWN_PLUGINS) {
      const key = `${plugin.kind}:${plugin.id}`
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
      expect(plugin.packages.length, plugin.id).toBeGreaterThan(0)
      for (const name of plugin.packages) expect(name, plugin.id).toBe(name.toLowerCase())
      expect(plugin.packages, plugin.id).not.toContain('dsh-memory-cloud-brain')
    }
  })
})
