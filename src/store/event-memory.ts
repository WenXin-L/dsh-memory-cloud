import { isUtf8 } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Clock, ScopeId } from '../contracts.ts'
import { writeJsonAtomic } from './files.ts'
import { assertScopeId } from './layout.ts'
import { withPathLock } from './lock.ts'
import { isFiniteNumber, isRecord } from './validate.ts'

export interface EventMemoryEntry {
  readonly subject: string
  readonly text: string
  readonly revision: number
  readonly updatedAt: number
}

interface EventTarget {
  readonly subject: string
  readonly expectedRevision: number
}

export interface EventMemory {
  list(scope: ScopeId): Promise<readonly EventMemoryEntry[]>
  save(scope: ScopeId, request: EventTarget & { readonly text: string }): Promise<EventMemoryEntry>
  remove(scope: ScopeId, request: EventTarget): Promise<boolean>
}

interface StoredEntry extends EventMemoryEntry {
  /** The condition of the write that produced this entry, for retries after a lost response. */
  readonly previousRevision: number
}

interface EventFile {
  readonly version: 1
  readonly scope: ScopeId
  lastRevision: number
  readonly entries: StoredEntry[]
}

const FILE_NAME = 'events.json'
const MAX_ENTRIES = 256
const MAX_SUBJECT = 80
const MAX_TEXT = 600
const FORBIDDEN = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Bidi_Control}\u206a-\u206f]/u
const FILE_FIELDS = ['version', 'scope', 'lastRevision', 'entries']
const ENTRY_FIELDS = ['subject', 'text', 'revision', 'updatedAt', 'previousRevision']

type EventErrorReason = 'input' | 'conflict' | 'capacity' | 'storage'

export class EventMemoryError extends Error {
  readonly reason: EventErrorReason

  constructor(message: string, reason: EventErrorReason = 'storage') {
    super(`${FILE_NAME}: ${message}`)
    this.reason = reason
  }
}

function hasFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}

function isRevision(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function validLine(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit * 2 && value.trim() !== ''
    && !FORBIDDEN.test(value) && [...value].length <= limit
}

export function eventSubjectKey(subject: string): string {
  const lower = subject.normalize('NFKC').trim().toLowerCase()
  // Uppercasing also folds sharp S and final sigma. Default Unicode case folding keeps dotless i distinct.
  return lower.split('\u0131').map(part => part.toUpperCase()).join('\u0131').normalize('NFC')
}

function checkedTarget(request: EventTarget, minimum: number): EventTarget {
  if (!isRecord(request)) throw new EventMemoryError('expected a request object', 'input')
  const { subject, expectedRevision } = request
  if (typeof subject !== 'string' || FORBIDDEN.test(subject) || !validLine(subject.trim(), MAX_SUBJECT)) {
    throw new EventMemoryError(`subject must be nonempty single-line text of at most ${MAX_SUBJECT} code points without controls`, 'input')
  }
  if (!isRevision(expectedRevision, minimum)) throw new EventMemoryError(`expectedRevision must be a safe integer of at least ${minimum}`, 'input')
  return { subject: subject.trim(), expectedRevision }
}

function isStoredEntry(value: unknown): value is StoredEntry {
  return hasFields(value, ENTRY_FIELDS) && validLine(value.subject, MAX_SUBJECT) && value.subject === value.subject.trim()
    && validLine(value.text, MAX_TEXT) && isFiniteNumber(value.updatedAt) && isRevision(value.revision, 1)
    && isRevision(value.previousRevision, 0) && value.previousRevision < value.revision
}

function publicEntry({ subject, text, revision, updatedAt }: StoredEntry): EventMemoryEntry {
  return { subject, text, revision, updatedAt }
}

async function readEvents(file: string, scope: ScopeId): Promise<EventFile> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { version: 1, scope, lastRevision: 0, entries: [] }
    throw error
  }
  if (!isUtf8(bytes)) throw new EventMemoryError('invalid UTF-8 in stored events')
  let data: unknown
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new EventMemoryError('invalid JSON in stored events')
  }
  if (!hasFields(data, FILE_FIELDS) || data.version !== 1 || data.scope !== scope || !isRevision(data.lastRevision, 0)
    || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES || !data.entries.every(isStoredEntry)) {
    throw new EventMemoryError('invalid stored event record')
  }
  const subjects = new Set<string>()
  const revisions = new Set<number>()
  for (const entry of data.entries) {
    const key = eventSubjectKey(entry.subject)
    if (subjects.has(key) || entry.revision > data.lastRevision || revisions.has(entry.revision) || revisions.has(entry.previousRevision)) {
      throw new EventMemoryError('inconsistent stored subjects or revisions')
    }
    subjects.add(key)
    revisions.add(entry.revision)
    if (entry.previousRevision > 0) revisions.add(entry.previousRevision)
  }
  return { version: 1, scope, lastRevision: data.lastRevision, entries: data.entries }
}

