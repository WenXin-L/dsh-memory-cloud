import { resolve } from 'node:path'
import { appendLines } from './files.ts'
import { isLogName } from './layout.ts'
import { serialize } from './lock.ts'

const EXTENSION = '.jsonl'

/**
 * Append one JSON line to `<root>/logs/<name>.jsonl`. Logs are append-only and
 * never rotated or truncated. Rejects for an invalid name or a record that
 * `JSON.stringify` cannot represent; callers on detached paths must catch.
 */
export async function appendLog(root: string, name: string, record: unknown): Promise<void> {
  const stem = name.endsWith(EXTENSION) ? name.slice(0, -EXTENSION.length) : name
  if (!isLogName(stem)) throw new TypeError(`memory store: invalid log name ${JSON.stringify(name)}`)
  const line = JSON.stringify(record)
  if (line === undefined) throw new TypeError('memory store: log record is not JSON-serializable')
  const file = resolve(root, 'logs', `${stem}${EXTENSION}`)
  await serialize(file, () => appendLines(file, [line]))
}
