import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ENGINE_HEADROOM_TOKENS } from '../../src/engine/index.ts'
import { resolveBudget } from '../../src/pack/index.ts'
import { createBudgetService, FALLBACK_CONTEXT_WINDOW, MEMORY_SHARE } from '../../src/runtime/budget.ts'

const K = 1024

function agentOn(model: string): Agent {
  return { session: { requestHeader: () => ({ config: { provider: 'fake', model } }) }, options: {} } as unknown as Agent
}

function setup() {
  return createBudgetService({
    resolveModelInfo: async (_provider, model) => model === 'known-1' ? { context: { contextWindow: 128 * K } } : {},
    defaultRoute: () => ({ provider: 'fake', model: 'mystery-1' }),
    level: () => 3,
    overrides: () => ({}),
    now: () => 0,
  })
}

describe('budget service', () => {
  it('sizes the memory block and recall for a conservative 32K window when the model reports none', async () => {
    const budgets = setup()
    const unknown = agentOn('mystery-1')
    expect(FALLBACK_CONTEXT_WINDOW).toBe(32 * K)

    const report = await budgets.capacityFor(unknown)
    expect(report).toEqual({ route: { provider: 'fake', model: 'mystery-1' }, capacity: { contextWindow: 32 * K, reservedOutputTokens: 0 }, known: false })

    const expected = resolveBudget({ level: 3, overrides: {}, capacity: report.capacity, headroomTokens: DEFAULT_ENGINE_HEADROOM_TOKENS, memoryShare: MEMORY_SHARE })
    expect(await budgets.budgetFor(unknown)).toEqual(expected)
    expect(budgets.budgetNow(unknown)).toEqual(expected)
    expect(await budgets.levelBudget()).toEqual(expected)
    expect(budgets.knownWindow(unknown)).toBeUndefined()

    const known = await budgets.budgetFor(agentOn('known-1'))
    expect((await budgets.capacityFor(agentOn('known-1'))).known).toBe(true)
    expect(expected.memoryBudgetTokens).toBeLessThan(known.memoryBudgetTokens)
    expect(expected.recallLimitTokens).toBeLessThanOrEqual(known.recallLimitTokens)
  })

  it('reports no level budget until the default model lookup has completed', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let route: { provider: string; model: string } | undefined
    const budgets = createBudgetService({
      resolveModelInfo: async () => {
        await held
        return { context: { contextWindow: 128 * K }, defaultMaxTokens: 1024 }
      },
      defaultRoute: () => route,
      level: () => 3,
      overrides: () => ({}),
      now: () => 0,
    })
    expect(budgets.levelBudgetKnown()).toBeUndefined()
    route = { provider: 'fake', model: 'known-1' }
    expect(budgets.levelBudgetKnown()).toBeUndefined()
    release()
    const resolved = await budgets.levelBudget()
    expect(budgets.levelBudgetKnown()).toEqual(resolved)
    expect(resolved.quotas.distant).toBeGreaterThan((await setup().levelBudget()).quotas.distant)
  })
})
