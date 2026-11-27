/**
 * Host-level (headless/sdk) takeover: toggle the shipped-disabled engine row
 * and the base `compaction-basic` row through `ctx.pluginManager`.
 * Headless profiles have no HMR, so expect
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
  if (pluginManager === undefined) return outcome('failed', [], '当前配置没有插件管理器。 / The plugin manager is unavailable in this profile.')
  let state: HostEngineState
  try {
    state = await readHostEngineState(pluginManager)
  } catch (error: unknown) {
    return outcome('failed', [], `读取插件列表失败 / Failed to list plugins: ${errorMessage(error)}`)
  }
  if (state.engine === undefined) {
    return outcome('failed', [], `当前配置缺少引擎条目。请在安装包补丁中加入该条目，并将初始状态设为停用。 / The bundle patch must add this missing engine row as disabled: ${HOST_ENGINE_ROW.id}`)
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
    const failure = step.enabled ? '启用插件失败 / Failed to enable plugin' : '停用插件失败 / Failed to disable plugin'
    if (result.result?.application === 'overridden') {
      return outcome('overridden', steps, `${failure} "${label(step.row)}". 用户目录补丁或命令行补丁覆盖了此设置。 / A home patch or command-line overlay overrides this setting.`)
    }
    return outcome('failed', steps, `${failure} "${label(step.row)}": ${result.error ?? result.result?.error?.diagnostic ?? result.result?.error?.code ?? result.result?.application ?? '原因未知 / unknown cause'}`)
  }

  const restored = state.basic === undefined
    ? '宿主级记忆引擎已停用。 / The host-level memory engine is disabled.'
    : '宿主压缩已选用 compaction-basic。 / Host compaction is set to compaction-basic.'
  if (steps.length === 0) return outcome('unchanged', steps, enabled
    ? '宿主压缩已经选了记忆引擎。这次来接班的，还是它自己。 / The memory engine is already selected for host compaction.'
    : restored)
  if (steps.some(step => step.result?.application === 'restart-required')) return outcome('restart-required', steps, '设置已保存，重启 DSH 后生效。 / Settings saved. Restart DSH to apply them.')
  return outcome('applied', steps, enabled ? '记忆引擎已接管宿主压缩。 / The memory engine now handles host compaction.' : restored)
}

async function toggle(pluginManager: PluginManagerLike, row: PluginRowLike, enabled: boolean): Promise<HostEngineStep> {
  const base = { row: label(row), enabled }
  if (row.readOnlyReason !== undefined) return { ...base, error: `条目只读 / read-only (${row.readOnlyReason})` }
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