export function createEventMemory(root: string, clock: Clock): EventMemory {
  const scopesDir = resolve(root, 'scopes')

  async function access<T>(scope: ScopeId, action: keyof EventMemory, operation: (data: EventFile, file: string) => T | Promise<T>): Promise<T> {
    if (typeof scope !== 'string') throw new EventMemoryError('invalid scope id')
    try {
      assertScopeId(scope)
    } catch {
      throw new EventMemoryError('invalid scope id')
    }
    const file = join(scopesDir, scope, FILE_NAME)
    const run = async (): Promise<T> => operation(await readEvents(file, scope), file)
    try {
      if (action === 'list') return await run()
      return await withPathLock(file, run, { waitMs: 10_000 })
    } catch (error) {
      if (error instanceof EventMemoryError) throw error
      // Parser, clock and filesystem exceptions can contain private text or full paths.
      const code = isRecord(error) && typeof error.code === 'string' && /^E[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : ''
      throw new EventMemoryError(`${action} failed while accessing stored events${code}`)
    }
  }

  return {
    list(scope) {
      return access(scope, 'list', data => data.entries.map(publicEntry))
    },
    async save(scope, request) {
      const { subject, expectedRevision } = checkedTarget(request, 0)
      const { text } = request
      if (!validLine(text, MAX_TEXT)) {
        throw new EventMemoryError(`text must be nonempty single-line text of at most ${MAX_TEXT} code points without controls`, 'input')
      }
      const key = eventSubjectKey(subject)
      return access(scope, 'save', async (data, file) => {
        const index = data.entries.findIndex(entry => eventSubjectKey(entry.subject) === key)
        const current = data.entries[index]
        if (current && current.text === text && (expectedRevision === current.revision || expectedRevision === current.previousRevision)) {
          return publicEntry(current)
        }
        if (expectedRevision !== (current?.revision ?? 0)) throw new EventMemoryError('revision conflict', 'conflict')
        if (!current && data.entries.length >= MAX_ENTRIES) throw new EventMemoryError(`scope already has ${MAX_ENTRIES} events`, 'capacity')
        if (data.lastRevision === Number.MAX_SAFE_INTEGER) throw new EventMemoryError('revision limit reached')
        const updatedAt = clock.now()
        if (!isFiniteNumber(updatedAt)) throw new EventMemoryError('invalid clock timestamp')
        const revision = data.lastRevision + 1
        const entry = { subject: current?.subject ?? subject, text, revision, updatedAt, previousRevision: expectedRevision }
        if (current) data.entries[index] = entry
        else data.entries.push(entry)
        data.lastRevision = revision
        await writeJsonAtomic(file, data)
        return publicEntry(entry)
      })
    },
    async remove(scope, request) {
      const { subject, expectedRevision } = checkedTarget(request, 1)
      const key = eventSubjectKey(subject)
      return access(scope, 'remove', async (data, file) => {
        const index = data.entries.findIndex(entry => eventSubjectKey(entry.subject) === key)
        const current = data.entries[index]
        if (!current) return false
        if (expectedRevision !== current.revision) throw new EventMemoryError('revision conflict', 'conflict')
        data.entries.splice(index, 1)
        // Keep lastRevision on disk even after deleting the final event.
        await writeJsonAtomic(file, data)
        return true
      })
    },
  }
}
