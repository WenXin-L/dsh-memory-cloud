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

export function missingGist(status: string): string {
  return `(${status}，暂无总结)`
}

export function formatTimelineEntry(entry: TimelineEntryOutput): string {
  const marks = [entry.pinned ? '已固定' : '', entry.sameSession ? '' : '其他会话'].filter(mark => mark !== '')
  return `${entry.current ? '→' : ' '} #${entry.id} ${entry.date} ${entry.gist}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`
}

export function renderSearch(query: string, value: SearchOutput): string {
  const subject = query.trim() === '' ? '所选日期范围内' : `查询“${query.trim()}”`
  const lines: string[] = []
  if (value.total === 0) {
    lines.push(`${subject}没有找到片段。`)
  } else {
    const showing = value.hits.length < value.total ? `，本次列出 ${value.hits.length} 个` : ''
    lines.push(`${subject}找到 ${value.total} 个片段${showing}。`)
    for (const hit of value.hits) lines.push(formatHit(hit))
    lines.push('用 memory_read(id) 读摘要，level="raw" 读原文。')
  }
  if (value.notice !== undefined) lines.push(value.notice)
  return lines.join('\n')
}

export function renderRead(value: ReadOutput): string {
  const lines = [`#${value.id} ${value.date} · ${value.level}`]
  if (value.text !== '') lines.push(value.text)
  if (value.level === 'raw' && value.offset !== undefined && value.total !== undefined) {
    const last = value.offset + (value.count ?? 0)
    const range = value.count === 0 ? `从 offset=${value.offset} 起无记录` : `记录 ${value.offset}–${last - 1}`
    const next = value.nextOffset === undefined ? '已到末页' : `下一页 offset=${value.nextOffset}`
    const hidden = value.hiddenRecords === undefined ? '' : `，另有 ${value.hiddenRecords} 条系统记录未计入`
    lines.push(`[${range}，共 ${value.total} 条，${next}${hidden}]`)
  }
  if (value.notice !== undefined) lines.push(value.notice)
  return lines.join('\n')
}

export function renderTimeline(value: TimelineOutput): string {
  const lines = [`片段已按时间排好。→ 指向 #${value.id}`, ...value.entries.map(formatTimelineEntry)]
  if (value.notice !== undefined) lines.push(value.notice)
  return lines.join('\n')
}

export function renderFlag(action: FlagAction, value: FlagOutput): string {
  const unchanged = value.changed ? '' : '（原已如此）'
  switch (action) {
    case 'pin':
      return `#${value.id} 已固定${unchanged}。`
    case 'unpin':
      return `#${value.id} 已取消固定${unchanged}。`
    case 'hide':
      return `#${value.id} 已从记忆块和搜索结果中隐藏${unchanged}。未删除任何数据，用 memory_unhide 可恢复可见。`
    case 'unhide':
      return `#${value.id} 现在可见${unchanged}。`
  }
}
