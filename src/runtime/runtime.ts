import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-session-log-deepseek'
import { attachCaptureToDsh, createCapture, isSyntheticRecord, toRawEventRecord } from '../capture/index.ts'
import type { Capture } from '../capture/index.ts'
import { registerMemoryCommand } from '../commands/index.ts'
import type { CommandOutcome, MemoryCommandDeps } from '../commands/index.ts'
import type { Config } from '../config.ts'
import type { Clock, EpisodeMeta, EpisodeStatus, ScopeDecision, ScopeId, SessionDescriptor } from '../contracts.ts'
import { COMPACTION_MODES, COMPRESSION_LEVELS, SUMMARIZE_PURPOSE } from '../contracts.ts'
import {
  createTakeoverController,
  isMemoryCompactionEngine,
  maxCheckpointChars,
  MEMORY_CLOUD_SERVICE,
  MIN_CHECKPOINT_CHARS,
  readHostEngineState,
  setHostEngineEnabled,
} from '../engine/index.ts'
import type { EngineFallback, EngineFallbackKind } from '../engine/index.ts'
import { attachInjector, buildUsageSection, createInjector } from '../inject/index.ts'
import type { Injector } from '../inject/index.ts'
import { MAX_EVENT_RECALL_TOKENS, renderEventRecall } from '../inject/events.ts'
import { createMemoryPacker, createTokenEstimator } from '../pack/index.ts'
import {
  canReadScope,
  createScopeResolver,
  createSessionTagRegistry,
  decideUnmatched,
  describeSession,
  detectCoexistence,
  inheritParentTags,
  listLoadedRows,
  listLoadedRowsDeep,
  loadedRowNames,
} from '../scope/index.ts'
import type { CoexistenceReport, SessionLike } from '../scope/index.ts'
import { createFileMemoryStore } from '../store/index.ts'
import type { FileMemoryStore } from '../store/index.ts'
import { createEventMemory } from '../store/event-memory.ts'
import { createProfileNotes } from '../store/profile-notes.ts'
import { createDshLlmClient } from '../summarize/index.ts'
import { createJobRunner, DEFAULT_JOB_RUNNER_OPTIONS } from '../summarize/jobs/index.ts'
import type { JobRunner } from '../summarize/jobs/index.ts'
import { rankEventMemories } from '../tools/event-recall.ts'
import { createMemorySearch, recallPolicy, registerMemoryTools } from '../tools/index.ts'
import { createBudgetService, levelOverrides } from './budget.ts'
import type { BudgetService } from './budget.ts'
import { createCheckpointComposer } from './composer.ts'
import type { MemoryCheckpointComposer } from './composer.ts'
import {
  compactionServiceOf,
  configEditorOf,
  errorMessage,
  hasMethod,
  optionalService,
  pluginManagerOf,
} from './host.ts'
import type { AgentDefaultModelLike, CompactionServiceLike, ProfileContextLike, SettingsLike } from './host.ts'
import { createModeResolver } from './mode.ts'
import type { ModeResolver } from './mode.ts'
import { compactableTokens, contextPressure } from './pressure.ts'
import type { PressureMeter } from './pressure.ts'
import { registerMemoryCloudRemote } from './remote.ts'
import { createBackgroundRoute } from './route.ts'
import { createConfigAccess, createConfigWriter, rowIdOf } from './settings.ts'
import type { SettingWriteResult } from './settings.ts'
import { createPackSourceLoader } from './sources.ts'
import type {
  AgentStatusReport,
  FallbackRecord,
  MemoryCloudApi,
  MemoryCloudService,
  MemoryCloudStatus,
  ScopeEpisodeCounts,
  TakeoverActionResult,
  TakeoverReport,
} from './status.ts'
import { createSummaryService } from './summaries.ts'
import type { SummaryService } from './summaries.ts'
import { createTakeoverStateFile } from './takeover-state.ts'

export const PLUGIN_NAME = 'dsh-memory-cloud-brain'
export const STORAGE_DIR = 'memory-cloud'

const IDLE_CHECK_INTERVAL_MS = 60_000
const IDLE_COMPACT_DEBOUNCE_MS = 2 * 60_000
export const IDLE_QUIET_MS = 20_000
const TAKEOVER_REFRESH_DELAY_MS = 10_000
const COEXISTENCE_TTL_MS = 5000
const MAX_FALLBACKS = 20
const ROUTINE_FALLBACKS: ReadonlySet<EngineFallbackKind> = new Set(['subagent', 'no-capture', 'region-too-small'])
const SESSION_TAGS = Symbol.for('dsh-memory-cloud-brain.session-tags')

/** `ctx.agents` (`@deepseek-ai/dsh-agent`): every live agent, including ones created before this plugin started. */
interface AgentRegistryLike {
  get(id: SessionId): Agent | undefined
  list(): readonly Agent[]
}

/** `ctx.agentPresets.presetForSession`: the preset a session runs now, after any `agent-preset/selected`. */
interface PresetProjectionLike {
  presetForSession(session: Session): string | null
}

