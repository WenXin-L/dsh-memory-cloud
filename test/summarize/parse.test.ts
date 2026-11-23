import { describe, expect, it } from 'vitest'
import { clampImportance, isoDate, parseSummaryOutput, stripThink } from '../../src/summarize/index.ts'
import { summaryJson } from './helpers.ts'

describe('parseSummaryOutput', () => {
  it('reads the memory_save tool call first', () => {
    const parsed = parseSummaryOutput({
      text: '{"gist": "from text", "summary": "from text"}',
      toolCalls: [{ name: 'other_tool', arguments: '{}' }, { name: 'memory_save', arguments: summaryJson() }],
    })
    expect(parsed?.source).toBe('tool')
    expect(parsed?.result.gist).toBe('用户聊到明天的面试。')
    expect(parsed?.result.promises).toEqual([{ what: '面试后告诉结果', who: '用户', due: '2026-11-21' }])
  })

  it('falls back to JSON in text, ignoring <think> content', () => {
    const parsed = parseSummaryOutput({
      text: `<think>draft {"gist": "WRONG", "summary": "WRONG"}</think>\n好的：\n\`\`\`json\n${summaryJson({ gist: '正确的总结' })}\n\`\`\``,
      toolCalls: [],
    })
    expect(parsed?.source).toBe('json')
    expect(parsed?.result.gist).toBe('正确的总结')
  })

  it('finds an embedded object without fences and tolerates trailing commas', () => {
    const parsed = parseSummaryOutput({ text: '结果如下 {"总结": "一件事", "摘要": "发生了什么", "重要度": "8",} 完毕', toolCalls: [] })
    expect(parsed?.source).toBe('json')
    expect(parsed?.result).toMatchObject({ gist: '一件事', summary: '发生了什么', importance: 8 })
  })

  it('falls back to delimiter sections', () => {
    const text = [
      '好的，整理如下。',
      '===总结===',
      '用户周末和小林去爬山。',
      '===摘要===',
      '## 时间/参与者',
      '2026-11-21，用户和小林',
      '## 发生了什么',
      '一起爬了梧桐山。',
      '===进行中===',
      '- 下次去大鹏',
      '===重要度===',
      '85',
      '===关键词===',
      '爬山、梧桐山, 小林',
      '===人物===',
      '- 小林',
      '===日期===',
      '- 2026年11月28日：去大鹏',
      '===承诺===',
      '- 下周发照片（谁：小林；截止：2026-11-30）',
    ].join('\n')
    const parsed = parseSummaryOutput({ text, toolCalls: [] })
    expect(parsed?.source).toBe('delimited')
    expect(parsed?.result).toEqual({
      gist: '用户周末和小林去爬山。',
      summary: '## 时间/参与者\n2026-11-21，用户和小林\n## 发生了什么\n一起爬了梧桐山。',
      ongoing: ['下次去大鹏'],
      importance: 9,
      keywords: ['爬山', '梧桐山', '小林'],
      people: ['小林'],
      dates: [{ date: '2026-11-28', what: '去大鹏' }],
      promises: [{ what: '下周发照片', who: '小林', due: '2026-11-30' }],
    })
  })

  it('escapes raw newlines and tabs inside JSON strings', () => {
    const raw = '{"gist": "小林说下周三搬去杭州", "summary": "## 发生了什么\n小林要搬家。\r\n\n## 约定/待办\n- AI\t提醒打包", "importance": 7, "keywords": ["搬家"]}'
    expect(() => JSON.parse(raw)).toThrow()
    const fromTool = parseSummaryOutput({ text: '', toolCalls: [{ name: 'memory_save', arguments: raw }] })
    expect(fromTool?.source).toBe('tool')
    expect(fromTool?.result).toMatchObject({ gist: '小林说下周三搬去杭州', summary: '## 发生了什么\n小林要搬家。\n\n## 约定/待办\n- AI\t提醒打包', importance: 7, keywords: ['搬家'] })
    const fenced = parseSummaryOutput({ text: `结果：\n\`\`\`json\n${raw.replace('"importance": 7,', '"importance": 7,\n')}\n\`\`\``, toolCalls: [] })
    expect(fenced?.source).toBe('json')
    expect(fenced?.result.summary).toContain('## 约定/待办\n- AI')
    const escaped = parseSummaryOutput({ text: '{"gist": "a\\"\nb", "summary": "引号\\\\\n下一行"}', toolCalls: [] })
    expect(escaped?.result).toMatchObject({ gist: 'a" b', summary: '引号\\\n下一行' })
  })

  it('drops echoed placeholder items from the format skeletons', () => {
    const skeleton = parseSummaryOutput({
      text: '',
      toolCalls: [{
        name: 'memory_save',
        arguments: JSON.stringify({
          gist: '用户和小林约好周末爬山。',
          summary: '## 发生了什么\n约爬山。',
          ongoing: ['…'],
          importance: '<1-10 的整数>',
          keywords: ['...', '爬山', '<关键词>'],
          people: ['-', '小林'],
          dates: [{ date: 'YYYY-MM-DD', what: '…' }, { date: '2026-11-28', what: '…' }],
          promises: [{ what: '…', who: '…', due: 'YYYY-MM-DD' }, { what: '发照片', who: '…' }],
        }),
      }],
    })
    expect(skeleton?.result).toMatchObject({ ongoing: [], importance: 5, keywords: ['爬山'], people: ['小林'], dates: [], promises: [{ what: '发照片' }] })

    const delimited = parseSummaryOutput({
      text: [
        '===总结===',
        '用户和小林约好周末爬山。',
        '===摘要===',
        '## 发生了什么',
        '约爬山。',
        '===进行中===',
        '（每行一项，没有写"无"）',
        '===重要度===',
        '（1–10 的整数）',
        '===关键词===',
        '- …',
        '- 爬山',
        '===人物===',
        '- ...',
        '===日期===',
        '（每行一项，格式"YYYY-MM-DD：事件"，没有写"无"）',
        '===承诺===',
        '（每行一项，格式"事项（谁：某人；截止：YYYY-MM-DD）"，没有写"无"）',
        '- 发照片（谁：…；截止：2026-11-30）',
      ].join('\n'),
      toolCalls: [],
    })
    expect(delimited?.result).toMatchObject({ ongoing: [], importance: 5, keywords: ['爬山'], people: [], dates: [], promises: [{ what: '发照片', due: '2026-11-30' }] })
    expect(parseSummaryOutput({ text: '', toolCalls: [{ name: 'memory_save', arguments: '{"gist": "…", "summary": "…"}' }] })).toBeUndefined()
  })

  it('accepts heading and bold label styles', () => {
    const parsed = parseSummaryOutput({ text: '**Gist:** We met.\n\n## Summary\n### What happened\nWe met at the cafe.', toolCalls: [] })
    expect(parsed?.result.gist).toBe('We met.')
    expect(parsed?.result.summary).toBe('### What happened\nWe met at the cafe.')
  })

  it('rejects output with an empty gist or summary', () => {
    expect(parseSummaryOutput({ text: '', toolCalls: [{ name: 'memory_save', arguments: summaryJson({ gist: '   ' }) }] })).toBeUndefined()
    expect(parseSummaryOutput({ text: 'I am sorry, I cannot help.', toolCalls: [] })).toBeUndefined()
    expect(parseSummaryOutput({ text: '<think>only thinking</think>', toolCalls: [] })).toBeUndefined()
  })

  it('normalizes loose field types', () => {
    const parsed = parseSummaryOutput({
      text: '',
      toolCalls: [{
        name: 'memory_save',
        arguments: JSON.stringify(JSON.stringify({
          gist: '多行\n总结',
          summary: { 发生了什么: '聊天', 关键事实: ['喜欢猫', '不喜欢狗'] },
          ongoing: '无',
          importance: 0,
          keywords: '猫，狗；猫',
          people: [' 小林 ', '小林'],
          dates: ['2026/11/21 09:05 看医生', { date: 'tomorrow', what: 'bad' }, { when: '2026-12-01', event: '生日' }],
          promises: ['记得提醒', { content: '买猫粮', owner: '我', deadline: 'soon' }],
        })),
      }],
    })
    expect(parsed?.result).toEqual({
      gist: '多行 总结',
      summary: '## 发生了什么\n聊天\n\n## 关键事实\n喜欢猫\n不喜欢狗',
      ongoing: [],
      importance: 1,
      keywords: ['猫', '狗'],
      people: ['小林'],
      dates: [{ date: '2026-11-21T09:05', what: '看医生' }, { date: '2026-12-01', what: '生日' }],
      promises: [{ what: '记得提醒' }, { what: '买猫粮', who: '我' }],
    })
  })
})

