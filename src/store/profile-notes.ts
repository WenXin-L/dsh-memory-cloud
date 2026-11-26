import { isUtf8 } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { OWNER_SCOPE } from '../contracts.ts'
import { isNotFound, writeJsonAtomic } from './files.ts'
import { withPathLock } from './lock.ts'
import { isRecord, isStringArray } from './validate.ts'

export type ProfileNoteAction = 'list' | 'add' | 'replace' | 'remove'

export interface ProfileNoteRequest {
  readonly action: ProfileNoteAction
  readonly text?: string
  readonly oldText?: string
}

export interface ProfileNoteResult {
  entries: string[]
  usedChars: number
  limitChars: number
  changed: boolean
}

export interface ProfileNotes {
  apply(request: ProfileNoteRequest): Promise<ProfileNoteResult>
}

const FILE_NAME = 'profile-notes.json'
const LIMIT_CHARS = 1375
const LOCK_WAIT_MS = 10_000
// Bidi controls include direction marks and isolates. Joiners in ordinary script and emoji remain valid.
const FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\u206a-\u206f]/u

type NoteEdit =
  | { action: 'add'; text: string }
  | { action: 'replace'; text: string; oldText: string }
  | { action: 'remove'; oldText: string }

class ProfileNoteError extends Error {
  constructor(message: string) {
    super(`${FILE_NAME}: ${message}`)
  }
}

function noteText(value: unknown, field: string): string {
  if (typeof value !== 'string' || FORBIDDEN.test(value) || !value.trim()) {
    throw new ProfileNoteError(`${field} must be nonempty single-line text without control characters`)
  }
  return value
}

function parseRequest(request: ProfileNoteRequest): { action: 'list' } | NoteEdit {
  if (!isRecord(request)) throw new ProfileNoteError('expected a request object')
  if (Object.keys(request).some(key => key !== 'action' && key !== 'text' && key !== 'oldText')) {
    throw new ProfileNoteError('unexpected request field')
  }
  const { action, text, oldText } = request
  switch (action) {
    case 'list':
      if ('text' in request || 'oldText' in request) break
      return { action }
    case 'add':
      if ('oldText' in request) break
      return { action, text: noteText(text, 'text').trim() }
    case 'replace':
      return { action, text: noteText(text, 'text').trim(), oldText: noteText(oldText, 'oldText') }
    case 'remove':
      if ('text' in request) break
      return { action, oldText: noteText(oldText, 'oldText') }
    default:
      throw new ProfileNoteError('unknown action; expected list, add, replace or remove')
  }
  throw new ProfileNoteError(`unexpected field for ${action}`)
}

function result(entries: string[], changed: boolean): ProfileNoteResult {
  let usedChars = Math.max(0, entries.length - 1)
  for (const entry of entries) {
    for (const _ of entry) {
      if (++usedChars > LIMIT_CHARS) {
        throw new ProfileNoteError(`notes exceed the ${LIMIT_CHARS} code point limit; shorten or remove a note`)
      }
    }
  }
  return { entries, usedChars, limitChars: LIMIT_CHARS, changed }
}

async function readNotes(file: string): Promise<ProfileNoteResult> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (error) {
    if (isNotFound(error)) return result([], false)
    throw error
  }
  if (!isUtf8(bytes)) throw new ProfileNoteError('invalid UTF-8 in stored profile notes')
  let data: unknown
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    // JSON.parse errors can quote a fragment of the owner's notes.
    throw new ProfileNoteError('invalid JSON in stored profile notes')
  }
  if (!isRecord(data) || data.version !== 1 || !isStringArray(data.entries)
    || Object.keys(data).some(key => key !== 'version' && key !== 'entries')) {
    throw new ProfileNoteError('invalid stored record; expected version 1 and a string array of entries')
  }
  for (const entry of data.entries) {
    if (noteText(entry, 'stored entry') !== entry.trim()) throw new ProfileNoteError('stored entry is not trimmed')
  }
  if (new Set(data.entries).size !== data.entries.length) throw new ProfileNoteError('duplicate stored entries are ambiguous')
  return result([...data.entries], false)
}

function editEntries(entries: string[], edit: NoteEdit): boolean {
  if (edit.action === 'add') {
    if (entries.includes(edit.text)) return false
    entries.push(edit.text)
    return true
  }
  const index = entries.indexOf(edit.oldText)
  if (index === -1) throw new ProfileNoteError(`${edit.action} found no exact oldText match`)
  if (edit.action === 'remove') {
    entries.splice(index, 1)
  } else {
    if (edit.text === edit.oldText) return false
    if (entries.includes(edit.text)) throw new ProfileNoteError('replacement would duplicate an existing entry')
    entries[index] = edit.text
  }
  return true
}

export function createProfileNotes(root: string): ProfileNotes {
  const file = resolve(root, 'scopes', OWNER_SCOPE, FILE_NAME)
  return {
    async apply(request) {
      const operation = parseRequest(request)
      try {
        if (operation.action === 'list') return await readNotes(file)
        return await withPathLock(file, async () => {
          const current = await readNotes(file)
          if (!editEntries(current.entries, operation)) return current
          const next = result(current.entries, true)
          await writeJsonAtomic(file, { version: 1, entries: next.entries })
          return next
        }, { waitMs: LOCK_WAIT_MS })
      } catch (error) {
        if (error instanceof ProfileNoteError) throw error
        // Filesystem errors include full paths, so retain the operation and system error code only.
        const code = isRecord(error) && typeof error.code === 'string' && /^E[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : ''
        throw new ProfileNoteError(`${operation.action} failed while accessing the store${code}`)
      }
    },
  }
}
