import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { OWNER_SCOPE, type ScopeId } from '../../src/contracts.ts'
import { createEventMemory, type EventMemory } from '../../src/store/event-memory.ts'
import * as files from '../../src/store/files.ts'
import { fakeClock, listTree, useTempRoots } from './helpers.ts'

const newRoot = useTempRoots()
const otherScope = 'group-27' as ScopeId
const entryFile = (root: string, scope = OWNER_SCOPE) => join(root, 'scopes', scope, 'events.json')
const create = { subject: 'Launch', text: 'First flight', expectedRevision: 0 }

async function expectPrivateError(operation: Promise<unknown>, ...privateValues: string[]): Promise<void> {
  const error: unknown = await operation.then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toContain('events.json')
  for (const value of privateValues) expect(message).not.toContain(value)
}

describe('scoped event memory', () => {
  it('lists missing scopes without creating files and keeps CRUD and revision allocation local to each scope', async () => {
    const root = await newRoot()
    const clock = fakeClock(100)
    const store = createEventMemory(root, clock)
    expect(await store.list(OWNER_SCOPE)).toEqual([])
    expect(await store.list(otherScope)).toEqual([])
    expect(await readdir(root)).toEqual([])

    const first = await store.save(OWNER_SCOPE, create)
    expect(first).toEqual({ subject: 'Launch', text: 'First flight', revision: 1, updatedAt: 100 })
    const other = await store.save(otherScope, { ...create, text: 'Group flight' })
    expect(other.revision).toBe(1)
    const reopened = createEventMemory(root, clock)
    const second = await reopened.save(OWNER_SCOPE, { ...create, subject: '__proto__' })
    clock.advance(-30)
    const changed = await reopened.save(OWNER_SCOPE, { ...create, text: 'Landed', expectedRevision: first.revision })
    expect(changed).toEqual({ subject: 'Launch', text: 'Landed', revision: 3, updatedAt: 70 })
    expect(await store.list(OWNER_SCOPE)).toEqual([changed, second])
    expect(await store.list(otherScope)).toEqual([other])
    expect(await store.remove(OWNER_SCOPE, { subject: 'Launch', expectedRevision: changed.revision })).toBe(true)
    expect(await reopened.remove(OWNER_SCOPE, { subject: 'Launch', expectedRevision: changed.revision })).toBe(false)
    expect(await reopened.list(OWNER_SCOPE)).toEqual([second])
    expect(await reopened.list(otherScope)).toEqual([other])
    expect(await listTree(root)).toEqual([otherScope, OWNER_SCOPE].sort().map(scope => join('scopes', scope, 'events.json')))
  })

  it('matches compatibility forms, composed accents and case while keeping the original readable title and exact text', async () => {
    const store = createEventMemory(await newRoot(), fakeClock())
    const title = 'Ｃａｆｅ\u0301 Straße ΟΣ'
    const alias = 'CAFÉ STRAẞE ος'
    const request = { subject: `　${title} `, text: '  🧑‍🚀 Cafe\u0301 ', expectedRevision: 0 }
    const first = await store.save(OWNER_SCOPE, request)
    expect(first.subject).toBe(title)
    expect(first.text).toBe(request.text)
    expect(await store.save(OWNER_SCOPE, { ...request, subject: alias })).toEqual(first)
    await expect(store.save(OWNER_SCOPE, { ...request, subject: alias, text: request.text.normalize('NFC') })).rejects.toThrow(/revision conflict/)
    await expect(store.save(OWNER_SCOPE, { ...request, subject: alias, text: request.text.trim() })).rejects.toThrow(/revision conflict/)
    const updated = await store.save(OWNER_SCOPE, { subject: '  café strasse οσ', text: 'Second', expectedRevision: first.revision })
    expect(updated.subject).toBe(title)
    expect(await store.list(OWNER_SCOPE)).toEqual([updated])
    expect(await store.remove(OWNER_SCOPE, { subject: alias, expectedRevision: updated.revision })).toBe(true)
    const dotted = await store.save(OWNER_SCOPE, { ...create, subject: 'i' })
    const dotless = await store.save(OWNER_SCOPE, { ...create, subject: 'ı' })
    expect(await store.list(OWNER_SCOPE)).toEqual([dotted, dotless])
  })

  it('replays a successful write using its actual predecessor and rejects stale requests even after content cycles', async () => {
    const root = await newRoot()
    const clock = fakeClock(17)
    const store = createEventMemory(root, clock)
    const first = await store.save(OWNER_SCOPE, create)
    await store.save(OWNER_SCOPE, { ...create, subject: 'Interleaved' })
    const change = { ...create, text: 'Launched', expectedRevision: first.revision }
    const changed = await store.save(OWNER_SCOPE, change)
    expect(changed.revision).toBeGreaterThan(first.revision + 1)
    await store.save(OWNER_SCOPE, { ...create, subject: 'Later' })
    const file = entryFile(root)
    // Different whitespace makes a gratuitous rewrite detectable even when the JSON values are equal.
    const untouched = (await readFile(file, 'utf8')).trimEnd() + '  \n'
    await writeFile(file, untouched)
    clock.advance(700)
    const reopened = createEventMemory(root, clock)
    expect(await reopened.save(OWNER_SCOPE, change)).toEqual(changed)
    expect(await reopened.save(OWNER_SCOPE, { ...change, expectedRevision: changed.revision })).toEqual(changed)
    await expect(reopened.save(OWNER_SCOPE, create)).rejects.toThrow(/revision conflict/)
    await expect(reopened.save(OWNER_SCOPE, { ...change, text: 'Wrong' })).rejects.toThrow(/revision conflict/)
    await expect(reopened.remove(OWNER_SCOPE, change)).rejects.toThrow(/revision conflict/)
    expect(await readFile(file, 'utf8')).toBe(untouched)

    const reset = await reopened.save(OWNER_SCOPE, { ...create, expectedRevision: changed.revision })
    await expect(store.save(OWNER_SCOPE, create)).rejects.toThrow(/revision conflict/)
    const latest = await store.save(OWNER_SCOPE, { ...change, expectedRevision: reset.revision })
    await expect(reopened.save(OWNER_SCOPE, change)).rejects.toThrow(/revision conflict/)
    expect((await reopened.list(OWNER_SCOPE))[0]).toEqual(latest)
  })

  it('retains the scope counter after the last delete and protects a recreated event from the old revision', async () => {
    const root = await newRoot()
    const clock = fakeClock()
    const store = createEventMemory(root, clock)
    const { revision } = await store.save(OWNER_SCOPE, create)
    const old = { subject: 'Launch', expectedRevision: revision }
    expect(await store.remove(OWNER_SCOPE, old)).toBe(true)
    const reopened = createEventMemory(root, clock)
    expect(await reopened.list(OWNER_SCOPE)).toEqual([])
    expect(await reopened.remove(OWNER_SCOPE, old)).toBe(false)
    await expect(reopened.save(OWNER_SCOPE, { ...create, ...old })).rejects.toThrow(/revision conflict/)
    const recreated = await reopened.save(OWNER_SCOPE, create)
    expect(recreated.revision).toBeGreaterThan(revision)
    await expect(store.remove(OWNER_SCOPE, old)).rejects.toThrow(/revision conflict/)
    await expect(store.save(OWNER_SCOPE, { ...create, ...old })).rejects.toThrow(/revision conflict/)
    expect(await store.list(OWNER_SCOPE)).toEqual([recreated])
  })

  it('serializes independent instances racing a shared revision and preserves writes to different subjects', async () => {
    const root = await newRoot()
    const stores = Array.from({ length: 10 }, () => createEventMemory(root, fakeClock()))
    const created = await Promise.all(stores.map(store => store.save(OWNER_SCOPE, create)))
    expect(new Set(created.map(entry => entry.revision))).toEqual(new Set([1]))
    const distinct = await Promise.all(stores.map((store, i) => store.save(OWNER_SCOPE, { ...create, subject: `Event ${i}` })))
    expect(new Set(distinct.map(entry => entry.revision)).size).toBe(stores.length)
    const results = await Promise.allSettled(stores.map((store, i) => store.save(OWNER_SCOPE, {
      ...create, text: `Update ${i}`, expectedRevision: 1,
    })))
    const winners = results.filter(result => result.status === 'fulfilled').map(result => result.value)
    expect(winners).toHaveLength(1)
    for (const result of results) if (result.status === 'rejected') expect(result.reason.message).toMatch(/revision conflict/)
    const reopened = createEventMemory(root, fakeClock())
    expect(await reopened.list(OWNER_SCOPE)).toEqual(expect.arrayContaining([...distinct, ...winners]))
    expect(await reopened.list(OWNER_SCOPE)).toHaveLength(distinct.length + 1)
  })

  it('recognizes identical retries across fresh Node processes sharing the same file lock', async () => {
    const root = await newRoot()
    const store = createEventMemory(root, fakeClock(1))
    const first = await store.save(OWNER_SCOPE, create)
    const change = { ...create, text: 'In orbit', expectedRevision: first.revision }
    const program = `
      const { createEventMemory } = await import(process.argv[1])
      const store = createEventMemory(process.argv[2], { now: () => Number(process.argv[3]) })
      const entry = await store.save('owner', JSON.parse(process.argv[4]))
      process.stdout.write(JSON.stringify(entry))
    `
    const moduleUrl = new URL('../../src/store/event-memory.ts', import.meta.url).href
    const child = (time: number) => promisify(execFile)(process.execPath, [
      '--input-type=module', '-e', program, moduleUrl, root, String(time), JSON.stringify(change),
    ])
    const replies = await Promise.all([child(10), child(20)])
    const [winner] = await store.list(OWNER_SCOPE)
    expect(winner?.revision).toBe(first.revision + 1)
    expect([10, 20]).toContain(winner?.updatedAt)
    for (const reply of replies) expect(JSON.parse(reply.stdout)).toEqual(winner)
  })

  it('enforces code-point limits on the stored strings and rejects invalid requests before creating a scope', async () => {
    const root = await newRoot()
    const store = createEventMemory(root, fakeClock())
    const subject = '🐈'.repeat(80)
    const text = '🚀'.repeat(600)
    const invalid: unknown[] = [null, [], {}, { ...create, text: 5 }, { ...create, subject: null },
      { ...create, text: '　' }, { ...create, subject: ' ' }, { ...create, subject: subject + 'x' }, { ...create, text: text + 'x' }]
    for (const char of ['\0', '\n', '\r', '\t', '\x7f', '\x85', '\u061c', '\u200e', '\u200f', '\u2028', '\u2029', '\u202e', '\u2066', '\u2069', '\u206a', '\ud800']) {
      invalid.push({ ...create, subject: `title${char}` }, { ...create, text: `${char}text` })
      await expect(store.remove(OWNER_SCOPE, { subject: `x${char}`, expectedRevision: 1 })).rejects.toThrow(/subject/)
    }
    for (const expectedRevision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      invalid.push({ ...create, expectedRevision })
      await expect(store.remove(OWNER_SCOPE, { subject, expectedRevision } as Parameters<EventMemory['remove']>[1])).rejects.toThrow(/expectedRevision/)
    }
    await expect(store.remove(OWNER_SCOPE, { subject, expectedRevision: 0 })).rejects.toThrow(/expectedRevision/)
    for (const request of invalid) await expect(store.save(OWNER_SCOPE, request as Parameters<EventMemory['save']>[1])).rejects.toThrow(/events\.json/)
    for (const raw of ['../PRIVATE', '..\\PRIVATE', 'PRIVATE/owner', '', null]) {
      const scope = raw as ScopeId
      await expectPrivateError(store.list(scope), 'PRIVATE', root)
      await expectPrivateError(store.save(scope, create), 'PRIVATE', root)
      await expectPrivateError(store.remove(scope, { subject, expectedRevision: 1 }), 'PRIVATE', root)
    }
    expect(await readdir(root)).toEqual([])
    const entry = await store.save(OWNER_SCOPE, { subject: ` ${subject} `, text, expectedRevision: 0 })
    expect(entry).toMatchObject({ subject, text })
    const bytes = await readFile(entryFile(root))
    await expect(store.save(OWNER_SCOPE, { ...entry, text: text + '!', expectedRevision: entry.revision })).rejects.toThrow(/600/)
    expect(await readFile(entryFile(root))).toEqual(bytes)
  })

  it('admits the 256th entry, rolls back overflow, and still allows retries, edits and removals at capacity', async () => {
    const root = await newRoot()
    const file = entryFile(root)
    const store = createEventMemory(root, fakeClock())
    const entries = Array.from({ length: 255 }, (_, i) => ({ subject: `Subject ${i}`, text: 'Seed', revision: i + 1, previousRevision: 0, updatedAt: 0 }))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, scope: OWNER_SCOPE, lastRevision: entries.length, entries }))
    const last = await store.save(OWNER_SCOPE, create)
    expect(last.revision).toBe(256)
    const before = await readFile(file)
    await expect(store.save(OWNER_SCOPE, { ...create, subject: 'Overflow' })).rejects.toThrow(/256/)
    expect(await store.save(OWNER_SCOPE, create)).toEqual(last)
    expect(await readFile(file)).toEqual(before)
    expect(await store.list(OWNER_SCOPE)).toHaveLength(256)
    const updated = await store.save(OWNER_SCOPE, { ...create, text: 'Accepted', expectedRevision: last.revision })
    expect(updated.revision).toBe(257)
    await store.remove(OWNER_SCOPE, { subject: last.subject, expectedRevision: updated.revision })
    expect((await store.save(OWNER_SCOPE, { ...create, subject: 'Next' })).revision).toBe(258)
  })

  it('preserves committed state on write failure, an invalid clock and exhausted revision numbers', async () => {
    const root = await newRoot()
    const store = createEventMemory(root, fakeClock(5))
    const first = await store.save(OWNER_SCOPE, create)
    const change = { ...create, text: 'Second flight', expectedRevision: first.revision }
    const file = entryFile(root)
    const before = await readFile(file, 'utf8')
    const writer = vi.spyOn(files, 'writeJsonAtomic').mockRejectedValueOnce(new Error(`PRIVATE ${root}`))
    try {
      await expectPrivateError(store.save(OWNER_SCOPE, change), root, 'PRIVATE')
    } finally {
      writer.mockRestore()
    }
    const badClock = createEventMemory(root, { now: () => NaN })
    await expect(badClock.save(OWNER_SCOPE, change)).rejects.toThrow(/clock/)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await store.list(OWNER_SCOPE)).toEqual([first])
    expect((await store.save(OWNER_SCOPE, change)).revision).toBe(first.revision + 1)

    const data = JSON.parse(before)
    data.lastRevision = Number.MAX_SAFE_INTEGER - 1
    await writeFile(file, JSON.stringify(data))
    const final = await store.save(OWNER_SCOPE, change)
    expect(final.revision).toBe(Number.MAX_SAFE_INTEGER)
    const exhausted = await readFile(file)
    expect(await store.save(OWNER_SCOPE, change)).toEqual(final)
    await expect(store.save(OWNER_SCOPE, { ...create, expectedRevision: final.revision })).rejects.toThrow(/revision limit/)
    expect(await readFile(file)).toEqual(exhausted)
    await store.remove(OWNER_SCOPE, { subject: create.subject, expectedRevision: final.revision })
    await expect(store.save(OWNER_SCOPE, create)).rejects.toThrow(/revision limit/)
    expect(await store.list(OWNER_SCOPE)).toEqual([])
  })

  it('rejects malformed, foreign and ambiguous records on every operation and preserves the exact private bytes', async () => {
    const root = await newRoot()
    const file = entryFile(root)
    await mkdir(dirname(file), { recursive: true })
    const store = createEventMemory(root, fakeClock())
    const entry = { subject: 'PRIVATE-title', text: 'PRIVATE-body', revision: 2, previousRevision: 1, updatedAt: 0 }
    const valid = { version: 1, scope: OWNER_SCOPE, lastRevision: 2, entries: [entry] }
    const badUtf8 = Buffer.from(JSON.stringify(valid))
    badUtf8[badUtf8.indexOf(entry.text)] = 0xff
    const other = { ...entry, subject: 'Other', previousRevision: 0 }
    const tooMany = Array.from({ length: 257 }, (_, i) => ({ ...other, subject: `Subject ${i}`, revision: i + 1 }))
    const invalidEntries = [
      [null], [{ ...entry, extra: entry.text }], [{ ...entry, updatedAt: null }],
      [{ ...entry, revision: 0 }], [{ ...entry, previousRevision: 2 }], [{ ...entry, previousRevision: -1 }],
      [{ ...entry, subject: ' spaced' }], [{ ...entry, subject: 'x'.repeat(81) }],
      [{ ...entry, text: '' }], [{ ...entry, text: 'x'.repeat(601) }], [{ ...entry, text: 'PRIVATE-body\u202e' }],
      [entry, other], [entry, { ...other, revision: 1 }],
      [entry, { ...other, subject: 'ＰＲＩＶＡＴＥ-title', revision: 3 }],
    ]
    const invalidRecords = [
      { ...valid, scope: otherScope }, { ...valid, version: 2 }, { ...valid, extra: entry.text },
      { ...valid, lastRevision: 1 }, { ...valid, lastRevision: 0.5 }, { ...valid, entries: {} },
      { ...valid, lastRevision: tooMany.length, entries: tooMany },
      ...invalidEntries.map(entries => ({ ...valid, lastRevision: 3, entries })),
    ]
    const badFiles = [badUtf8, ...['', 'PRIVATE-body{', 'null', '[]', '{}'].map(raw => Buffer.from(raw)),
      ...invalidRecords.map(record => Buffer.from(JSON.stringify(record))),
    ]
    for (const bytes of badFiles) {
      await writeFile(file, bytes)
      await expectPrivateError(store.list(OWNER_SCOPE), entry.text, entry.subject, root)
      await expectPrivateError(store.save(OWNER_SCOPE, create), entry.text, entry.subject, root)
      await expectPrivateError(store.remove(OWNER_SCOPE, { subject: entry.subject, expectedRevision: 2 }), entry.text, entry.subject, root)
      expect(await readFile(file)).toEqual(bytes)
    }
    expect(await listTree(root)).toEqual([join('scopes', OWNER_SCOPE, 'events.json')])
  })
})
