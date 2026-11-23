import { describe, expect, it, vi } from 'vitest'
import { Config } from '../../src/config.ts'
import type { ConfigEditorLike } from '../../src/engine/index.ts'
import {
  configEdits,
  configPatchProblem,
  createConfigAccess,
  createConfigWriter,
  mergeConfigPatch,
  readVolatileConfig,
  rowIdOf,
} from '../../src/runtime/settings.ts'
import { volatileConfig } from '../client/fixtures.ts'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function editorFor(config: Record<string, unknown>, edited: unknown[]): ConfigEditorLike {
  const ours = { options: { id: 'dsh-memory-cloud-brain', name: 'dsh-memory-cloud-brain', config } }
  return {
    entries: () => [{ options: { id: 'other', name: 'other' } }, ours],
    configuration: () => [],
    edit: async (entry: typeof ours, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => {
      edited.push([entry.options.id, change(structuredClone(entry.options.config), {})])
    },
  } as unknown as ConfigEditorLike
}

describe('rowIdOf', () => {
  it('uses the row options id, not the nested tree path of a bundle-inserted row', () => {
    const entry = { id: 'include:dsh-memory-cloud-brain', options: { id: 'dsh-memory-cloud-brain' } }
    expect(rowIdOf(entry, 'fallback')).toBe('dsh-memory-cloud-brain')
  })

  it('falls back when the plugin runs outside a Loader entry', () => {
    expect(rowIdOf(undefined, 'dsh-memory-cloud-brain')).toBe('dsh-memory-cloud-brain')
    expect(rowIdOf({ options: {} }, 'dsh-memory-cloud-brain')).toBe('dsh-memory-cloud-brain')
  })
})

describe('createConfigWriter', () => {
  it('writes the settings namespace the row id names', async () => {
    const update = vi.fn(async () => {})
    const write = createConfigWriter({ rowId: rowIdOf({ options: { id: 'dsh-memory-cloud-brain' } }, 'x'), settings: () => ({ update }), configEditor: () => undefined })
    await expect(write({ level: 5 })).resolves.toEqual({ ok: true, via: 'settings' })
    expect(update).toHaveBeenCalledWith('dsh-memory-cloud-brain', { level: 5 })
  })

  it('edits the config-editor entry whose options id matches when settings is absent', async () => {
    const edited: unknown[] = []
    const ours = { options: { id: 'dsh-memory-cloud-brain', name: 'dsh-memory-cloud-brain', config: { level: 3 } } }
    const editor = {
      entries: () => [{ options: { id: 'other', name: 'other' } }, ours],
      configuration: () => ({}),
      edit: async (entry: typeof ours, change: (current: Record<string, unknown>) => Record<string, unknown>) => {
        edited.push([entry.options.id, change(entry.options.config)])
      },
    } as unknown as ConfigEditorLike
    const write = createConfigWriter({ rowId: 'dsh-memory-cloud-brain', settings: () => undefined, configEditor: () => editor })
    await expect(write({ level: 5 })).resolves.toEqual({ ok: true, via: 'config-editor' })
    expect(edited).toEqual([['dsh-memory-cloud-brain', { level: 5 }]])
  })

  it('replaces objects through settings.mutate, which a deep-merging update cannot do', async () => {
    const update = vi.fn(async () => {})
    const mutate = vi.fn(async () => {})
    const write = createConfigWriter({ rowId: 'dsh-memory-cloud-brain', settings: () => ({ update, mutate }), configEditor: () => undefined })
    const edits = configEdits({ summarizer: { model: 'm' }, overrides: { gistTokens: 40 }, idleMinutes: 5 })
    await expect(write(edits)).resolves.toEqual({ ok: true, via: 'settings' })
    expect(mutate).toHaveBeenCalledWith('dsh-memory-cloud-brain', [
      { op: 'set', path: ['summarizer', 'model'], value: 'm' },
      { op: 'set', path: ['overrides'], value: { gistTokens: 40 } },
      { op: 'set', path: ['idleMinutes'], value: 5 },
    ])
    await write(configEdits({ summarizer: { provider: 'p' }, scopeRules: [] }))
    expect(update).toHaveBeenCalledWith('dsh-memory-cloud-brain', { summarizer: { provider: 'p' }, scopeRules: [] })
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('merges path edits into the whole row config on the config-editor path', async () => {
    const edited: unknown[] = []
    const current = { storageRoot: '/data', level: 2, summarizer: { provider: 'deepseek', model: 'old' }, overrides: { retainTokens: 1, gistTokens: 2 } }
    const write = createConfigWriter({ rowId: 'dsh-memory-cloud-brain', settings: () => undefined, configEditor: () => editorFor(current, edited) })
    await expect(write(configEdits({ summarizer: { model: 'new' }, overrides: { gistTokens: 9 } }))).resolves.toEqual({ ok: true, via: 'config-editor' })
    expect(edited).toEqual([['dsh-memory-cloud-brain', {
      storageRoot: '/data',
      level: 2,
      summarizer: { provider: 'deepseek', model: 'new' },
      overrides: { gistTokens: 9 },
    }]])
  })

  it('reports write failures instead of throwing', async () => {
    const write = createConfigWriter({ rowId: 'r', settings: () => ({ update: async () => { throw new Error('overridden by a home patch') } }), configEditor: () => undefined })
    await expect(write({ level: 1 })).resolves.toEqual({ ok: false, message: 'overridden by a home patch' })
    const none = createConfigWriter({ rowId: 'r', settings: () => undefined, configEditor: () => undefined })
    await expect(none({ level: 1 })).resolves.toMatchObject({ ok: false })
  })
})

describe('live settings', () => {
  it('reads plain values; the schema defaults match the client fixture', () => {
    const defaults = readVolatileConfig(Config({}))
    expect(defaults).toEqual(volatileConfig())
    const config = Config({ overrides: { gistTokens: 3 }, scopeRules: [{ match: 'a', scope: 'b' }], summarizer: { provider: 'p' } })
    expect(readVolatileConfig(config)).toMatchObject({ overrides: { gistTokens: 3 }, scopeRules: [{ match: 'a', scope: 'b' }], summarizer: { provider: 'p', model: 'deepseek-flash', reasoningEffort: 'off' } })
  })

  it('merges summarizer fields and replaces every other field', () => {
    const current = volatileConfig({ overrides: { retainTokens: 1, gistTokens: 2 }, scopeRules: [{ match: 'a', scope: 'b' }] })
    expect(mergeConfigPatch(current, { summarizer: { model: 'm' }, overrides: { gistTokens: 5 }, scopeRules: [] })).toEqual({
      ...current,
      summarizer: { provider: '', model: 'm', reasoningEffort: 'off' },
      overrides: { gistTokens: 5 },
      scopeRules: [],
    })
    expect(configEdits({ level: 4, summarizer: { provider: '', reasoningEffort: 'high' } })).toEqual([
      { path: ['level'], value: 4 },
      { path: ['summarizer', 'provider'], value: '' },
      { path: ['summarizer', 'reasoningEffort'], value: 'high' },
    ])
  })

  it('rejects fields the schema does not declare live and values it refuses', () => {
    const current = volatileConfig()
    const problem = (patch: unknown) => configPatchProblem(current, patch as never)
    expect(problem({ idleMinutes: 2, overrides: { gistTokens: 1 }, scopeRules: [{ match: 'a:*', scope: 'x-$1' }] })).toBeUndefined()
    expect(problem({ storageRoot: '/x' })).toBe('"storageRoot" cannot be changed live; edit the profile cordis.patch.yml and restart')
    expect(problem({ bogus: 1 })).toBe('unknown setting "bogus"')
    expect(problem({ summarizer: { temperature: 1 } })).toBe('unknown setting "summarizer.temperature"')
    expect(problem({ overrides: { thresholdRatio: 1 } })).toBe('unknown setting "overrides.thresholdRatio"')
    expect(problem({ scopeRules: [{ match: 'a', scope: 'b', extra: 1 }] })).toBe('unknown setting "scopeRules[0].extra"')
    expect(problem({ idleCompactRatio: 1.5 })).toBe('$.idleCompactRatio expected number <= 1 but got 1.5')
    expect(problem({ halfLifeDays: 0.05 })).toBe('$.halfLifeDays expected number >= 0.1 but got 0.05')
    expect(problem({ overrides: { gistTokens: 2.5 } })).toBe('$.overrides.gistTokens expected number multiple of 1 but got 2.5')
    expect(problem({ scopeRules: [{ match: 'a', scope: '' }] })).toBe('scopeRules[0].scope must not be empty')
  })

  it('validates unmatchedSessions and scope templates that need more captures than the pattern has', () => {
    const current = volatileConfig()
    const problem = (patch: unknown) => configPatchProblem(current, patch as never)
    for (const value of ['auto', 'owner', 'isolated']) expect(problem({ unmatchedSessions: value }), value).toBeUndefined()
    expect(problem({ unmatchedSessions: 'public' })).toMatch(/unmatchedSessions/)
    expect(problem({ scopeRules: [{ match: 'qqbot:*:group', scope: 'qq-group-$2' }] })).toBe('scopeRules[0].scope uses $2 but the pattern has 1 wildcard(s)')
    expect(problem({ scopeRules: [{ match: 'qqbot:*:group:*', scope: 'qq-group-$2' }, { match: 'lit\\*', scope: 'x-$1' }] })).toBe('scopeRules[1].scope uses $1 but the pattern has 0 wildcard(s)')
    expect(problem({ scopeRules: [{ match: 'room', scope: 'r-$&-$$' }] })).toBeUndefined()
  })

  it('writes valid patches, then reports the change; invalid ones never reach the writer', async () => {
    const config = Config({})
    const write = vi.fn(async (edits: unknown) => {
      for (const { path, value } of edits as { path: string[]; value: unknown }[]) {
        const ref = path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], config) as Record<symbol, (value: unknown) => void>
        ref[VOLATILE_WRITE]?.(value)
      }
      return { ok: true, via: 'settings' } as const
    })
    const changed = vi.fn()
    const access = createConfigAccess({ config, write, changed })
    expect(access.get()).toEqual({ config: volatileConfig(), defaults: volatileConfig() })
    await expect(access.set({ summarizer: { model: 'deepseek-chat' }, overrides: { gistTokens: 30 } })).resolves.toEqual({ ok: true, via: 'settings' })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(access.get().config).toMatchObject({ summarizer: { provider: '', model: 'deepseek-chat' }, overrides: { gistTokens: 30 } })
    await expect(access.set({ idleMinutes: -1 })).resolves.toEqual({ ok: false, message: '$.idleMinutes expected number >= 1 but got -1' })
    write.mockResolvedValueOnce({ ok: false, message: 'locked' } as never)
    await expect(access.set({ idleMinutes: 3 })).resolves.toEqual({ ok: false, message: 'locked' })
    expect(write).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
