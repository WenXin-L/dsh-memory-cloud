import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, vi } from 'vitest'
import { attachInjector, buildUsageSection, USAGE_SECTION_NAME } from '../../src/inject/index.ts'
import type { Injector } from '../../src/inject/index.ts'

type Listener = (...args: never[]) => unknown

function fakeContext() {
  const sections: PromptSection[] = []
  const listeners = new Map<string, Listener[]>()
  const ctx = {
    systemPrompt: {
      getSectionOrder: (name: string) => (name === 'TOOLS_SDK' ? 5000 : 0),
      section(section: PromptSection) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    on(name: string, listener: Listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(listener)
        if (index < 0) return false
        list.splice(index, 1)
        return true
      }
    },
    effect(execute: () => () => void) {
      return execute()
    },
  }
  return { ctx: ctx as unknown as Context, sections, listeners }
}

function fakeInjector() {
  return {
    preStep: vi.fn(async (_payload: unknown, next: () => Promise<PreStepDecision>) => next()),
    frozen: vi.fn(() => undefined),
    forget: vi.fn(),
    dispose: vi.fn(),
  }
}

describe('attachInjector', () => {
  it('registers the byte-stable usage section without interpolation', () => {
    const { ctx, sections } = fakeContext()
    const usageSection = buildUsageSection('zh')
    attachInjector(ctx, fakeInjector() as unknown as Injector<Agent>, { usageSection })
    expect(sections).toEqual([{ name: USAGE_SECTION_NAME, order: 5100, text: usageSection, interpolate: false }])
  })

  it('delegates agent/pre-step and forgets sessions on agent/disposed', async () => {
    const { ctx, listeners } = fakeContext()
    const injector = fakeInjector()
    attachInjector(ctx, injector as unknown as Injector<Agent>, { usageSection: 'usage', sectionOrder: 42 })

    const preStep = listeners.get('agent/pre-step')?.[0] as unknown as (payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>
    const payload = { agent: { session: { id: 's1' } } }
    const decision = await preStep(payload, async () => ({ kind: 'enter', messages: [] }))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    expect(injector.preStep).toHaveBeenCalledWith(payload, expect.any(Function))

    const disposed = listeners.get('agent/disposed')?.[0] as unknown as (payload: unknown) => void
    disposed({ agent: { session: { id: 's1' } } })
    expect(injector.forget).toHaveBeenCalledWith('s1')
  })

  it('returns a disposer that removes every registration and disposes the injector', () => {
    const { ctx, sections, listeners } = fakeContext()
    const injector = fakeInjector()
    const dispose = attachInjector(ctx, injector as unknown as Injector<Agent>, { usageSection: 'usage', sectionName: 'custom' })
    expect(sections.map(section => section.name)).toEqual(['custom'])
    dispose()
    expect(sections).toEqual([])
    expect(listeners.get('agent/pre-step')).toEqual([])
    expect(listeners.get('agent/disposed')).toEqual([])
    expect(injector.dispose).toHaveBeenCalledTimes(1)
  })
})