function agentRegistryOf(ctx: Context): AgentRegistryLike | undefined {
  const registry = optionalService<unknown>(ctx, 'agents')
  return hasMethod(registry, 'get') && hasMethod(registry, 'list') ? registry as unknown as AgentRegistryLike : undefined
}

/**
 * Session tags of one DSH app, shared by every start of this plugin in the
 * process: a reload (upgrade, `storageRoot` edit, re-enable) keeps the tags
 * bridges set on sessions that are still live.
 */
function sharedSessionTags(ctx: Context): Map<string, readonly string[]> {
  const holder = globalThis as unknown as Record<symbol, WeakMap<object, Map<string, readonly string[]>> | undefined>
  const apps = holder[SESSION_TAGS] ??= new WeakMap()
  let tags = apps.get(ctx.root)
  if (tags === undefined) {
    tags = new Map()
    apps.set(ctx.root, tags)
  }
  return tags
}

/** Handles kept for tests and diagnostics; the plugin itself only needs `service`. */
export interface MemoryCloudRuntime {
  readonly service: MemoryCloudService
  readonly store: FileMemoryStore
  readonly capture: Capture
  readonly runner: JobRunner
  readonly composer: MemoryCheckpointComposer
  readonly injector: Injector<Agent>
  readonly summaries: SummaryService
  readonly budgets: BudgetService
  readonly modes: ModeResolver
}

export interface MemoryCloudRuntimeOptions {
  /** Quiet time after an agent turns idle before idle consolidation runs; any new status cancels it. Defaults to {@link IDLE_QUIET_MS}. */
  readonly idleQuietMs?: number
}

export function resolveStorageRoot(configured: string | undefined): string {
  const root = configured?.trim() ?? ''
  return root.length > 0 ? root : dshHomePath(STORAGE_DIR)
}

/**
 * Assemble every module into the running plugin (design §3): one store, the
 * capture adapter, background summaries and rollups, the engine host service,
 * injection, recall tools, `/memory`, and idle consolidation. Every listener
 * is guarded and every detached promise is caught; everything is disposed
 * with `ctx`.
 */
