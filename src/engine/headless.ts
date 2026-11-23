/**
 * Host-level (headless/sdk) takeover: toggle the shipped-disabled engine row
 * and the base `compaction-basic` row through `ctx.pluginManager`
 * (api-notes §2.3). Headless profiles have no HMR, so expect
 * `restart-required`. Do not use this in preset profiles (web/desktop): a
 * host-level engine's global listeners would also compact preset agents.
 */
import { COMPACTION_BASIC_ROW } from './takeover.ts'
import { ENGINE_ROW, HOST_ENGINE_ROW } from './host.ts'

/** The subset of `PluginInfo` from `@deepseek-ai/dsh-plugin-manager` this helper reads. */
export interface PluginRowLike {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly patchId?: string
  readonly readOnlyReason?: string
}

/** The subset of the plugin manager's `ChangeResult`. */
export interface PluginChangeLike {
  readonly changed: boolean
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  readonly restartReason?: string
  readonly error?: { readonly code: string; readonly diagnostic?: string }
}

/** The subset of `ctx.pluginManager` this helper uses. */
export interface PluginManagerLike {
  listPlugins(): Promise<readonly PluginRowLike[]>
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginChangeLike>
}

export type HostEngineApplication = 'applied' | 'restart-required' | 'overridden' | 'failed' | 'unchanged'

export interface HostEngineStep {
  readonly row: string
  readonly enabled: boolean
  readonly result?: PluginChangeLike
  readonly error?: string
  /** Set when this step undid an earlier one after a later step failed. */
  readonly rollback?: true
}

export interface HostEngineOutcome {
  readonly ok: boolean
  readonly application: HostEngineApplication
  readonly restartReasons: readonly string[]
  readonly steps: readonly HostEngineStep[]
  readonly message: string
}

export interface HostEngineState {
  readonly engine?: PluginRowLike
  readonly basic?: PluginRowLike
  /** Our engine row is enabled and no enabled host-level compaction-basic competes with it. */
  readonly active: boolean
}

export async function readHostEngineState(pluginManager: PluginManagerLike): Promise<HostEngineState> {
  const rows = await pluginManager.listPlugins()
  const engine = findRow(rows, [HOST_ENGINE_ROW.id, ENGINE_ROW.id], ENGINE_ROW.name)
  const basic = findRow(rows, [COMPACTION_BASIC_ROW.id], COMPACTION_BASIC_ROW.name)
  return {
    ...engine === undefined ? {} : { engine },
    ...basic === undefined ? {} : { basic },
    active: engine?.enabled === true && basic?.enabled !== true,
  }
}

/**
 * Enable our host-level engine (disabling `compaction-basic` first, since both
 * provide `compaction`) or reverse it. Best effort: never rejects, rolls the
 * first step back when the second fails, and reports `restart-required`.
 */
export async function setHostEngineEnabled(pluginManager: PluginManagerLike | undefined, enabled: boolean): Promise<HostEngineOutcome> {
  if (pluginManager === undefined) return outcome('failed', [], 'the plugin manager is not available in this profile')
  let state: HostEngineState
  try {
    state = await readHostEngineState(pluginManager)
  } catch (error: unknown) {
    return outcome('failed', [], `could not list plugins: ${errorMessage(error)}`)
  }
  if (state.engine === undefined) {
    return outcome('failed', [], `engine row "${HOST_ENGINE_ROW.id}" is not in this profile; the bundle patch must insert it disabled`)
  }

  const plan: { readonly row: PluginRowLike; readonly enabled: boolean }[] = enabled
    ? [...state.basic === undefined ? [] : [{ row: state.basic, enabled: false }], { row: state.engine, enabled: true }]
    : [{ row: state.engine, enabled: false }, ...state.basic === undefined ? [] : [{ row: state.basic, enabled: true }]]

  const steps: HostEngineStep[] = []
  const done: { readonly row: PluginRowLike; readonly enabled: boolean }[] = []
  for (const step of plan) {
    if (step.row.enabled === step.enabled) continue
    const result = await toggle(pluginManager, step.row, step.enabled)
    steps.push(result)
    if (succeeded(result)) {
      done.push(step)
      continue
    }
    for (const previous of done.toReversed()) steps.push({ ...await toggle(pluginManager, previous.row, !previous.enabled), rollback: true })
    const verb = step.enabled ? 'enable' : 'disable'
    if (result.result?.application === 'overridden') {
      return outcome('overridden', steps, `could not ${verb} "${label(step.row)}": a home patch or command-line overlay overrides the row`)
    }
    return outcome('failed', steps, `could not ${verb} "${label(step.row)}": ${result.error ?? result.result?.error?.diagnostic ?? result.result?.error?.code ?? result.result?.application ?? 'unknown failure'}`)
  }

  if (steps.length === 0) return outcome('unchanged', steps, enabled ? 'the memory engine already owns host-level compaction' : 'host-level compaction already uses compaction-basic')
  if (steps.some(step => step.result?.application === 'restart-required')) return outcome('restart-required', steps, 'saved; restart DSH for the change to take effect')
  return outcome('applied', steps, enabled ? 'the memory engine now owns host-level compaction' : 'host-level compaction is back on compaction-basic')
}

async function toggle(pluginManager: PluginManagerLike, row: PluginRowLike, enabled: boolean): Promise<HostEngineStep> {
  const base = { row: label(row), enabled }
  if (row.readOnlyReason !== undefined) return { ...base, error: `read-only (${row.readOnlyReason})` }
  try {
    return { ...base, result: await pluginManager.setPluginEnabled(row.entryId, enabled) }
  } catch (error: unknown) {
    return { ...base, error: errorMessage(error) }
  }
}

function succeeded(step: HostEngineStep): boolean {
  const application = step.result?.application
  return step.error === undefined && (application === 'applied' || application === 'restart-required')
}

function findRow(rows: readonly PluginRowLike[], ids: readonly string[], moduleName: string): PluginRowLike | undefined {
  const byId = rows.filter(row => row.patchId !== undefined && ids.includes(row.patchId))
  if (byId.length > 0) return byId.find(row => row.moduleName === moduleName) ?? byId[0]
  const byModule = rows.filter(row => row.moduleName === moduleName)
  return byModule.length === 1 ? byModule[0] : undefined
}

function outcome(application: HostEngineApplication, steps: readonly HostEngineStep[], message: string): HostEngineOutcome {
  const restartReasons = [...new Set(steps.flatMap(step => step.result?.restartReason === undefined ? [] : [step.result.restartReason]))]
  return { ok: application !== 'failed' && application !== 'overridden', application, restartReasons, steps, message }
}

function label(row: PluginRowLike): string {
  return row.patchId ?? row.entryId
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