describe('helpers', () => {
  it('strips think blocks, dangling closes, and unterminated opens', () => {
    expect(stripThink('<think>a</think>答案')).toBe('答案')
    expect(stripThink('推理过程</think>\n答案')).toBe('答案')
    expect(stripThink('答案<think>没写完')).toBe('答案')
    expect(stripThink('<thinking>x</thinking>A<think>y</think>B')).toBe('AB')
  })

  it('clamps importance, rescaling 0–1 and 0–100 scales', () => {
    expect(clampImportance(0.7)).toBe(7)
    expect(clampImportance('0.35')).toBe(4)
    expect(clampImportance(85)).toBe(9)
    expect(clampImportance('60分')).toBe(6)
    expect(clampImportance(100)).toBe(10)
    expect(clampImportance(11)).toBe(1)
    expect(clampImportance(101)).toBe(10)
    expect(clampImportance(10)).toBe(10)
    expect(clampImportance(1)).toBe(1)
    expect(clampImportance(0)).toBe(1)
    expect(clampImportance(-3)).toBe(1)
    expect(clampImportance('7分')).toBe(7)
    expect(clampImportance(6.6)).toBe(7)
    expect(clampImportance('high')).toBe(5)
  })

  it('normalizes ISO dates', () => {
    expect(isoDate('2026-11-21')).toBe('2026-11-21')
    expect(isoDate('2026年1月5日')).toBe('2026-01-05')
    expect(isoDate('2026-11')).toBe('2026-11')
    expect(isoDate('2026-13-01')).toBeUndefined()
    expect(isoDate('2026-02-31')).toBeUndefined()
    expect(isoDate('2026-02-29')).toBeUndefined()
    expect(isoDate('2028-02-29')).toBe('2028-02-29')
    expect(isoDate('2026-04-31')).toBeUndefined()
    expect(isoDate('2026-12-31')).toBe('2026-12-31')
    expect(isoDate('2026-11-21 09:75')).toBe('2026-11-21')
    expect(isoDate('下周三')).toBeUndefined()
  })
})
