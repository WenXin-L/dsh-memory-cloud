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
    throw new ProfileNoteError(`${field} 需要一行非空文本，请移除控制字符。 / Use one nonempty line without control characters.`)
  }
  return value
}

function parseRequest(request: ProfileNoteRequest): { action: 'list' } | NoteEdit {
  if (!isRecord(request)) throw new ProfileNoteError('请求应为对象。 / Expected a request object.')
  if (Object.keys(request).some(key => key !== 'action' && key !== 'text' && key !== 'oldText')) {
    throw new ProfileNoteError('请求含有多余字段。 / Unexpected request field.')
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
      throw new ProfileNoteError('action 只接受以下值 / Expected one of: list, add, replace, remove.')
  }
  throw new ProfileNoteError(`${action} 收到了多余字段。 / Unexpected field for this action.`)
}

function result(entries: string[], changed: boolean): ProfileNoteResult {
  let usedChars = Math.max(0, entries.length - 1)
  for (const entry of entries) {
    for (const _ of entry) {
      if (++usedChars > LIMIT_CHARS) {
        throw new ProfileNoteError(`相处笔记合计超过 ${LIMIT_CHARS} 个 Unicode 码点，请缩短或移除一条。 / Notes exceed the ${LIMIT_CHARS} code point limit. Please shorten or remove a note.`)
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
  if (!isUtf8(bytes)) throw new ProfileNoteError('笔记文件编码错误 / invalid UTF-8 in stored profile notes.')
  let data: unknown
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    // JSON.parse errors can quote a fragment of the owner's notes.
    throw new ProfileNoteError('笔记文件格式错误 / invalid JSON in stored profile notes.')
  }
  if (!isRecord(data) || data.version !== 1 || !isStringArray(data.entries)
    || Object.keys(data).some(key => key !== 'version' && key !== 'entries')) {
    throw new ProfileNoteError('笔记文件应仅含 version（值为 1）和 entries（字符串数组）。 / Expected only version 1 and a string array named entries.')
  }
  for (const entry of data.entries) {
    if (noteText(entry, 'stored entry') !== entry.trim()) throw new ProfileNoteError('已存笔记首尾含有空白。 / Stored entry has leading or trailing whitespace.')
  }
  if (new Set(data.entries).size !== data.entries.length) throw new ProfileNoteError('文件中有重复笔记，按原文匹配时会有多个结果。 / Duplicate stored entries make an exact match ambiguous.')
  return result([...data.entries], false)
}

function editEntries(entries: string[], edit: NoteEdit): boolean {
  if (edit.action === 'add') {
    if (entries.includes(edit.text)) return false
    entries.push(edit.text)
    return true
  }
  const index = entries.indexOf(edit.oldText)
  if (index === -1) throw new ProfileNoteError(`${edit.action} 未找到与 oldText 完全一致的笔记。请先用 list 核对原文。 / No exact oldText match. Use list to check the original wording.`)
  if (edit.action === 'remove') {
    entries.splice(index, 1)
  } else {
    if (edit.text === edit.oldText) return false
    if (entries.includes(edit.text)) throw new ProfileNoteError('新内容与另一条笔记相同，本次替换未保存。 / This replacement would duplicate an existing entry.')
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
        throw new ProfileNoteError(`${operation.action} 访问笔记存储失败 / failed to access stored notes${code}`)
      }
    },
  }
}
