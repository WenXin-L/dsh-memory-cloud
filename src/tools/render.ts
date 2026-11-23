export type ReadLevel = 'summary' | 'gist' | 'raw'

export interface SearchHitOutput {
  id: string
  date: string
  gist: string
  score: number
}

export interface SearchOutput {
  total: number
  hits: SearchHitOutput[]
  notice?: string
}

export interface ReadOutput {
  id: string
  /** Local start time `YYYY-MM-DD HH:mm`. */
  date: string
  level: ReadLevel
  text: string
  truncated: boolean
  /**
   * Raw paging: index of this page's first record in the view, which is the
   * episode's conversation records by default and every stored record with
   * `includeSystem`.
   */
  offset?: number
  /** Raw paging: view records consumed by this page, including ones without text. */
  count?: number
  /** Raw paging: records in the view. */
  total?: number
  /** Raw paging: episode records left out of the default view (system reminders, injected blocks, log events). */
  hiddenRecords?: number
  nextOffset?: number
  notice?: string
}

export interface TimelineEntryOutput {
  id: string
  date: string
  gist: string
  status: string
  current: boolean
  sameSession: boolean
  pinned: boolean
}

export interface TimelineOutput {
  id: string
  entries: TimelineEntryOutput[]
  notice?: string
}

export interface FlagOutput {
  id: string
  pinned: boolean
  hidden: boolean
  changed: boolean
}

export type FlagAction = 'pin' | 'unpin' | 'hide' | 'unhide'

export function formatHit(hit: SearchHitOutput): string {
  return `#${hit.id} ${hit.date} ${hit.gist}`
}

export function formatTimelineEntry(entry: TimelineEntryOutput): string {
  const marks = [entry.pinned ? 'pinned' : '', entry.sameSession ? '' : 'other session'].filter(mark => mark !== '')
  return `${entry.current ? '→' : ' '} #${entry.id} ${entry.date} ${entry.gist}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`
}

export function renderSearch(query: string, value: SearchOutput): string {
  const subject = query.trim() === '' ? 'in range' : `match "${query.trim()}"`
  const lines: string[] = []
  if (value.total === 0) {
    lines.push(`No memories ${subject}.`)
  } else {
    const showing = value.hits.length < value.total ? `, showing ${value.hits.length}` : ''
    lines.push(`${value.total} ${value.total === 1 ? 'memory' : 'memories'} ${subject}${showing}:`)
    for (const hit of value.hits) lines.push(formatHit(hit))
    lines.push('memory_read(id) returns the summary; level "raw" returns the original transcript.')
  }
  if (value.notice !== undefined) lines.push(value.notice)
  return lines.join('\n')
}

export function renderRead(value: ReadOutput): string {
  const lines = [`#${value.id} ${value.date} · ${value.level}`]
  if (value.text !== '') lines.push(value.text)
  if (value.level === 'raw' && value.offset !== undefined && value.total !== undefined) {
    const last = value.offset + (value.count ?? 0)
    const range = value.count === 0 ? `no records from ${value.offset}` : `records ${value.offset}–${last - 1}`
    const next = value.nextOffset === undefined ? '; end' : `; next offset ${value.nextOffset}`
    const hidden = value.hiddenRecords === undefined ? '' : `; ${value.hiddenRecords} system records hidden`
    lines.push(`[${range} of ${value.total}${next}${hidden}]`)
  }
  if (value.notice !== undefined) lines.push(value.notice)
  return lines.join('\n')
}

export function renderTimeline(value: TimelineOutput): string {
  const lines = [`Timeline around #${value.id}:`, ...value.entries.map(formatTimelineEntry)]
  if (value.notice !== undefined) lines.push(value.notice)
  return lines.join('\n')
}

export function renderFlag(action: FlagAction, value: FlagOutput): string {
  const unchanged = value.changed ? '' : ' (no change)'
  switch (action) {
    case 'pin':
      return `#${value.id} is pinned${unchanged}.`
    case 'unpin':
      return `#${value.id} is no longer pinned${unchanged}.`
    case 'hide':
      return `#${value.id} is hidden from memory blocks and search${unchanged}; nothing was deleted and memory_unhide restores it.`
    case 'unhide':
      return `#${value.id} is visible again${unchanged}.`
  }
}
