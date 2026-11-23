import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  configHash,
  createTakeoverController,
  ENGINE_ROW,
  hasCompactionGroup,
  isTakenOver,
  releasePreset,
  sameConfig,
  takeOverPreset,
  type ConfigEditorEntryLike,
  type ConfigEditorLike,
  type TakeoverRecords,
  type TakeoverStateStore,
} from '../../src/engine/index.ts'

type Assignable<T extends ConfigEditorLike> = T
export type RealConfigEditorFits = Assignable<ConfigEditor>

type Json = Record<string, unknown>
interface PresetFixture { id: string; name: string; config: Json }

function fixture(name: string): PresetFixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.preset.json`, import.meta.url), 'utf8')) as PresetFixture
}

function compactionGroup(config: Json): Json & { config: Json[] } {
  const plugins = config['plugins'] as Json[]
  return plugins.find(row => row['id'] === 'compaction') as Json & { config: Json[] }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

describe('preset transforms (shipped standard.patch.yml)', () => {
  const standard = deepFreeze(fixture('standard').config)

  it('mounts the engine first and disables compaction-basic, leaving every other row intact', () => {
    expect(hasCompactionGroup(standard)).toBe(true)
    expect(isTakenOver(standard)).toBe(false)

    const taken = takeOverPreset(standard)

    expect(isTakenOver(taken)).toBe(true)
    expect(compactionGroup(taken)).toEqual({
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: ENGINE_ROW.id, name: ENGINE_ROW.name },
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
      ],
    })
    const others = (rows: Json) => (rows['plugins'] as Json[]).filter(row => row['id'] !== 'compaction')
    expect(others(taken)).toEqual(others(standard))
    expect(taken['id']).toBe('standard')
    expect(taken['order']).toBe(1)
    expect(JSON.stringify(taken)).toContain('"__jsExpr":"process.platform === \'win32\'"')
  })

  it('is idempotent and exactly reversible', () => {
    const taken = takeOverPreset(standard)
    expect(takeOverPreset(taken)).toEqual(taken)
    expect(isDeepStrictEqual(releasePreset(taken), standard)).toBe(true)
    expect(releasePreset(standard)).toEqual(standard)
  })

  it('keeps an existing engine row config and re-enables it', () => {
    const custom = takeOverPreset(standard)
    const group = compactionGroup(custom)
    const edited = {
      ...custom,
      plugins: (custom['plugins'] as Json[]).map(row => row !== group ? row : {
        ...group,
        config: [...group.config.slice(1), { ...group.config[0], disabled: true, config: { composeTimeoutMs: 5000 } }],
      }),
    }
    expect(isTakenOver(edited)).toBe(false)
    const retaken = takeOverPreset(edited)
    expect(compactionGroup(retaken).config[0]).toEqual({ id: ENGINE_ROW.id, name: ENGINE_ROW.name, config: { composeTimeoutMs: 5000 } })
    expect(compactionGroup(retaken).config.filter(row => row['id'] === ENGINE_ROW.id)).toHaveLength(1)
  })

  it('handles the minimal preset, whose group isolates only compaction', () => {
    const minimal = deepFreeze(fixture('minimal').config)
    const taken = takeOverPreset(minimal)
    expect(compactionGroup(taken).config).toEqual([
      { id: ENGINE_ROW.id, name: ENGINE_ROW.name },
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
    ])
    expect(isDeepStrictEqual(releasePreset(taken), minimal)).toBe(true)
  })

  it('leaves configs without a compaction group alone', () => {
    const plain = { id: 'bare', plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }] }
    expect(hasCompactionGroup(plain)).toBe(false)
    expect(takeOverPreset(plain)).toEqual(plain)
    expect(takeOverPreset({ id: 'x' })).toEqual({ id: 'x' })
    expect(isTakenOver(undefined)).toBe(false)
  })

  it('hashes configs independent of key order and undefined keys', () => {
    expect(configHash({ a: 1, b: { c: [1, 2], d: undefined } })).toBe(configHash({ b: { c: [1, 2] }, a: 1 }))
    expect(configHash({ a: [1, 2] })).not.toBe(configHash({ a: [2, 1] }))
    expect(sameConfig(standard, structuredClone(standard))).toBe(true)
  })
})

interface FakeRow {
  id: string
  name: string
  shipped: Json
  override?: Json | undefined
}

/** Mirrors `ConfigEditor`: composed current = override ?? shipped, entries are replaced on reload, equal-to-inherited removes the override. */
function fakeEditor(rows: FakeRow[]) {
  const cache = new Map<string, ConfigEditorEntryLike>()
  const blocked = new Set<string>()
  const entryOf = (row: FakeRow): ConfigEditorEntryLike => {
    let entry = cache.get(row.id)
    if (entry === undefined) {
      entry = { options: { id: row.id, name: row.name, config: structuredClone(row.override ?? row.shipped) } }
      cache.set(row.id, entry)
    }
    return entry
  }
  let edits = 0
  const editor: ConfigEditorLike = {
    entries: () => rows.map(entryOf),
    configuration: () => rows.map(row => ({ entry: entryOf(row), inherited: structuredClone(row.shipped), override: structuredClone(row.override ?? {}) })),
    async edit(entry, change) {
      const row = rows.find(candidate => candidate.id === entry.options.id)
      if (row === undefined || cache.get(row.id) !== entry) throw new Error('Configuration entry is no longer available')
      const next = change(structuredClone(row.override ?? row.shipped), structuredClone(row.shipped))
      if (blocked.has(row.id)) throw new Error(`Configuration for "${row.id}" is overridden by a home patch or command-line overlay`)
      row.override = isDeepStrictEqual(next, row.shipped) ? undefined : structuredClone(next)
      cache.delete(row.id)
      edits++
    },
  }
  return {
    editor,
    blocked,
    edits: () => edits,
    reload: () => cache.clear(),
  }
}

function presetRow(name: 'standard' | 'minimal'): FakeRow {
  const preset = fixture(name)
  return { id: preset.id, name: preset.name, shipped: preset.config }
}

function upgrade(config: Json): Json {
  const next = structuredClone(config)
  const group = compactionGroup(next)
  const pruner = group.config.find(row => row['id'] === 'tool-result-pruner')
  if (pruner !== undefined) pruner['config'] = { thresholdChars: 16384, headChars: 4096, tailChars: 1024 }
  ;(next['plugins'] as Json[]).push({ id: 'tool-new', name: '@deepseek-ai/dsh-tool-new' })
  return next
}

describe('createTakeoverController', () => {
  let dir: string
  let statePath: string
  let state: TakeoverStateStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-memory-takeover-'))
    statePath = join(dir, 'takeover.json')
    state = {
      async get() {
        try {
          return JSON.parse(await readFile(statePath, 'utf8')) as TakeoverRecords
        } catch {
          return undefined
        }
      },
      async set(records) {
        await writeFile(statePath, JSON.stringify(records))
      },
    }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function profile() {
    const standard = presetRow('standard')
    const minimal = presetRow('minimal')
    const ours: FakeRow = { id: 'dsh-memory-cloud-brain', name: 'dsh-memory-cloud-brain', shipped: { level: 3 } }
    const fake = fakeEditor([ours, standard, minimal])
    const controller = createTakeoverController({ configEditor: () => fake.editor, state, now: () => 1_000 })
    return { fake, controller, standard, minimal }
  }

  it('reports every preset and takes the standard one over reversibly', async () => {
    const { controller, standard } = profile()
    expect(await controller.status()).toEqual({
      editable: true,
      presets: [
        { entryId: 'preset-standard', presetId: 'standard', state: 'available', recorded: false },
        { entryId: 'preset-minimal', presetId: 'minimal', state: 'available', recorded: false },
      ],
    })

    const applied = await controller.takeOver()
    expect(applied).toEqual({ ok: true, action: 'applied', preset: { entryId: 'preset-standard', presetId: 'standard', state: 'active', recorded: true } })
    expect(standard.override).toEqual(takeOverPreset(standard.shipped))
    const records = await state.get()
    expect(records?.['preset-standard']).toEqual({
      entryId: 'preset-standard',
      presetId: 'standard',
      inheritedHash: configHash(standard.shipped),
      takeoverHash: configHash(takeOverPreset(standard.shipped)),
      at: 1_000,
    })

    expect(await controller.takeOver('standard')).toMatchObject({ ok: true, action: 'unchanged' })

    const restored = await controller.restore()
    expect(restored).toEqual({ ok: true, action: 'restored', preset: { entryId: 'preset-standard', presetId: 'standard', state: 'available', recorded: false } })
    expect(standard.override).toBeUndefined()
    expect(await state.get()).toEqual({})
    expect(await controller.restore()).toMatchObject({ ok: true, action: 'unchanged' })
  })

  it('takes over other presets with a compaction group', async () => {
    const { controller, minimal } = profile()
    expect(await controller.takeOver('minimal')).toMatchObject({ ok: true, action: 'applied', preset: { state: 'active' } })
    expect(isTakenOver(minimal.override)).toBe(true)
  })

  it('re-applies an untouched takeover after DSH ships a new preset revision', async () => {
    const { controller, standard, fake } = profile()
    await controller.takeOver()
    standard.shipped = upgrade(standard.shipped)
    fake.reload()

    expect((await controller.status()).presets[0]).toMatchObject({ state: 'outdated', recorded: true })
    expect(await controller.refreshAfterUpgrade()).toEqual([{ entryId: 'preset-standard', presetId: 'standard', action: 'reapplied' }])
    expect(standard.override).toEqual(takeOverPreset(standard.shipped))
    expect(JSON.stringify(standard.override)).toContain('tool-new')
    expect((await state.get())?.['preset-standard']?.inheritedHash).toBe(configHash(standard.shipped))
    expect((await controller.status()).presets[0]).toMatchObject({ state: 'active' })
    expect(await controller.refreshAfterUpgrade()).toEqual([{ entryId: 'preset-standard', presetId: 'standard', action: 'unchanged' }])
  })

  it('re-applies an untouched takeover written by an older plugin version while the shipped preset is unchanged', async () => {
    const { controller, standard, fake } = profile()
    const older = takeOverPreset(standard.shipped)
    const engine = compactionGroup(older).config.find(row => row['id'] === ENGINE_ROW.id)!
    engine['config'] = { composeTimeoutMs: 45_000 }
    standard.override = older
    fake.reload()
    await state.set({ 'preset-standard': { entryId: 'preset-standard', presetId: 'standard', inheritedHash: configHash(standard.shipped), takeoverHash: configHash(older), at: 1 } })

    expect((await controller.status()).presets[0]).toMatchObject({ state: 'outdated', recorded: true })
    expect(await controller.refreshAfterUpgrade()).toEqual([{ entryId: 'preset-standard', presetId: 'standard', action: 'reapplied' }])
    expect(standard.override).toEqual(takeOverPreset(standard.shipped))
    expect((await controller.status()).presets[0]).toMatchObject({ state: 'active' })
  })

  it('re-taking over an outdated takeover follows the new revision', async () => {
    const { controller, standard, fake } = profile()
    await controller.takeOver()
    standard.shipped = upgrade(standard.shipped)
    fake.reload()
    expect(await controller.takeOver()).toMatchObject({ ok: true, action: 'applied', preset: { state: 'active' } })
    expect(standard.override).toEqual(takeOverPreset(standard.shipped))
  })

  it('leaves a customized takeover alone and keeps user edits on restore', async () => {
    const { controller, standard, fake } = profile()
    await controller.takeOver()
    const custom = structuredClone(standard.override!)
    ;(custom['plugins'] as Json[]).push({ id: 'tool-mine', name: 'my-tool' })
    standard.override = custom
    standard.shipped = upgrade(standard.shipped)
    fake.reload()

    expect((await controller.status()).presets[0]).toMatchObject({ state: 'customized' })
    const before = fake.edits()
    expect(await controller.refreshAfterUpgrade()).toMatchObject([{ entryId: 'preset-standard', action: 'customized' }])
    expect(fake.edits()).toBe(before)
    expect(standard.override).toBe(custom)

    const restored = await controller.restore()
    expect(restored).toMatchObject({ ok: true, action: 'restored' })
    expect(restored.ok && restored.warning).toContain('other edits to this preset were kept')
    expect(isTakenOver(standard.override)).toBe(false)
    expect(JSON.stringify(standard.override)).toContain('tool-mine')
  })

  it('forgets a takeover that was removed outside the controller', async () => {
    const { controller, standard, fake } = profile()
    await controller.takeOver()
    standard.override = undefined
    fake.reload()
    expect(await controller.refreshAfterUpgrade()).toEqual([{ entryId: 'preset-standard', presetId: 'standard', action: 'released' }])
    expect(await state.get()).toEqual({})
  })

  it('surfaces higher-layer overrides and missing presets as errors', async () => {
    const { controller, fake, standard } = profile()
    fake.blocked.add('preset-standard')
    const blocked = await controller.takeOver()
    expect(blocked).toMatchObject({ ok: false, code: 'overridden' })
    expect(!blocked.ok && blocked.message).toContain('overridden by a home patch or command-line overlay')
    expect(standard.override).toBeUndefined()
    expect(await state.get()).toBeUndefined()

    expect(await controller.takeOver('ptc')).toMatchObject({ ok: false, code: 'preset-not-found' })
    expect(await controller.restore('ptc')).toMatchObject({ ok: false, code: 'preset-not-found' })
  })

  it('reports a preset without a compaction group', async () => {
    const bare: FakeRow = { id: 'preset-bare', name: '@deepseek-ai/dsh-agent-preset', shipped: { id: 'bare', plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }] } }
    const fake = fakeEditor([bare])
    const controller = createTakeoverController({ configEditor: fake.editor, state })
    expect((await controller.status()).presets).toEqual([{ entryId: 'preset-bare', presetId: 'bare', state: 'unsupported', recorded: false, detail: 'no compaction group' }])
    expect(await controller.takeOver('bare')).toMatchObject({ ok: false, code: 'no-compaction-group' })
  })

  it('works without a config editor and never rejects on broken dependencies', async () => {
    const none = createTakeoverController({ configEditor: undefined, state })
    expect(await none.status()).toEqual({ editable: false, presets: [] })
    expect(await none.takeOver()).toMatchObject({ ok: false, code: 'no-config-editor' })
    expect(await none.restore()).toMatchObject({ ok: false, code: 'no-config-editor' })
    expect(await none.refreshAfterUpgrade()).toEqual([])

    const broken: ConfigEditorLike = {
      entries: () => { throw new Error('loader gone') },
      configuration: () => { throw new Error('loader gone') },
      edit: () => Promise.reject(new Error('loader gone')),
    }
    const failing = createTakeoverController({ configEditor: broken, state: { get: () => Promise.reject(new Error('disk')), set: () => Promise.reject(new Error('disk')) } })
    expect(await failing.status()).toEqual({ editable: true, presets: [], error: 'loader gone' })
    expect(await failing.takeOver()).toMatchObject({ ok: false, code: 'edit-failed', message: 'loader gone' })
    expect(await failing.refreshAfterUpgrade()).toMatchObject([{ action: 'failed', detail: 'loader gone' }])
  })

  it('still applies the takeover when its record cannot be saved', async () => {
    const { fake } = profile()
    const controller = createTakeoverController({ configEditor: fake.editor, state: { get: () => undefined, set: () => { throw new Error('read-only disk') } } })
    const applied = await controller.takeOver()
    expect(applied).toMatchObject({ ok: true, action: 'applied' })
    expect(applied.ok && applied.warning).toContain('read-only disk')
  })
})
