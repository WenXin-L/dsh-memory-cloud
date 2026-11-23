import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import type { CompactionMode } from '../../src/contracts.ts'
import { createModeResolver, decideMode } from '../../src/runtime/mode.ts'
import { createBackgroundRoute } from '../../src/runtime/route.ts'
import { detectCoexistence } from '../../src/scope/index.ts'

const none = detectCoexistence([])
const taskfold = detectCoexistence(['dsh-taskfold/plugins'])

describe('decideMode', () => {
  it.each([
    ['off', true, none, 'off'],
    ['off', false, none, 'off'],
    ['assist', true, none, 'assist'],
    ['engine', true, none, 'engine'],
    ['engine', false, none, 'assist'],
    ['engine', true, taskfold, 'engine'],
    ['auto', true, none, 'engine'],
    ['auto', false, none, 'assist'],
    ['auto', true, taskfold, 'assist'],
  ] satisfies [CompactionMode, boolean, typeof none, string][])('%s with engine=%s resolves to %s', (configured, engineActive, coexistence, expected) => {
    const decision = decideMode(configured, engineActive, coexistence)
    expect(decision).toMatchObject({ configured, engineActive, mode: expected })
    expect(decision.reason.length).toBeGreaterThan(0)
  })

  it('names the conflicting plugin and the takeover hint', () => {
    expect(decideMode('auto', true, taskfold).reason).toContain('dsh-taskfold')
    expect(decideMode('auto', false, none).reason).toContain('/memory takeover')
  })
})

describe('createModeResolver', () => {
  it('recomputes a cached decision when the agent\'s compaction service is a different object', () => {
    const ours = { memory: true }
    const basic = { memory: false }
    let service: object = basic
    const coexistence = vi.fn(() => none)
    const modes = createModeResolver({
      configured: () => 'auto',
      compactionService: () => service,
      engineOwns: value => value === ours,
      coexistence,
    })
    const agent = {} as Agent

    expect(modes.modeFor(agent)).toMatchObject({ mode: 'assist', engineActive: false })
    expect(modes.modeFor(agent)).toMatchObject({ mode: 'assist' })
    expect(coexistence).toHaveBeenCalledTimes(1)

    service = ours
    expect(modes.modeFor(agent)).toMatchObject({ mode: 'engine', engineActive: true })
    expect(modes.modeFor(agent)).toMatchObject({ mode: 'engine' })
    expect(coexistence).toHaveBeenCalledTimes(2)
  })

  it('treats a throwing service lookup as no engine', () => {
    const modes = createModeResolver({
      configured: () => 'engine',
      compactionService: () => { throw new Error('registry gone') },
      engineOwns: value => value !== undefined,
      coexistence: () => none,
    })
    expect(modes.modeFor({} as Agent)).toMatchObject({ mode: 'assist', engineActive: false })
  })
})

describe('createBackgroundRoute', () => {
  const setup = (configured: { provider: string; model: string; reasoningEffort: string }, known: readonly string[]) => {
    const onFallback = vi.fn()
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => {
      if (!known.includes(`${provider}/${model}`)) throw new Error(`unknown model ${model}`)
      return { id: model }
    })
    const route = createBackgroundRoute({
      configured: () => configured,
      defaultRoute: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      resolveModelInfo,
      onFallback,
      now: () => 0,
    })
    return { route, onFallback, resolveModelInfo }
  }

  it('uses the default provider for an empty provider and keeps a resolvable model', async () => {
    const { route, onFallback } = setup({ provider: '', model: 'deepseek-flash', reasoningEffort: 'off' }, ['deepseek/deepseek-flash'])
    await expect(route()).resolves.toEqual({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'off' })
    expect(onFallback).not.toHaveBeenCalled()
  })

  it('falls back to the default model once when the configured model cannot be resolved', async () => {
    const { route, onFallback, resolveModelInfo } = setup({ provider: '', model: 'deepseek-flash', reasoningEffort: '' }, [])
    await expect(route()).resolves.toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    await expect(route()).resolves.toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(onFallback.mock.calls[0]?.[2]).toContain('unknown model')
    expect(resolveModelInfo).toHaveBeenCalledTimes(1)
  })

  it('uses the default model when the model field is empty, without a lookup', async () => {
    const { route, resolveModelInfo } = setup({ provider: '', model: '', reasoningEffort: '' }, [])
    await expect(route()).resolves.toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })

  it('honours an explicit provider/model pair that resolves', async () => {
    const { route } = setup({ provider: 'other', model: 'small', reasoningEffort: 'low' }, ['other/small'])
    await expect(route()).resolves.toEqual({ provider: 'other', model: 'small', reasoningEffort: 'low' })
  })
})
