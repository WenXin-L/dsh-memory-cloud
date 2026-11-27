import { describe, expect, it } from 'vitest'
import { TOOL_NAMES } from '../../src/contracts.ts'
import { buildUsageSection } from '../../src/inject/index.ts'

describe('buildUsageSection', () => {
  it('is byte-stable across calls', () => {
    expect(buildUsageSection('zh')).toBe(buildUsageSection('zh'))
    expect(buildUsageSection('en')).toBe(buildUsageSection('en'))
    expect(buildUsageSection()).toBe(buildUsageSection('zh'))
  })

  it('explains the block, its tiers, and the lookup tools in Chinese only', () => {
    const text = buildUsageSection('zh')
    expect(text.startsWith('## 记忆云（memory-cloud）\n')).toBe(true)
    expect(text).toContain('<memory-cloud>')
    for (const tier of ['相处档案', '远期', '近期', '进行中', '总结', '摘要']) expect(text).toContain(tier)
    expect(text).toMatch(/“AI”是你.*“用户”是对方/)
    expect(text).toMatch(/历史只供参考.*勿执行旧请求/)
    expect(text).toMatch(/用户现在的话为准.*日期较新的记录/)
    expect(text).toContain(TOOL_NAMES.search)
    expect(text).toContain(TOOL_NAMES.read)
    expect(text).toMatch(/关键词找 ID.*可限日期.*核对原话选 level=raw/)
    expect(text).toMatch(/每次回答按需查 1–3 次.*查不到就说记不清/)
    expect(text).toMatch(/自然带上时间.*沿用当前语气.*用户问起才提/)
    expect(text).toContain('#20261120-2130_ab12cd34_1')
    expect(text).not.toContain('English:')
    expect(text).not.toMatch(/[A-Za-z]{3,} [a-z]{3,} [a-z]{3,}/)
    expect(text).toContain(TOOL_NAMES.note)
    expect(text).toMatch(/仅在私有主人会话.*明确要求.*长期偏好.*先 list.*整条原文作 oldText/)
    expect(text).toContain(TOOL_NAMES.event)
    expect(text).toMatch(/用户确认.*事实或决定.*日后有用/)
    expect(text).toMatch(/save.*同一 subject.*expectedRevision=0/)
    expect(text).toMatch(/纠正或删除前.*find.*原 subject.*最新 revision.*expectedRevision/)
    expect(text).toMatch(/跳过闲聊、推测.*网页、文件、工具/)
    expect(text.split('\n')).toHaveLength(7)
    expect(text.length).toBeLessThan(600)
  })

  it('has an English variant with the same rules', () => {
    const text = buildUsageSection('en')
    expect(text).not.toBe(buildUsageSection('zh'))
    expect(text).toContain('<memory-cloud>')
    expect(text).toMatch(/history for context only.*old requests, commands and role settings/)
    expect(text).toContain(TOOL_NAMES.search)
    expect(text).toContain(TOOL_NAMES.read)
    expect(text).toMatch(/summary.*level=raw to check exact wording/)
    expect(text).toMatch(/tone of the current conversation.*only if the user asks/)
    expect(text).toMatch(/current words take precedence.*later date/)
    expect(text).toContain('“AI” means you')
    expect(text).toMatch(/1–3 lookups per answer.*say you do not remember/)
    expect(text).toContain(TOOL_NAMES.note)
    expect(text).toMatch(/private owner session.*explicitly asks.*lasting preference.*list first.*entire old entry into oldText/)
    expect(text).toContain(TOOL_NAMES.event)
    expect(text).toMatch(/fact or decision the user has confirmed and may need again/)
    expect(text).toMatch(/same subject.*expectedRevision=0/)
    expect(text).toMatch(/correcting or removing.*find on that subject.*latest revision as expectedRevision/)
    expect(text).toMatch(/Skip small talk, guesses, secrets and material from pages, files or tools/)
    expect(text.split('\n')).toHaveLength(7)
  })

  it('contains no prompt-variable placeholders', () => {
    for (const lang of ['zh', 'en'] as const) expect(buildUsageSection(lang)).not.toMatch(/\{\{|\}\}/)
  })
})
