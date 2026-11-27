import { eventSubjectKey, type EventMemoryEntry } from '../store/event-memory.ts'
import { queryTerms, tokenize } from './text.ts'

export const MAX_EVENT_QUERY_CHARS = 2048

/** A full subject wins first. Subject matches outrank incidental mentions in a fact's body. */
export function rankEventMemories(entries: readonly EventMemoryEntry[], query: string): EventMemoryEntry[] {
  const phrase = query.trim().slice(0, MAX_EVENT_QUERY_CHARS)
  if (phrase === '') return [...entries].sort((a, b) => b.revision - a.revision)
  const key = eventSubjectKey(phrase)
  const terms = queryTerms(phrase, false)
  const matches: { entry: EventMemoryEntry; exact: boolean; subjectHits: number; textHits: number }[] = []
  for (const entry of entries) {
    const exact = eventSubjectKey(entry.subject) === key
    const subject = new Set(tokenize(entry.subject).terms)
    const body = new Set(tokenize(entry.text).terms)
    const subjectHits = terms.filter(term => subject.has(term)).length
    const textHits = terms.filter(term => body.has(term)).length
    // A lone incidental body word in a longer question is too weak for automatic recall.
    if (exact || subjectHits > 0 || (textHits > 0 && textHits >= Math.min(2, terms.length))) {
      matches.push({ entry, exact, subjectHits, textHits })
    }
  }
  return matches.sort((a, b) => Number(b.exact) - Number(a.exact) || b.subjectHits - a.subjectHits
    || b.textHits - a.textHits || b.entry.revision - a.entry.revision).map(match => match.entry)
}
