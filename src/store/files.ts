import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const FILE_MODE = 0o600
export const DIR_MODE = 0o700

const PRESERVE_ATTEMPTS = 1000

export function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function writeTextAtomic(file: string, content: string | Uint8Array): Promise<void> {
  await writeFileAtomic(file, content, { mode: FILE_MODE, dirMode: DIR_MODE })
}

/** Serialize `value` as JSON (pretty unless `compact`), write it atomically, and return the exact text written. */
export async function writeJsonAtomic(file: string, value: unknown, options: { readonly compact?: boolean } = {}): Promise<string> {
  const text = `${options.compact === true ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`
  await writeTextAtomic(file, text)
  return text
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

export async function listDirectories(dir: string): Promise<string[]> {
  return (await listEntries(dir)).filter(entry => entry.directory).map(entry => entry.name)
}

export async function listFiles(dir: string): Promise<string[]> {
  return (await listEntries(dir)).filter(entry => !entry.directory).map(entry => entry.name)
}

async function listEntries(dir: string): Promise<{ readonly name: string; readonly directory: boolean }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

/**
 * Append complete lines to an append-only log. A previous writer that died
 * mid-line left no trailing newline; a separator is added first so the torn
 * fragment stays on its own line instead of swallowing the next record.
 */
export async function appendLines(file: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE })
  const handle = await open(file, 'a+', FILE_MODE)
  try {
    const { size } = await handle.stat()
    let separator = ''
    if (size > 0) {
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, size - 1)
      if (last[0] !== 0x0a) separator = '\n'
    }
    await handle.appendFile(`${separator}${lines.join('\n')}\n`)
  } finally {
    await handle.close()
  }
}

/**
 * Keep a byte-exact copy of `file` as `<file>.<suffix>` (or `<file>.<suffix>-<k>`
 * when taken). Callers hold the file's writer lock, so the existence probe and
 * the write do not race other writers of this store.
 * @returns the copy's path, or undefined when `file` no longer exists.
 */
export async function preserveCopy(file: string, suffix: string): Promise<string | undefined> {
  let content: Buffer
  try {
    content = await readFile(file)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  for (let attempt = 0; attempt < PRESERVE_ATTEMPTS; attempt += 1) {
    const target = attempt === 0 ? `${file}.${suffix}` : `${file}.${suffix}-${attempt}`
    if (await pathExists(target)) continue
    await writeTextAtomic(target, content)
    return target
  }
  throw new Error(`memory store: could not find a free name to preserve ${file}`)
}
