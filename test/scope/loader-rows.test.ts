import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { detectCoexistence, listLoadedRows, listLoadedRowsDeep, loadedRowNames, type ServiceLookup } from '../../src/scope/index.ts'

const PLUGIN = 'export const name = "fixture"\nexport function apply() {}\n'

describe('listLoadedRows with the real Cordis Loader', () => {
  const cleanup: (() => Promise<unknown>)[] = []
  afterEach(async () => {
    for (const task of cleanup.splice(0).reverse()) await task()
  })

  async function mountLoader() {
    const dir = await mkdtemp(join(tmpdir(), 'mcb-loader-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'fixture.mjs'), PLUGIN)
    const ctx = new Context()
    const fiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(`${dir}/`).href })
    cleanup.push(async () => fiber.dispose())
    await fiber.await()
    const loader = ctx.get('loader')!
    loader.builtins.group = Group
    const create = (options: EntryOptions) => loader.create(options as Omit<EntryOptions, 'id'>)
    return { ctx, loader, create }
  }

  it('is satisfied by a Cordis Context', () => {
    expectTypeOf<Context>().toExtend<ServiceLookup>()
  })

  it('lists host rows, nested group rows and their enablement, skipping group carriers', async () => {
    const { ctx, loader, create } = await mountLoader()
    await create({ id: 'fold', name: './fixture.mjs' })
    await create({ id: 'off', name: './fixture.mjs', disabled: true })
    await create({
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      config: [{ id: 'inner', name: './fixture.mjs' }, { id: 'inner-off', name: './fixture.mjs', disabled: true }],
    })
    await loader.await()

    const rows = listLoadedRows(ctx)
    expect(rows.map(row => [row.id, row.enabled, row.source])).toEqual([
      ['fold', true, 'host'],
      ['off', false, 'host'],
      ['inner', true, 'host'],
      ['inner-off', false, 'host'],
    ])
    expect(rows.every(row => row.name === './fixture.mjs')).toBe(true)
    expect(loadedRowNames(rows)).toEqual(['./fixture.mjs'])
  })

  it('treats a disabled ancestor group as disabling its children', async () => {
    const { ctx, loader, create } = await mountLoader()
    await create({ id: 'g', name: 'cordis:group', group: true, disabled: true, config: [{ id: 'child', name: './fixture.mjs' }] })
    await loader.await()
    expect(listLoadedRows(ctx)).toEqual([{ id: 'child', name: './fixture.mjs', enabled: false, source: 'host' }])
  })

  it('adds active preset modules and declared preset rows', async () => {
    const { ctx, loader, create } = await mountLoader()
    await create({ id: 'host-row', name: './fixture.mjs' })
    await loader.await()
    const agentPresets = {
      inspectCompositions: () => [{ id: 'standard', modules: [{ moduleName: 'dsh-world/compaction' }, { moduleName: 'cordis:group' }], leakedServices: [] }],
      compositionInventory: async () => [{
        id: 'standard',
        isDefault: true,
        rows: [
          { entryId: 'compaction-basic', moduleName: 'dsh-world/compaction', enabled: true },
          { entryId: 'maid', moduleName: 'dsh-context-maid', enabled: false },
          { entryId: null, moduleName: 'dsh-taskfold/plugins', enabled: 'conditional' },
        ],
      }],
    }
    const lookup: ServiceLookup = { get: (name, strict) => name === 'agentPresets' ? agentPresets : ctx.get(name, strict) }

    const shallow = listLoadedRows(lookup)
    expect(shallow.map(row => [row.name, row.source])).toEqual([
      ['./fixture.mjs', 'host'],
      ['dsh-world/compaction', 'preset:standard'],
    ])

    const deep = await listLoadedRowsDeep(lookup)
    expect(deep.map(row => [row.id, row.name, row.enabled, row.source])).toEqual([
      ['host-row', './fixture.mjs', true, 'host'],
      ['dsh-world/compaction', 'dsh-world/compaction', true, 'preset:standard'],
      ['compaction-basic', 'dsh-world/compaction', true, 'preset:standard'],
      ['maid', 'dsh-context-maid', false, 'preset:standard'],
      ['dsh-taskfold/plugins', 'dsh-taskfold/plugins', true, 'preset:standard'],
    ])
    const report = detectCoexistence(loadedRowNames(deep))
    expect(report.compactionPlugins.map(plugin => plugin.id)).toEqual(['dsh-world/compaction', 'dsh-taskfold'])
    expect(report.recommendation).toBe('assist')
  })

  it('returns [] when there is no loader', () => {
    expect(listLoadedRows(new Context())).toEqual([])
  })
})