export function startMemoryCloud(ctx: Context, config: Config, options: MemoryCloudRuntimeOptions = {}): MemoryCloudRuntime {
  const idleQuietMs = options.idleQuietMs ?? IDLE_QUIET_MS
  const logger = ctx.logger
  const clock: Clock = { now: () => Date.now() }
  const estimator = createTokenEstimator()
  const rowId = rowIdOf(ctx.fiber.entry, PLUGIN_NAME)
  const store = createFileMemoryStore({
    root: resolveStorageRoot(config.storageRoot),
    clock,
    estimator,
    onWarning: (message, error) => logger.warn('%s%s', message, error === undefined ? '' : `: ${errorMessage(error)}`),
  })
  const lifetime = new AbortController()
  const guard = (label: string, run: () => void): void => {
    try {
      run()
    } catch (error) {
      logger.warn('%s failed: %s', label, errorMessage(error))
    }
  }

  const liveAgents = new Map<string, Agent>()
  /** When idle consolidation last started, or a compaction last ended, per agent. */
  const idleAttempts = new WeakMap<Agent, number>()
  const agentOf = (sessionId: string): Agent | undefined => {
    const live = liveAgents.get(sessionId)
    if (live !== undefined) return live
    try {
      return agentRegistryOf(ctx)?.get(sessionId as SessionId)
    } catch {
      return undefined
    }
  }
  const sessionOf = (sessionId: string): Session | undefined => {
    const agent = agentOf(sessionId)
    if (agent !== undefined) return agent.session
    try {
      return ctx.sessions.get(sessionId as SessionId)
    } catch {
      return undefined
    }
  }

  const sessionTags = sharedSessionTags(ctx)
  guard('session tags', () => {
    for (const sessionId of sessionTags.keys()) {
      if (sessionOf(sessionId) === undefined) sessionTags.delete(sessionId)
    }
  })
  const tags = createSessionTagRegistry(sessionTags)
  const selectedPresets = new Map<string, string>()
  const descriptors = new Map<string, SessionDescriptor>()
  const tagProviders = [tags.provider, inheritParentTags(id => descriptors.get(id)?.tags)]
  const presetOf = (sessionId: string, session?: Session): string | undefined => {
    const presets = optionalService<unknown>(ctx, 'agentPresets')
    if (session !== undefined && hasMethod(presets, 'presetForSession')) {
      try {
        const preset: unknown = (presets as unknown as PresetProjectionLike).presetForSession(session)
        if (typeof preset === 'string' && preset !== '') return preset
      } catch {}
    }
    return selectedPresets.get(sessionId)
  }
  const describeAs = (sessionId: string, session: SessionLike, live?: Session): SessionDescriptor => {
    const agentPreset = presetOf(sessionId, live)
    const descriptor = describeSession(session, {
      tagProviders,
      onProviderError: error => logger.warn('session tag provider failed: %s', errorMessage(error)),
      ...agentPreset === undefined ? {} : { agentPreset },
    })
    descriptors.set(sessionId, descriptor)
    return descriptor
  }
  const describe = (session: Session): SessionDescriptor => descriptors.get(session.id) ?? describeAs(session.id, session, session)
  const scopes = createScopeResolver({
    rules: () => config.scopeRules.get(),
    unmatched: () => decideUnmatched(config.unmatchedSessions.get(), coexistence().bridgePlugins?.map(plugin => plugin.id)),
    onWarning: message => logger.warn('%s', message),
    lookup: (sessionId) => {
      const session = sessionOf(sessionId)
      return session === undefined ? descriptors.get(sessionId) : describe(session)
    },
  })
  const scopeOf = (session: Session): ScopeDecision => scopes.resolve(describe(session))

  const defaultRoute = (): { provider: string; model: string } | undefined => {
    const service = optionalService<AgentDefaultModelLike>(ctx, 'agentDefaultModel')
    try {
      const selection = hasMethod(service, 'currentSelection') ? service.currentSelection() : undefined
      return selection === undefined ? undefined : { provider: selection.provider, model: selection.model }
    } catch {
      return undefined
    }
  }
  const budgets = createBudgetService({
    resolveModelInfo: (provider, model, signal) => ctx.llm.resolveModelInfo(provider, model, signal),
    defaultRoute,
    level: () => config.level.get(),
    overrides: () => levelOverrides(config.overrides.get()),
    now: clock.now,
  })

  const llm = createDshLlmClient(ctx, { defaultRoute })
  const backgroundRoute = createBackgroundRoute({
    configured: () => ({
      provider: config.summarizer.provider.get(),
      model: config.summarizer.model.get(),
      reasoningEffort: config.summarizer.reasoningEffort.get(),
    }),
    defaultRoute,
    resolveModelInfo: (provider, model) => ctx.llm.resolveModelInfo(provider, model),
    onFallback: (configured, fallback, reason) => logger.warn(
      'summarizer model %s/%s is unavailable (%s); background summaries use the default model %s/%s',
      configured.provider, configured.model, reason, fallback.provider, fallback.model,
    ),
    now: clock.now,
  })

  const jobOptions = DEFAULT_JOB_RUNNER_OPTIONS
  let rollupPlanningDeferred = false
  const summaries = createSummaryService({
    store,
    llm,
    estimator,
    clock,
    logger,
    backgroundRoute,
    levelBudget: () => budgets.levelBudget(),
    maxAttempts: jobOptions.maxAttempts,
    hostReady: () => !lifetime.signal.aborted && optionalService(ctx, 'llm') !== undefined,
  })
  const runner = createJobRunner({
    store,
    clock,
    logger,
    summarizeEpisode: (scope, id, signal) => summaries.summarizeEpisode(scope, id, signal),
    buildRollup: (scope, period, signal) => summaries.buildRollup(scope, period, signal),
    rollupPlanner: (_scope, index) => {
      const budget = budgets.levelBudgetKnown()
      if (budget === undefined) {
        rollupPlanningDeferred = true
        return []
      }
      return summaries.planRollups(index, budget.quotas.distant, budget.gistTokens)
    },
    options: jobOptions,
  })

  const packer = createMemoryPacker({ estimator })
  const notes = createProfileNotes(store.root)
  const events = createEventMemory(store.root, clock)
  const sources = createPackSourceLoader(store, async () => {
    try {
      return (await notes.apply({ action: 'list' })).entries
    } catch {
      logger.warn('Could not load owner profile-notes.json. Check its format and read permissions. Packing the hand-written profile and episodes.')
      return []
    }
  })
  const capture = createCapture({
    store,
    estimator,
    clock,
    resolveScope: descriptor => scopes.resolve(descriptors.get(descriptor.sessionId) ?? descriptor),
    onSealed: (scope, meta) => onSealed(scope, meta),
    options: {
      get idleMinutes() { return config.idleMinutes.get() },
      get maxEpisodeTokens() { return config.maxEpisodeTokens.get() },
      get captureReasoning() { return config.captureReasoning.get() },
    },
    logger,
  })
  const composer = createCheckpointComposer({
    store,
    sources,
    packer,
    summarizer: summaries.summarizer,
    estimator,
    clock,
    flushSession: sessionId => capture.flushSession(sessionId),
    halfLifeDays: () => config.halfLifeDays.get(),
    log: record => summaries.log(record),
    mayRead: (sessionId, scope) => {
      const agent = agentOf(sessionId)
      return agent !== undefined && canReadScope(scopeOf(agent.session), scope)
    },
    syntheticSeq: (sessionId, seq) => {
      const event = agentOf(sessionId)?.session.eventAt(seq as SessionSeq)
      return event !== undefined && isSyntheticRecord(toRawEventRecord(event))
    },
  })

  async function onSealed(scope: ScopeId, meta: EpisodeMeta): Promise<void> {
    if (meta.sealReason === 'compaction') {
      const composed = composer.takeComposed(meta.sessionId, meta.shadowedSeqs)
      if (composed !== undefined && composed.scope === scope && composed.episode === meta.id && regionWithin(meta)) {
        try {
          await summaries.writeOutcome(scope, meta.id, composed.outcome, 'checkpoint')
          logger.debug('stored the checkpoint summary of %s without another model call', meta.id)
          return
        } catch (error) {
          logger.warn('could not store the checkpoint summary of %s (%s); queueing a background summary', meta.id, errorMessage(error))
        }
      }
    }
    await runner.enqueueSummarize(scope, meta.id)
  }

  let coexistenceCache: { readonly at: number; readonly report: CoexistenceReport } | undefined
  let deepRowNames: readonly string[] = []
  let deepScan: Promise<void> | undefined
  const refreshDeepRows = (): Promise<void> => {
    deepScan ??= listLoadedRowsDeep(ctx)
      .then(rows => {
        deepRowNames = loadedRowNames(rows)
        coexistenceCache = undefined
      })
      .catch((error: unknown) => logger.warn('could not scan loaded plugin rows (%s)', errorMessage(error)))
      .finally(() => { deepScan = undefined })
    return deepScan
  }
  const coexistence = (): CoexistenceReport => {
    const now = clock.now()
    if (coexistenceCache !== undefined && now - coexistenceCache.at < COEXISTENCE_TTL_MS) return coexistenceCache.report
    void refreshDeepRows()
    const names = [...new Set([...loadedRowNames(listLoadedRows(ctx)), ...deepRowNames])]
    const report = detectCoexistence(names)
    coexistenceCache = { at: now, report }
    return report
  }
  const modes = createModeResolver({
    configured: () => config.compactionMode.get(),
    compactionService: agent => compactionServiceOf(ctx, agent),
    engineOwns: isMemoryCompactionEngine,
    coexistence,
  })
  const knownCompactionPlugins = new Set<string>()
  const noteCompactionPlugins = (report: CoexistenceReport): void => {
    const fresh = report.compactionPlugins.filter(plugin => !knownCompactionPlugins.has(plugin.id))
    if (fresh.length === 0) return
    for (const plugin of fresh) knownCompactionPlugins.add(plugin.id)
    coexistenceCache = undefined
    modes.invalidate()
    logger.info('compaction plugin %s detected; compaction modes are re-evaluated', fresh.map(plugin => plugin.id).join(', '))
  }

  const meter = (): PressureMeter | undefined => optionalService<PressureMeter>(ctx, 'tokenMeter')
  const pressureOf = (agent: Agent): number => contextPressure(agent.session, { meter, estimator, knownWindow: () => budgets.knownWindow(agent) })

  const fallbacks: FallbackRecord[] = []
  const routineFallbacks: Partial<Record<EngineFallbackKind, number>> = {}
  const notifyFallback = (reason: EngineFallback): void => {
    if (ROUTINE_FALLBACKS.has(reason.kind)) {
      routineFallbacks[reason.kind] = (routineFallbacks[reason.kind] ?? 0) + 1
      return
    }
    fallbacks.push({
      kind: reason.kind,
      stage: reason.stage,
      sessionId: reason.sessionId,
      ...reason.detail === undefined ? {} : { detail: reason.detail },
      at: clock.now(),
    })
    if (fallbacks.length > MAX_FALLBACKS) fallbacks.shift()
    if (reason.stage !== 'summarize') return
    logger.info('memory checkpoint for session %s fell back to the default summary (%s); its episode is summarized in the background', reason.sessionId, reason.kind)
    runner.kick()
  }

  const profileName = optionalService<ProfileContextLike>(ctx, 'profileContext')?.name
  const takeover = createTakeoverController({
    configEditor: () => configEditorOf(ctx),
    state: createTakeoverStateFile(store.root, profileName ?? 'default'),
  })
  const writeConfig = createConfigWriter({
    rowId,
    settings: () => {
      const settings = optionalService<SettingsLike>(ctx, 'settings')
      return hasMethod(settings, 'update') ? settings : undefined
    },
    configEditor: () => configEditorOf(ctx),
  })
  const registrations: { tools: boolean; command: boolean; problems: string[] } = { tools: false, command: false, problems: [] }

  const settingsChanged = (): void => {
    modes.invalidate()
    coexistenceCache = undefined
  }

  const setLevel = async (level: number): Promise<SettingWriteResult> => {
    if (!(COMPRESSION_LEVELS as readonly number[]).includes(level)) return { ok: false, message: `请选择有效的压缩档位。 / level must be one of ${COMPRESSION_LEVELS.join(', ')}` }
    const result = await writeConfig({ level })
    if (result.ok) settingsChanged()
    return result
  }

  const setMode = async (mode: string): Promise<SettingWriteResult> => {
    if (!(COMPACTION_MODES as readonly string[]).includes(mode)) return { ok: false, message: `请选择有效的压缩模式。 / compactionMode must be one of ${COMPACTION_MODES.join(', ')}` }
    const result = await writeConfig({ compactionMode: mode })
    if (result.ok) settingsChanged()
    return result
  }

  const takeoverAction = async (restoring: boolean, presetId?: string): Promise<TakeoverActionResult> => {
    if (optionalService(ctx, 'agentPresets') === undefined) {
      const outcome = await setHostEngineEnabled(pluginManagerOf(ctx), !restoring)
      settingsChanged()
      return { kind: 'host', ok: outcome.ok, outcome }
    }
    const outcome = restoring ? await takeover.restore(presetId) : await takeover.takeOver(presetId)
    settingsChanged()
    if (!outcome.ok) return { kind: 'preset', ok: false, code: outcome.code, message: outcome.message }
    return {
      kind: 'preset',
      ok: true,
      action: outcome.action,
      ...outcome.preset === undefined ? {} : { preset: outcome.preset },
      ...outcome.warning === undefined ? {} : { warning: outcome.warning },
    }
  }

  const agentReport = async (agent: Agent): Promise<AgentStatusReport> => {
    const capacity = await budgets.capacityFor(agent)
    return {
      sessionId: agent.session.id,
      subagent: agent.session.header.origin === 'subagent',
      scope: scopeOf(agent.session),
      mode: modes.refresh(agent),
      capacity,
      budget: await budgets.budgetFor(agent),
      pressure: pressureOf(agent),
    }
  }

  const episodeCounts = async (): Promise<ScopeEpisodeCounts[]> => {
    const counts: ScopeEpisodeCounts[] = []
    for (const scope of await store.listScopes()) {
      const episodes: Record<EpisodeStatus, number> = { open: 0, sealed: 0, summarized: 0, failed: 0 }
      try {
        const index = await store.readIndex(scope)
        let pinned = 0
        let hidden = 0
        for (const meta of index.episodes) {
          episodes[meta.status] += 1
          if (meta.pinned) pinned += 1
          if (meta.hidden) hidden += 1
        }
        counts.push({ scope, episodes, pinned, hidden, rollups: index.rollups.length })
      } catch (error) {
        counts.push({ scope, episodes, pinned: 0, hidden: 0, rollups: 0, error: errorMessage(error) })
      }
    }
    return counts
  }

  const takeoverReport = async (): Promise<TakeoverReport> => {
    if (optionalService(ctx, 'agentPresets') !== undefined) {
      const status = await takeover.status()
      return { kind: 'preset', editable: status.editable, presets: status.presets, ...status.error === undefined ? {} : { error: status.error } }
    }
    const manager = pluginManagerOf(ctx)
    if (manager === undefined) return { kind: 'host', editable: false, presets: [], error: '当前 profile 未提供插件管理器。 / No plugin manager is available in this profile.' }
    try {
      return { kind: 'host', editable: true, presets: [], host: await readHostEngineState(manager) }
    } catch (error) {
      return { kind: 'host', editable: true, presets: [], error: errorMessage(error) }
    }
  }

  const buildStatus = async (agent?: Agent): Promise<MemoryCloudStatus> => {
    const coexistenceReport = detectCoexistence(loadedRowNames(await listLoadedRowsDeep(ctx)))
    noteCompactionPlugins(coexistenceReport)
    const firewall = decideUnmatched(config.unmatchedSessions.get(), coexistenceReport.bridgePlugins?.map(plugin => plugin.id))
    let report: AgentStatusReport | undefined
    if (agent !== undefined) {
      try {
        report = await agentReport(agent)
      } catch (error) {
        logger.warn('status: could not describe the agent: %s', errorMessage(error))
      }
    }
    let scopesReport: ScopeEpisodeCounts[] = []
    try {
      scopesReport = await episodeCounts()
    } catch (error) {
      scopesReport = [{ scope: '*', episodes: { open: 0, sealed: 0, summarized: 0, failed: 0 }, pinned: 0, hidden: 0, rollups: 0, error: errorMessage(error) }]
    }
    let takeoverStatus: TakeoverReport
    try {
      takeoverStatus = await takeoverReport()
    } catch (error) {
      takeoverStatus = { kind: 'preset', editable: false, presets: [], error: errorMessage(error) }
    }
    return {
      storageRoot: store.root,
      ...profileName === undefined ? {} : { profile: profileName },
      configured: { level: config.level.get(), compactionMode: config.compactionMode.get(), unmatchedSessions: firewall.setting },
      firewall,
      ...report === undefined ? {} : { agent: report },
      scopes: scopesReport,
      jobs: runner.stats(),
      takeover: takeoverStatus,
      coexistence: coexistenceReport,
      registrations: { ...registrations, problems: [...registrations.problems] },
      fallbacks: [...fallbacks],
      routineFallbacks: { ...routineFallbacks },
    }
  }

  const api: MemoryCloudApi = {
    status: async (sessionId) => {
      const agent = sessionId === undefined ? undefined : agentOf(sessionId)
      return buildStatus(agent)
    },
    setLevel: level => setLevel(level).catch(error => ({ ok: false, message: errorMessage(error) })),
    setMode: mode => setMode(mode).catch(error => ({ ok: false, message: errorMessage(error) })),
    takeover: presetId => takeoverAction(false, presetId).catch(error => ({ kind: 'preset', ok: false, code: 'edit-failed', message: errorMessage(error) })),
    restore: presetId => takeoverAction(true, presetId).catch(error => ({ kind: 'preset', ok: false, code: 'edit-failed', message: errorMessage(error) })),
  }

  const service: MemoryCloudService = {
    budgetFor: (agent, hints) => budgets.budgetFor(agent, hints),
    composer,
    scopeFor: agent => scopeOf(agent.session),
    isEnabled: agent => agent !== undefined && modes.modeFor(agent).mode === 'engine',
    notifyFallback,
    api,
    setSessionTags(sessionId, values) {
      tags.set(sessionId, values)
      redescribe(sessionId)
    },
  }

  /**
   * Describe a session again after its tags or preset changed. When its
   * decision moved, injection and the composer drop the session's caches and
   * capture seals the open episode in the old scope.
   */
  const redescribe = (sessionId: string): void => {
    const before = descriptors.get(sessionId)
    descriptors.delete(sessionId)
    const session = sessionOf(sessionId)
    const after = session !== undefined
      ? describe(session)
      : before === undefined ? undefined : describeAs(sessionId, { id: sessionId, header: before })
    const previous = before === undefined ? undefined : scopes.resolve(before)
    const next = after === undefined ? undefined : scopes.resolve(after)
    if (previous !== undefined && next !== undefined && previous.scope === next.scope && previous.capture === next.capture) return
    injector.rescope(sessionId)
    composer.forget(sessionId)
    if (previous !== undefined) rescopeCapture(sessionId, previous.scope, next?.scope)
  }

  const rescopeCapture = (sessionId: string, previous: ScopeId, next: ScopeId | undefined): void => {
    const failed = (error: unknown): void => logger.warn('could not re-scope the capture of session %s: %s', sessionId, errorMessage(error))
    try {
      void capture.rescope(sessionId).then(
        () => logger.info('session %s left memory scope %s for %s; its open episode was sealed', sessionId, previous, next ?? 'a new scope'),
        failed,
      )
    } catch (error) {
      failed(error)
    }
  }

  ctx.effect(() => async () => {
    lifetime.abort()
    await runner.stop()
    await capture.dispose()
  }, 'memory-cloud runtime')

  ctx.provide(MEMORY_CLOUD_SERVICE, service)
  registerMemoryCloudRemote(ctx, api, createConfigAccess({ config, write: writeConfig, changed: settingsChanged }))

  ctx.on('session/created', session => guard('session/created', () => {
    descriptors.delete(session.id)
    describe(session)
  }))
  ctx.on('agent/created', ({ agent }) => {
    guard('agent/created', () => {
      liveAgents.set(agent.session.id, agent)
      describe(agent.session)
      const decision = modes.refresh(agent)
      logger.debug('session %s: %s mode (%s)', agent.session.id, decision.mode, decision.reason)
    })
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => guard('agent/disposed', () => {
    if (liveAgents.get(agent.session.id) === agent) liveAgents.delete(agent.session.id)
  }))
  ctx.on('session/disposed', session => guard('session/disposed', () => {
    descriptors.delete(session.id)
    tags.delete(session.id)
    selectedPresets.delete(session.id)
    composer.forget(session.id)
  }))
  ctx.on('agent-preset/selected', (sessionId, agentPreset) => guard('agent-preset/selected', () => {
    if (typeof agentPreset === 'string' && agentPreset !== '') selectedPresets.set(sessionId, agentPreset)
    redescribe(sessionId)
    const agent = agentOf(sessionId)
    if (agent === undefined) return
    const decision = modes.refresh(agent)
    logger.debug('session %s: %s mode after a preset change (%s)', sessionId, decision.mode, decision.reason)
  }))
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/end') return
    const failed = (event.data as { readonly error?: unknown } | undefined)?.error
    guard('compaction/end', () => {
      if (failed !== undefined) {
        composer.forget(session.id)
        return
      }
      const agent = agentOf(session.id)
      if (agent !== undefined) idleAttempts.set(agent, clock.now())
    })
  })
  ctx.on('session/flush', () => guard('session/flush', () => runner.kick()))
  ctx.on('loader/volatile-update', () => guard('settings update', () => {
    settingsChanged()
    logger.info('settings updated (level %d, compaction mode %s)', config.level.get(), config.compactionMode.get())
  }))

  attachCaptureToDsh(ctx, capture, { describe, idleCheckIntervalMs: IDLE_CHECK_INTERVAL_MS })

  const injector = createInjector<Agent>({
    async recallEvents(agent, scope, query, signal) {
      const entries = await events.list(scope)
      if (entries.length === 0 || signal.aborted) return undefined
      const ranked = rankEventMemories(entries, query)
      if (ranked.length === 0) return undefined
      const budget = await budgets.budgetFor(agent)
      const allowed = recallPolicy(pressureOf(agent), Math.min(MAX_EVENT_RECALL_TOKENS, budget.recallLimitTokens))
      if (signal.aborted || allowed.kind === 'refuse') return undefined
      return renderEventRecall(agent.session, scope, ranked, Math.min(allowed.capTokens, budget.memoryBudgetTokens), estimator)
    },
    pack: async ({ agent, session, scope, atSeq, eventTokens, signal }) => {
      const resolved = await budgets.budgetFor(agent)
      if (signal.aborted) return null
      const budget = { ...resolved, memoryBudgetTokens: Math.max(0, resolved.memoryBudgetTokens - eventTokens) }
      const input = await sources.load(scope.scope, { excludeOpenOf: session.sessionId })
      if (signal.aborted) return null
      const packed = packer.pack({ ...input, budget, mode: 'session-start', halfLifeDays: config.halfLifeDays.get(), now: clock.now() })
      if (packed.text.trim().length === 0) return null
      try {
        const snapshotRef = await store.writeSnapshot(scope.scope, { sessionId: session.sessionId, n: atSeq }, packed.text)
        return { text: packed.text, snapshotRef }
      } catch (error) {
        logger.warn('could not write the memory snapshot for session %s: %s', session.sessionId, errorMessage(error))
        return { text: packed.text }
      }
    },
    mode: agent => modes.modeFor(agent).mode,
    scopeFor: (_descriptor, agent) => scopeOf(agent.session),
    clock,
    logger,
  })
  attachInjector(ctx, injector, { usageSection: buildUsageSection('zh') })

  try {
    registerMemoryTools(ctx, {
      store,
      notes,
      events,
      search: createMemorySearch({ store, estimator }),
      estimator,
      clock,
      logger,
      scopeFor: agent => scopeOf(agent.session),
      pressure: agent => pressureOf(agent),
      recallLimitTokens: agent => budgets.budgetNow(agent).recallLimitTokens,
    })
    registrations.tools = true
  } catch (error) {
    const message = errorMessage(error)
    registrations.problems.push(`回忆工具注册失败。请检查共存提示中的同名工具。 / Recall tool registration failed. Check for duplicate tool names. ${message}`)
    logger.warn('memory tools were not registered: %s', message)
  }

  const commandDeps: MemoryCommandDeps = {
    status: agent => buildStatus(agent),
    setLevel,
    setMode,
    compactNow: async (agent, signal): Promise<CommandOutcome> => {
      const engine = compactionServiceOf(ctx, agent)
      if (!hasMethod(engine, 'compactNow')) return { ok: false, text: '这个会话没有可手动运行的压缩引擎。用 /memory status 查看当前模式。' }
      const result = await (engine as unknown as CompactionServiceLike).compactNow(agent, signal)
      if (result === null) return { ok: true, text: '这一次，上下文留在原位。压缩引擎没有替换任何节点。' }
      return { ok: true, text: `检查点已就位。它接替了 ${result.shadowedSeqs.length} 个上下文节点（约 ${result.shadowedTokenCount} tokens）。` }
    },
    summarizeNow: async (agent): Promise<CommandOutcome> => {
      await capture.sealSession(agent.session.id, 'idle')
      const queued = await runner.rescan({ retryExhausted: true })
      runner.kick({ force: true })
      return { ok: true, text: `已检查当前会话尾部。后台总结队列新收到 ${queued} 项，当前共有 ${runner.stats().queue.length} 项。用 /memory status 查看处理进度。` }
    },
    rebuild: async (agent): Promise<CommandOutcome> => {
      const scope = scopeOf(agent.session).scope
      const budget = await budgets.levelBudget()
      let queued = 0
      for (const meta of (await store.readIndex(scope)).episodes) {
        if (meta.status !== 'summarized') continue
        await store.updateEpisode(scope, meta.id, { status: 'sealed', lastError: undefined, attempts: undefined })
        if (await runner.enqueueSummarize(scope, meta.id)) queued += 1
      }
      runner.kick({ force: true })
      return {
        ok: true,
        text: `重新总结队列已收到作用域 ${scope} 的 ${queued} 个片段。每段的目标是摘要 ${budget.recentSummaryTokens} tokens、总结 ${budget.gistTokens} tokens，每日配额 ${jobOptions.dailyQuota} 次。新文本写好前，旧文本继续值班。`,
      }
    },
    takeover: presetId => takeoverAction(false, presetId),
    restore: presetId => takeoverAction(true, presetId),
    backfill: async (): Promise<CommandOutcome> => ({
      ok: false,
      text: `/memory backfill 尚未实现，旧会话没有导入。导入需要 ctx.sessionQuery 读取历史日志。${optionalService(ctx, 'sessionQuery') === undefined ? '当前 profile 也没有提供这项服务。' : ''}安装后，符合捕获规则的新会话会自动存档。`,
    }),
  }
  try {
    registerMemoryCommand(ctx, commandDeps)
    registrations.command = true
  } catch (error) {
    const message = errorMessage(error)
    registrations.problems.push(`/memory 注册失败。请检查其他插件是否已注册同名命令。 / Command registration failed. Check for another plugin that registers /memory. ${message}`)
    logger.warn('/memory was not registered: %s', message)
  }

  const idleRunning = new WeakSet<Agent>()
  const consolidate = (agent: Agent): void => {
    if (lifetime.signal.aborted || agent.session.header.origin === 'subagent') return
    if (modes.modeFor(agent).mode === 'off' || idleRunning.has(agent)) return
    const last = idleAttempts.get(agent)
    if (last !== undefined && clock.now() - last < IDLE_COMPACT_DEBOUNCE_MS) return
    if (!(pressureOf(agent) > config.idleCompactRatio.get())) return
    if (maxCheckpointChars(compactableTokens(agent.session)) < MIN_CHECKPOINT_CHARS) return
    const engine = compactionServiceOf(ctx, agent)
    if (!hasMethod(engine, 'compactNow')) return
    idleAttempts.set(agent, clock.now())
    idleRunning.add(agent)
    let running: Promise<unknown>
    try {
      running = Promise.resolve((engine as unknown as CompactionServiceLike).compactNow(agent, lifetime.signal))
    } catch (error) {
      idleRunning.delete(agent)
      logger.debug('idle consolidation of %s did not start: %s', agent.session.id, errorMessage(error))
      return
    }
    void running
      .then(
        result => logger.info('idle consolidation of session %s %s', agent.session.id, result === null ? 'found nothing to compact' : 'compacted the context'),
        error => logger.debug('idle consolidation of session %s failed: %s', agent.session.id, errorMessage(error)),
      )
      .catch(() => {})
      .finally(() => idleRunning.delete(agent))
  }
  const idleTimers = new Map<Agent, ReturnType<typeof setTimeout>>()
  const cancelIdle = (agent: Agent): void => {
    const timer = idleTimers.get(agent)
    if (timer === undefined) return
    clearTimeout(timer)
    idleTimers.delete(agent)
  }
  ctx.on('agent/status', ({ agent, status }) => guard('idle consolidation', () => {
    cancelIdle(agent)
    if (status !== 'idle' || lifetime.signal.aborted) return
    const timer = setTimeout(() => {
      idleTimers.delete(agent)
      guard('idle consolidation', () => consolidate(agent))
    }, idleQuietMs)
    ;(timer as { unref?: () => void }).unref?.()
    idleTimers.set(agent, timer)
  }))
  ctx.on('agent/disposed', ({ agent }) => cancelIdle(agent))
  ctx.effect(() => () => {
    for (const timer of idleTimers.values()) clearTimeout(timer)
    idleTimers.clear()
  }, 'memory-cloud idle consolidation')

  ctx.inject(['sessionLogDeepSeek'], (sub) => {
    guard('session-log upload exclusion', () => {
      sub.sessionLogDeepSeek.registerExclusion(request => request.purpose === SUMMARIZE_PURPOSE)
    })
  })

  ctx.effect(() => {
    const timer = setTimeout(() => {
      if (optionalService(ctx, 'agentPresets') === undefined) return
      void takeover.refreshAfterUpgrade()
        .then((outcomes) => {
          for (const outcome of outcomes) {
            if (outcome.action === 'reapplied') logger.info('re-applied the memory engine takeover of preset %s after an upgrade', outcome.presetId ?? outcome.entryId)
            if (outcome.action === 'failed') logger.warn('could not refresh the takeover of preset %s: %s', outcome.presetId ?? outcome.entryId, outcome.detail ?? outcome.code ?? 'unknown error')
          }
        })
        .catch((error: unknown) => logger.warn('takeover refresh failed: %s', errorMessage(error)))
    }, TAKEOVER_REFRESH_DELAY_MS)
    ;(timer as { unref?: () => void }).unref?.()
    return () => clearTimeout(timer)
  }, 'memory-cloud takeover refresh')

  guard('existing agents', () => {
    for (const agent of agentRegistryOf(ctx)?.list() ?? []) {
      if (!liveAgents.has(agent.session.id)) liveAgents.set(agent.session.id, agent)
      describe(agent.session)
    }
  })

  void runner.start()
  void budgets.levelBudget()
    .then(() => {
      if (!rollupPlanningDeferred || lifetime.signal.aborted || budgets.levelBudgetKnown() === undefined) return
      rollupPlanningDeferred = false
      return runner.rescan()
    })
    .catch((error: unknown) => logger.warn('could not plan rollups once the model was known: %s', errorMessage(error)))
  void capture.sealStale()
  void refreshDeepRows()

  return { service, store, capture, runner, composer, injector, summaries, budgets, modes }
}

function regionWithin(meta: EpisodeMeta): boolean {
  const seqs = meta.shadowedSeqs
  if (seqs === undefined || seqs.length === 0) return true
  return Math.min(...seqs) >= meta.seqRange.first
}
