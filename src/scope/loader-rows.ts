/**
 * Version-tolerant enumeration of plugin rows from a Cordis context, for
 * coexistence detection. Everything is duck-typed against
 * `@deepseek-ai/cordis-plugin-loader` (`loader.entries()`, `Entry.options`,
 * `Entry.disabled`) and `@deepseek-ai/dsh-agent-preset-registry`
 * (`inspectCompositions()`, `compositionInventory()`); any shape mismatch or
 * throw yields fewer rows, never an exception.
 */

/** The part of a Cordis `Context` this module needs; `ctx.get` reads a service without `inject`. */
export interface ServiceLookup {
  get(name: string, strict?: boolean): unknown
}

export interface LoadedRow {
  /** Loader entry id (nested ids joined with `:`), or the module name when the source has none. */
  readonly id: string
  /** Module specifier of the row (`name` in `cordis.patch.yml`). */
  readonly name: string
  /** Effective enablement; rows whose state cannot be determined count as enabled. */
  readonly enabled: boolean
  /** `host` for profile/bundle rows, `preset:<id>` for rows of an agent preset composition. */
  readonly source: string
}

const MAX_ROWS = 4096

type Bag = Record<PropertyKey, unknown>

function isBag(value: unknown): value is Bag {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

function service(ctx: ServiceLookup, name: string): Bag | undefined {
  const value = attempt(() => ctx.get(name)) ?? attempt(() => ctx.get(name, false))
  return isBag(value) ? value : undefined
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return isBag(value) && typeof value[Symbol.iterator] === 'function'
}

function iterate(value: unknown): unknown[] {
  if (!isIterable(value)) return []
  const result: unknown[] = []
  for (const item of value) {
    if (result.length >= MAX_ROWS) break
    result.push(item)
  }
  return result
}

function walkStores(tree: unknown, seen: Set<unknown>, into: unknown[]): void {
  if (!isBag(tree) || seen.has(tree) || !isBag(tree.store)) return
  seen.add(tree)
  for (const entry of Object.values(tree.store)) {
    if (into.length >= MAX_ROWS) return
    into.push(entry)
    if (isBag(entry)) walkStores(entry.subtree, seen, into)
  }
}

function loaderEntries(loader: Bag): unknown[] {
  if (typeof loader.entries === 'function') {
    const entries = attempt(() => iterate((loader.entries as () => unknown).call(loader)))
    if (entries !== undefined) return entries
  }
  const entries: unknown[] = []
  attempt(() => walkStores(loader, new Set(), entries))
  return entries
}

function isExpression(value: unknown): boolean {
  return isBag(value) && typeof value.__jsExpr === 'string'
}

function hostRow(entry: unknown): LoadedRow | undefined {
  if (!isBag(entry) || !isBag(entry.options)) return undefined
  const options = entry.options
  const name = options.name
  if (typeof name !== 'string' || name === '' || options.group || name.startsWith('cordis:')) return undefined
  const id = attempt(() => entry.id)
  const disabled = attempt(() => entry.disabled)
  const enabled = typeof disabled === 'boolean'
    ? !disabled
    : isExpression(options.disabled) || !options.disabled
  return {
    id: typeof id === 'string' && id !== '' ? id : typeof options.id === 'string' && options.id !== '' ? options.id : name,
    name,
    enabled,
    source: 'host',
  }
}

function hostRows(ctx: ServiceLookup): LoadedRow[] {
  const loader = service(ctx, 'loader')
  if (loader === undefined) return []
  return loaderEntries(loader).flatMap(entry => attempt(() => hostRow(entry)) ?? [])
}

function presetRows(ctx: ServiceLookup): LoadedRow[] {
  const registry = service(ctx, 'agentPresets')
  if (registry === undefined || typeof registry.inspectCompositions !== 'function') return []
  const inspections = attempt(() => iterate((registry.inspectCompositions as () => unknown).call(registry))) ?? []
  return inspections.flatMap((inspection) => {
    if (!isBag(inspection) || typeof inspection.id !== 'string') return []
    const source = `preset:${inspection.id}`
    return iterate(inspection.modules).flatMap((module) => {
      if (!isBag(module) || typeof module.moduleName !== 'string' || module.moduleName === '' || module.moduleName.startsWith('cordis:')) return []
      return [{ id: module.moduleName, name: module.moduleName, enabled: true, source }]
    })
  })
}

async function inventoryRows(ctx: ServiceLookup): Promise<LoadedRow[]> {
  const registry = service(ctx, 'agentPresets')
  if (registry === undefined || typeof registry.compositionInventory !== 'function') return []
  const compositions = iterate(await (registry.compositionInventory as () => unknown).call(registry))
  return compositions.flatMap((composition) => {
    if (!isBag(composition) || typeof composition.id !== 'string') return []
    const source = `preset:${composition.id}`
    return iterate(composition.rows).flatMap((row) => {
      if (!isBag(row) || typeof row.moduleName !== 'string' || row.moduleName === '' || row.moduleName.startsWith('cordis:')) return []
      const id = typeof row.entryId === 'string' && row.entryId !== '' ? row.entryId : row.moduleName
      return [{ id, name: row.moduleName, enabled: row.enabled !== false, source }]
    })
  })
}

function dedupe(rows: readonly LoadedRow[]): LoadedRow[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = `${row.source}\u0000${row.id}\u0000${row.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Host Loader rows (including nested groups and include subtrees) plus the
 * active modules of every retained agent preset revision. Preset revisions
 * exist only while some agent uses them, and preset trees are not reachable
 * from `loader.entries()`, so call this lazily (e.g. at `agent/created` or
 * from `/memory status`) rather than once in `apply()`.
 */
export function listLoadedRows(ctx: ServiceLookup): LoadedRow[] {
  try {
    return dedupe([...attempt(() => hostRows(ctx)) ?? [], ...attempt(() => presetRows(ctx)) ?? []])
  } catch {
    return []
  }
}

/** {@link listLoadedRows} plus every declared preset's rows from `compositionInventory()`, mounted or not. Never rejects. */
export async function listLoadedRowsDeep(ctx: ServiceLookup): Promise<LoadedRow[]> {
  try {
    const declared = await inventoryRows(ctx).catch(() => [])
    return dedupe([...listLoadedRows(ctx), ...declared])
  } catch {
    return []
  }
}

/** Unique module names of enabled rows, in order: the input for `detectCoexistence()`. */
export function loadedRowNames(rows: readonly LoadedRow[]): string[] {
  return [...new Set(rows.filter(row => row.enabled).map(row => row.name))]
}
