import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProfileNotes, type ProfileNoteRequest } from '../../src/store/profile-notes.ts'
import { listTree, useTempRoots } from './helpers.ts'

const newRoot = useTempRoots()
const relativeFile = join('scopes', 'owner', 'profile-notes.json')

async function seed(root: string, contents: string): Promise<void> {
  const file = join(root, relativeFile)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents)
}

describe('owner profile notes', () => {
  it('lists a missing store without creating even the scope directory', async () => {
    const root = await newRoot()
    const notes = createProfileNotes(root)
    expect(await notes.apply({ action: 'list' })).toEqual({ entries: [], usedChars: 0, limitChars: 1375, changed: false })
    expect(await readdir(root)).toEqual([])
  })

  it('persists trimmed text and ordered edits across instances in the owner scope only', async () => {
    const root = await newRoot()
    const notes = createProfileNotes(root)
    const reopened = createProfileNotes(root)
    expect(await notes.apply({ action: 'add', text: '  茶 🍵　' })).toEqual({ entries: ['茶 🍵'], usedChars: 3, limitChars: 1375, changed: true })
    await reopened.apply({ action: 'add', text: 'cafe\u0301' })
    // A combining mark, a joiner, and each astral character count as individual code points.
    const updated = await notes.apply({ action: 'replace', oldText: '茶 🍵', text: '  👩‍💻 ' })
    expect(updated).toEqual({ entries: ['👩‍💻', 'cafe\u0301'], usedChars: 9, limitChars: 1375, changed: true })
    expect(JSON.parse(await readFile(join(root, relativeFile), 'utf8'))).toEqual({ version: 1, entries: updated.entries })
    expect(await listTree(root)).toEqual([relativeFile])
    updated.entries.length = 0
    expect((await reopened.apply({ action: 'list' })).entries).toEqual(['👩‍💻', 'cafe\u0301'])
    expect(await reopened.apply({ action: 'remove', oldText: '👩‍💻' })).toMatchObject({ entries: ['cafe\u0301'], usedChars: 5, changed: true })
    await notes.apply({ action: 'remove', oldText: 'cafe\u0301' })
    expect(await createProfileNotes(root).apply({ action: 'list' })).toEqual({ entries: [], usedChars: 0, limitChars: 1375, changed: false })
  })

  it('leaves original bytes intact on list, duplicate add, identical replace and unsuccessful edits', async () => {
    const root = await newRoot()
    const raw = '{"entries":["Tea black","Tea green"],"version":1}'
    await seed(root, raw)
    const notes = createProfileNotes(root)
    for (const request of [
      { action: 'list' }, { action: 'add', text: ' Tea black ' }, { action: 'replace', oldText: 'Tea black', text: 'Tea black' },
    ] satisfies ProfileNoteRequest[]) {
      expect((await notes.apply(request)).changed).toBe(false)
    }
    for (const oldText of ['Tea', 'Tea black ', 'tea black', 'missing']) {
      await expect(notes.apply({ action: 'replace', oldText, text: 'Coffee' })).rejects.toThrow(/no exact oldText match/)
      await expect(notes.apply({ action: 'remove', oldText })).rejects.toThrow(/no exact oldText match/)
    }
    await expect(notes.apply({ action: 'replace', oldText: 'Tea black', text: ' Tea green' })).rejects.toThrow(/duplicate/)
    expect(await readFile(join(root, relativeFile), 'utf8')).toBe(raw)
  })

  it('allows exactly 1375 code points including separators and keeps every entry on overflow', async () => {
    const root = await newRoot()
    const notes = createProfileNotes(root)
    const long = '🐈'.repeat(1373)
    await notes.apply({ action: 'add', text: long })
    expect(await notes.apply({ action: 'add', text: '茶' })).toEqual({ entries: [long, '茶'], usedChars: 1375, limitChars: 1375, changed: true })
    const before = await readFile(join(root, relativeFile), 'utf8')
    await expect(notes.apply({ action: 'replace', oldText: '茶', text: '双份' })).rejects.toThrow(/1375.*shorten/)
    await expect(notes.apply({ action: 'add', text: 'x' })).rejects.toThrow(/1375.*shorten/)
    expect(await readFile(join(root, relativeFile), 'utf8')).toBe(before)
    await notes.apply({ action: 'replace', oldText: long, text: '🐈' })
    expect(await notes.apply({ action: 'add', text: 'x' })).toMatchObject({ entries: ['🐈', '茶', 'x'], usedChars: 5 })
  })

  it('rejects invalid actions, field combinations and control characters before creating the store', async () => {
    const root = await newRoot()
    const notes = createProfileNotes(root)
    const invalid: unknown[] = [
      null, [], {}, { action: 'save' }, { action: 'list', text: '' }, { action: 'list', oldText: 'x' },
      { action: 'list', scope: 'other' }, { action: 'add' }, { action: 'add', text: '' }, { action: 'add', text: '　 ' },
      { action: 'add', text: 2 }, { action: 'add', text: 'x', oldText: 'y' }, { action: 'replace', text: 'x' },
      { action: 'replace', oldText: 'y' }, { action: 'remove', oldText: 1 }, { action: 'remove', text: 'x', oldText: 'y' },
    ]
    for (const char of ['\n', '\r', '\t', '\x00', '\x1f', '\x7f', '\x85', '\u2028', '\u2029', '\u061c', '\u200e', '\u200f', '\u202e', '\u2066', '\u2069']) {
      invalid.push({ action: 'add', text: `${char}note` }, { action: 'replace', text: `note${char}`, oldText: 'old' }, { action: 'remove', oldText: `old${char}` })
    }
    for (const request of invalid) await expect(notes.apply(request as ProfileNoteRequest)).rejects.toThrow(/profile-notes\.json/)
    expect(await readdir(root)).toEqual([])
  })

  it('rejects damaged or ambiguous files without echoing note contents or overwriting the original', async () => {
    const root = await newRoot()
    const notes = createProfileNotes(root)
    const privateText = 'PRIVATE-test-marker'
    const badFiles = [
      '', `${privateText}{`, 'null', '[]', '{}', '{"version":1,"entries":"x"}',
      JSON.stringify({ version: 2, entries: [privateText] }), JSON.stringify({ version: 1, entries: [], extra: privateText }),
      ...[[null], [privateText, 9], [''], [' spaced '], ['a\u202eb'], ['a\n'], ['x'.repeat(1376)], [privateText, privateText]]
        .map(entries => JSON.stringify({ version: 1, entries })),
    ]
    for (const raw of badFiles) {
      await seed(root, raw)
      for (const request of [
        { action: 'list' }, { action: 'add', text: 'another' }, { action: 'replace', oldText: privateText, text: 'another' }, { action: 'remove', oldText: privateText },
      ] satisfies ProfileNoteRequest[]) {
        const error: unknown = await notes.apply(request).catch((err: unknown) => err)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('profile-notes.json')
        expect((error as Error).message).not.toContain(privateText)
        expect((error as Error).message).not.toContain(root)
      }
      expect(await readFile(join(root, relativeFile), 'utf8')).toBe(raw)
    }
  })

  it('preserves invalid UTF-8 bytes and distinguishes a real replacement character', async () => {
    const root = await newRoot()
    const notes = createProfileNotes(root)
    await notes.apply({ action: 'add', text: '\ufffd' })
    expect((await notes.apply({ action: 'list' })).entries).toEqual(['\ufffd'])
    const bytes = Buffer.concat([Buffer.from('{"version":1,"entries":["'), Buffer.from([0xff]), Buffer.from('"]}')])
    const file = join(root, relativeFile)
    await writeFile(file, bytes)
    await expect(notes.apply({ action: 'list' })).rejects.toThrow(/invalid UTF-8/)
    await expect(notes.apply({ action: 'add', text: 'new' })).rejects.toThrow(/invalid UTF-8/)
    expect(await readFile(file)).toEqual(bytes)
  })

  it('reports the operation and filesystem error code without exposing the storage root', async () => {
    const root = await newRoot()
    await mkdir(join(root, relativeFile), { recursive: true })
    const error: unknown = await createProfileNotes(root).apply({ action: 'list' }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/profile-notes\.json: list.*\(E[A-Z]+\)/)
    expect((error as Error).message).not.toContain(root)
  })

  it('keeps distinct concurrent writes and changes a shared entry just once across instances', async () => {
    const root = await newRoot()
    const names = Array.from({ length: 12 }, (_, i) => `note ${i}`)
    const stores = names.map(() => createProfileNotes(root))
    await Promise.all(stores.map((store, i) => store.apply({ action: 'add', text: `note ${i}` })))
    const added = await Promise.all(stores.map(store => store.apply({ action: 'add', text: 'shared' })))
    expect(added.filter(note => note.changed)).toHaveLength(1)
    const replaced = await Promise.allSettled(stores.map(store => store.apply({ action: 'replace', oldText: 'shared', text: 'updated' })))
    expect(replaced.filter(note => note.status === 'fulfilled')).toHaveLength(1)
    const final = await createProfileNotes(root).apply({ action: 'list' })
    expect(final.entries.sort()).toEqual([...names, 'updated'].sort())
  })
})
