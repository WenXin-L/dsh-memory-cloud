import { describe, expect, it } from 'vitest'
import {
  ENGINE_ROW,
  HOST_ENGINE_ROW,
  readHostEngineState,
  setHostEngineEnabled,
  type PluginChangeLike,
  type PluginManagerLike,
  type PluginRowLike,
} from '../../src/engine/index.ts'

interface FakeOptions {
  readonly engineRow?: boolean
  readonly hmr?: boolean
  readonly fail?: (id: string, enabled: boolean) => PluginChangeLike | Error | undefined
}

function fakeManager(options: FakeOptions = {}) {
  const rows: PluginRowLike[] = [
    { entryId: 'include:compaction-basic', moduleName: '@deepseek-ai/dsh-compaction-basic', enabled: true, patchId: 'compaction-basic' },
    { entryId: 'include:command-compact', moduleName: '@deepseek-ai/dsh-command-compact', enabled: true, patchId: 'command-compact' },
    ...options.engineRow === false ? [] : [{ entryId: `include:${ENGINE_ROW.id}`, moduleName: ENGINE_ROW.name, enabled: false, patchId: ENGINE_ROW.id }],
  ]
  const calls: [string, boolean][] = []
  const manager: PluginManagerLike = {
    listPlugins: async () => rows.map(row => ({ ...row })),
    async setPluginEnabled(id, enabled) {
      calls.push([id, enabled])
      const failure = options.fail?.(id, enabled)
      if (failure instanceof Error) throw failure
      if (failure !== undefined) return failure
      const index = rows.findIndex(row => row.entryId === id)
      rows[index] = { ...rows[index]!, enabled }
      return options.hmr === true
        ? { changed: true, application: 'applied' }
        : { changed: true, application: 'restart-required', restartReason: 'no-hmr' }
    },
  }
  return { manager, calls, rows }
}

describe('setHostEngineEnabled', () => {
  it('disables compaction-basic before enabling the engine and reports restart-required', async () => {
    const { manager, calls } = fakeManager()
    const outcome = await setHostEngineEnabled(manager, true)
    expect(calls).toEqual([['include:compaction-basic', false], [`include:${ENGINE_ROW.id}`, true]])
    expect(outcome).toMatchObject({ ok: true, application: 'restart-required', restartReasons: ['no-hmr'] })
    expect(outcome.message).toMatch(/重启 DSH 后生效.*Restart DSH/)
    expect(await readHostEngineState(manager)).toMatchObject({ active: true })
  })

  it('reverses the order when handing compaction back', async () => {
    const { manager, calls } = fakeManager({ hmr: true })
    await setHostEngineEnabled(manager, true)
    calls.length = 0
    const outcome = await setHostEngineEnabled(manager, false)
    expect(calls).toEqual([[`include:${ENGINE_ROW.id}`, false], ['include:compaction-basic', true]])
    expect(outcome).toMatchObject({ ok: true, application: 'applied', restartReasons: [] })
    expect(await readHostEngineState(manager)).toMatchObject({ active: false })
  })

  it('does nothing when the rows already match', async () => {
    const { manager, calls } = fakeManager()
    expect(await setHostEngineEnabled(manager, false)).toMatchObject({ ok: true, application: 'unchanged', steps: [] })
    expect(calls).toEqual([])
    await setHostEngineEnabled(manager, true)
    expect(await setHostEngineEnabled(manager, true)).toMatchObject({ application: 'unchanged', steps: [], message: expect.stringContaining('already selected') })
  })

  it('does not name compaction-basic as the replacement when the profile has no such row', async () => {
    const { manager, rows } = fakeManager({ hmr: true })
    rows.splice(rows.findIndex(row => row.patchId === 'compaction-basic'), 1)
    await setHostEngineEnabled(manager, true)
    for (const application of ['applied', 'unchanged']) {
      const result = await setHostEngineEnabled(manager, false)
      expect(result).toMatchObject({ ok: true, application })
      expect(result.message).toMatch(/记忆引擎已停用.*engine is disabled/)
      expect(result.message).not.toContain('compaction-basic')
    }
  })

  it('rolls the first step back when the engine cannot be enabled', async () => {
    const { manager, calls, rows } = fakeManager({
      fail: (id, enabled) => id.endsWith(ENGINE_ROW.id) && enabled ? { changed: false, application: 'failed', error: { code: 'operation-error', diagnostic: 'module not found' } } : undefined,
    })
    const outcome = await setHostEngineEnabled(manager, true)
    expect(calls).toEqual([['include:compaction-basic', false], [`include:${ENGINE_ROW.id}`, true], ['include:compaction-basic', true]])
    expect(outcome.ok).toBe(false)
    expect(outcome.application).toBe('failed')
    expect(outcome.message).toContain('module not found')
    expect(outcome.steps.at(-1)).toMatchObject({ row: 'compaction-basic', enabled: true, rollback: true })
    expect(rows.find(row => row.patchId === 'compaction-basic')?.enabled).toBe(true)
  })

  it('treats a higher-layer override as a failure and rolls back', async () => {
    const { manager } = fakeManager({
      fail: (id, enabled) => id.endsWith('compaction-basic') && !enabled ? { changed: true, application: 'overridden' } : undefined,
    })
    const outcome = await setHostEngineEnabled(manager, true)
    expect(outcome).toMatchObject({ ok: false, application: 'overridden' })
    expect(outcome.steps).toHaveLength(1)
  })

  it('reports thrown errors, a missing engine row, and a missing plugin manager', async () => {
    const throwing = fakeManager({ fail: () => new Error('lock timeout') })
    expect(await setHostEngineEnabled(throwing.manager, true)).toMatchObject({ ok: false, application: 'failed', message: expect.stringContaining('lock timeout') })

    const missing = fakeManager({ engineRow: false })
    expect(await setHostEngineEnabled(missing.manager, true)).toMatchObject({ ok: false, message: expect.stringContaining(HOST_ENGINE_ROW.id) })
    expect(missing.calls).toEqual([])

    expect(await setHostEngineEnabled(undefined, true)).toMatchObject({ ok: false, application: 'failed' })
    const unlistable: PluginManagerLike = { listPlugins: () => Promise.reject(new Error('no inventory')), setPluginEnabled: () => Promise.reject(new Error('unused')) }
    expect(await setHostEngineEnabled(unlistable, true)).toMatchObject({ ok: false, message: expect.stringContaining('no inventory') })
  })

  it('finds the shipped host row by its separator-free id', async () => {
    const { manager, calls, rows } = fakeManager({ engineRow: false })
    rows.push({ entryId: HOST_ENGINE_ROW.id, moduleName: ENGINE_ROW.name, enabled: false, patchId: HOST_ENGINE_ROW.id })
    expect(HOST_ENGINE_ROW.id).not.toContain(':')
    const outcome = await setHostEngineEnabled(manager, true)
    expect(outcome.ok).toBe(true)
    expect(calls).toEqual([['include:compaction-basic', false], [HOST_ENGINE_ROW.id, true]])
  })

  it('refuses read-only rows without calling the manager', async () => {
    const { manager, calls, rows } = fakeManager()
    rows[0] = { ...rows[0]!, readOnlyReason: 'management-required' }
    const outcome = await setHostEngineEnabled(manager, true)
    expect(outcome).toMatchObject({ ok: false, application: 'failed', message: expect.stringContaining('read-only') })
    expect(calls).toEqual([])
  })
})