describe('listLoadedRows tolerance', () => {
  const lookup = (services: Record<string, unknown>): ServiceLookup => ({ get: name => services[name] })

  it('falls back to walking loader stores and subtrees when entries() is missing', () => {
    const nested = { store: { inner: { options: { id: 'inner', name: 'dsh-engramory' } } } }
    const loader = {
      store: {
        a: { id: 'a', options: { id: 'a', name: 'dsh-taskfold/plugins' }, disabled: false },
        inc: { options: { id: 'inc', name: 'cordis:include' }, subtree: nested },
        b: { options: { id: 'b', name: 'dsh-memory', disabled: true } },
        c: { options: { id: 'c', name: 'dsh-auto-memory', disabled: { __jsExpr: 'env.X' } } },
        junk: { nope: true },
      },
    }
    const rows = listLoadedRows(lookup({ loader }))
    expect(rows.map(row => [row.id, row.name, row.enabled])).toEqual([
      ['a', 'dsh-taskfold/plugins', true],
      ['inner', 'dsh-engramory', true],
      ['b', 'dsh-memory', false],
      ['c', 'dsh-auto-memory', true],
    ])
  })

  it('survives throwing getters, entries() and services', async () => {
    const hostile = {
      entries() {
        return [
          { get id(): string { throw new Error('id') }, get disabled(): boolean { throw new Error('disabled') }, options: { id: 'x', name: 'dsh-memory' } },
          { get options(): unknown { throw new Error('options') } },
        ][Symbol.iterator]()
      },
    }
    expect(listLoadedRows(lookup({ loader: hostile }))).toEqual([{ id: 'x', name: 'dsh-memory', enabled: true, source: 'host' }])

    const broken = { entries() { throw new Error('boom') }, store: { a: { options: { id: 'a', name: 'dsh-memory' } } } }
    expect(listLoadedRows(lookup({ loader: broken })).map(row => row.id)).toEqual(['a'])

    const throwingCtx: ServiceLookup = { get() { throw new Error('no inject') } }
    expect(listLoadedRows(throwingCtx)).toEqual([])
    await expect(listLoadedRowsDeep(throwingCtx)).resolves.toEqual([])

    const presets = { inspectCompositions() { throw new Error('x') }, compositionInventory: () => Promise.reject(new Error('y')) }
    expect(listLoadedRows(lookup({ agentPresets: presets }))).toEqual([])
    await expect(listLoadedRowsDeep(lookup({ agentPresets: presets }))).resolves.toEqual([])

    const syncThrow = { compositionInventory() { throw new Error('sync') } }
    await expect(listLoadedRowsDeep(lookup({ agentPresets: syncThrow }))).resolves.toEqual([])
  })

  it('ignores unexpected shapes', async () => {
    expect(listLoadedRows(lookup({ loader: 42, agentPresets: 'x' }))).toEqual([])
    expect(listLoadedRows(lookup({ loader: { entries: () => 7 } }))).toEqual([])
    const odd = { inspectCompositions: () => [null, { id: 3 }, { id: 'p', modules: 'nope' }, { id: 'q', modules: [{ moduleName: '' }, {}] }] }
    expect(listLoadedRows(lookup({ agentPresets: odd }))).toEqual([])
    const oddInventory = { compositionInventory: async () => [{ id: 'p', rows: [null, { moduleName: 5 }] }] }
    await expect(listLoadedRowsDeep(lookup({ agentPresets: oddInventory }))).resolves.toEqual([])
  })
})
