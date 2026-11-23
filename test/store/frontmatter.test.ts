import { describe, expect, it } from 'vitest'
import type { EpisodeId, RollupEntry, ScopeId } from '../../src/contracts.ts'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import { parseRollupFile, parseTierFile, renderRollupFile, renderTierFile, splitFrontmatter } from '../../src/store/index.ts'
import type { TierFrontmatter } from '../../src/store/index.ts'

const summaryFront: TierFrontmatter = {
  id: '20261120-2130_ab12cd34_7' as EpisodeId,
  scope: OWNER_SCOPE,
  sessionId: '12345678',
  tier: 'summary',
  seq: { first: 10, last: 42 },
  time: { start: Date.UTC(2026, 10, 20, 13, 30), end: Date.UTC(2026, 10, 20, 14, 10, 5, 123) },
  provider: 'true',
  model: 'deepseek-flash',
  promptVersion: 'v2: "companion"\nline two',
  summarizedAt: Date.UTC(2026, 10, 21, 1, 2, 3),
  tokens: 321,
  importance: 7,
  keywords: ['咖啡', 'a, b', '#tag', '21:30'],
  people: ['小明'],
  dates: [{ date: '2026-12-01', what: '生日' }],
  promises: [{ what: '下周一起爬山', who: 'user', due: '2026-11-30' }, { what: 'call mom' }],
  ongoing: ['找工作'],
}

const gistFront: TierFrontmatter = {
  id: '20261120-2130_ab12cd34_7' as EpisodeId,
  scope: 'qq-group-42' as ScopeId,
  sessionId: 'ses_ab12cd34',
  tier: 'gist',
  seq: { first: 10, last: 42 },
  time: { start: Date.UTC(2026, 10, 20, 13, 30) },
  provider: 'deepseek',
  model: 'deepseek-flash',
  promptVersion: '1.0',
  summarizedAt: Date.UTC(2026, 10, 21, 1, 2, 3),
  tokens: 12,
}

describe('tier frontmatter', () => {
  it('round-trips every field, including ambiguous strings and CJK', () => {
    const body = '小明说他喜欢咖啡。\n---\nnot a delimiter\n'
    const document = parseTierFile(renderTierFile(summaryFront, body))
    expect(document.frontmatter).toEqual(summaryFront)
    expect(document.body).toBe(body)
  })

  it('renders readable YAML-style lines and quotes values YAML would misread', () => {
    const text = renderTierFile(summaryFront, 'body')
    const lines = text.split('\n')
    expect(lines[0]).toBe('---')
    expect(lines).toContain('id: 20261120-2130_ab12cd34_7')
    expect(lines).toContain('sessionId: "12345678"')
    expect(lines).toContain('provider: "true"')
    expect(lines).toContain('model: deepseek-flash')
    expect(lines).toContain('seq: [10,42]')
    expect(lines).toContain('time: ["2026-11-20T13:30:00.000Z","2026-11-20T14:10:05.123Z"]')
    expect(lines).toContain('promptVersion: "v2: \\"companion\\"\\nline two"')
    expect(lines).toContain('tokens: 321')
  })

  it('omits absent optional fields and the end time', () => {
    const text = renderTierFile(gistFront, 'gist')
    expect(text).not.toMatch(/^(people|dates|promises|ongoing|importance|keywords):/m)
    expect(text).toContain('promptVersion: "1.0"')
    expect(parseTierFile(text).frontmatter).toEqual(gistFront)
  })

  it.each(['', 'line', 'line\n', 'line\n\n', '\n', 'a\r\nb\r'])('round-trips the body %j exactly', body => {
    expect(parseTierFile(renderTierFile(gistFront, body)).body).toBe(body)
  })

  it('treats text without frontmatter as a plain body', () => {
    const text = '只是一段手写的摘要\n---\n'
    expect(parseTierFile(text)).toEqual({ fields: {}, body: text })
    expect(parseTierFile('---\nid: x\nno closing delimiter')).toEqual({ fields: {}, body: '---\nid: x\nno closing delimiter' })
  })

  it('keeps raw fields but no typed frontmatter when required fields are missing', () => {
    const document = parseTierFile('---\nid: 20261120-2130_ab12cd34_7\ntier: summary\n---\nbody')
    expect(document.frontmatter).toBeUndefined()
    expect(document.fields).toEqual({ id: '20261120-2130_ab12cd34_7', tier: 'summary' })
    expect(document.body).toBe('body')
  })

  it('reads hand-edited CRLF frontmatter', () => {
    const text = renderTierFile(gistFront, 'body').replaceAll('\n', '\r\n')
    expect(parseTierFile(text).frontmatter).toEqual(gistFront)
  })

  it('round-trips values containing U+2028 and U+2029 and escapes them on disk', () => {
    const front: TierFrontmatter = {
      ...summaryFront,
      model: 'm\u2028x',
      dates: [{ date: '2026-12-01', what: '去咖啡馆\u2028带伞' }],
      ongoing: ['a\u2029b'],
    }
    const text = renderTierFile(front, 'body\u2028line')
    expect(text.slice(0, text.lastIndexOf('---'))).not.toMatch(/[\u2028\u2029]/)
    const document = parseTierFile(text)
    expect(document.frontmatter).toEqual(front)
    expect(document.body).toBe('body\u2028line')
  })

  it('reads hand-edited values with raw U+2028 and U+2029', () => {
    const split = splitFrontmatter('---\nwhat: "a\u2028b"\nlist: ["c\u2029d"]\nplain: e\u2028f\n---\n')
    expect(split?.fields).toEqual({ what: 'a\u2028b', list: ['c\u2029d'], plain: 'e\u2028f' })
  })

  it('parses hand-written YAML scalars', () => {
    const split = splitFrontmatter('---\na: \'it\'\'s\'\nb: 12\nc: true\nd: ~\ne:\nf: plain text\n# comment\ng: [1, "x"]\n---\n')
    expect(split?.fields).toEqual({ a: 'it\'s', b: 12, c: true, d: null, e: null, f: 'plain text', g: [1, 'x'] })
    expect(split?.body).toBe('')
  })
})

describe('rollup frontmatter', () => {
  it('round-trips a rollup entry', () => {
    const entry: RollupEntry = {
      id: '2026-W47',
      scope: OWNER_SCOPE,
      period: { kind: 'week', key: '2026-W47' },
      episodeIds: ['20261116-0900_ab12cd34_1' as EpisodeId, '20261120-2130_ab12cd34_2' as EpisodeId],
      from: Date.UTC(2026, 10, 16),
      to: Date.UTC(2026, 10, 22, 23, 59, 59, 999),
      tokens: 88,
      file: 'rollups/2026-W47.md',
      createdAt: Date.UTC(2026, 10, 23),
    }
    const document = parseRollupFile(renderRollupFile(entry, '这一周主要在聊咖啡和工作。'))
    expect(document.entry).toEqual(entry)
    expect(document.body).toBe('这一周主要在聊咖啡和工作。')
  })
})
