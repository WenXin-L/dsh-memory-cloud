import { describe, expect, it } from 'vitest'
import { truncateToTokens } from '../../src/summarize/index.ts'
import { estimator } from './helpers.ts'

describe('truncateToTokens', () => {
  it('keeps the last sentence end', () => {
    const text = `用户说了一件很重要的事情然后就走了。${'很长的没有标点的内容'.repeat(10)}`
    expect(truncateToTokens(text, 30, estimator)).toBe('用户说了一件很重要的事情然后就走了。')
  })

  it('does not count the dot of a numbered list marker as a sentence end', () => {
    const text = `## 发生了什么\n用户说了一件事。\n1. ${'很长的事项'.repeat(30)}`
    expect(truncateToTokens(text, 30, estimator)).toBe('## 发生了什么\n用户说了一件事。')
  })

  it('drops trailing list markers and headings left without a body', () => {
    const heading = `## 发生了什么\n用户说了一件事。\n\n## 约定/待办\n${'没有标点的很长待办'.repeat(30)}`
    expect(truncateToTokens(heading, 30, estimator)).toBe('## 发生了什么\n用户说了一件事。')
    const marker = `## 发生了什么\n用户说了一件事。\n-\n${'没有标点的很长待办'.repeat(30)}`
    expect(truncateToTokens(marker, 30, estimator)).toBe('## 发生了什么\n用户说了一件事。')
  })

  it('hard-cuts when only a heading would remain', () => {
    const text = `## 发生了什么\n${'没有标点的很长内容'.repeat(30)}`
    const cut = truncateToTokens(text, 30, estimator)
    expect(cut.startsWith('## 发生了什么\n没有标点')).toBe(true)
    expect(cut.endsWith('…')).toBe(true)
    expect(estimator.estimate(cut)).toBeLessThanOrEqual(30)
  })
})
