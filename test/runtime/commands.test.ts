import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { runMemoryCommand } from '../../src/commands/index.ts'
import type { MemoryCommandDeps } from '../../src/commands/index.ts'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import type { MemoryCloudStatus } from '../../src/runtime/status.ts'
import { decideUnmatched, detectCoexistence } from '../../src/scope/index.ts'

const agent = { session: { id: 'sess-1' } } as unknown as Agent

function status(overrides: Partial<MemoryCloudStatus> = {}): MemoryCloudStatus {
  return {
    storageRoot: '/tmp/memory-cloud',
    configured: { level: 3, compactionMode: 'auto', unmatchedSessions: 'auto' },
    firewall: decideUnmatched('auto'),
    agent: {
      sessionId: 'sess-1',
      subagent: false,
      scope: { scope: OWNER_SCOPE, capture: true, private: true, reason: 'no scope rule matched; using the owner scope' },
      mode: { mode: 'assist', configured: 'auto', engineActive: false, reason: 'auto：此 agent 的压缩由宿主引擎负责' },
      capacity: { route: { provider: 'deepseek', model: 'deepseek-chat' }, capacity: { contextWindow: 131072, reservedOutputTokens: 8192 }, known: true },
      budget: {
        level: 3, thresholdTokens: 114688, thresholdRatio: 0.875, retainTokens: 24576, memoryBudgetTokens: 24576,
        quotas: { profile: 2304, recent: 12672, distant: 8064, ongoing: 1536 },
        recentSummaryCount: 6, recentSummaryTokens: 800, gistTokens: 50, recallLimitTokens: 8192,
      },
      pressure: 0.42,
    },
    scopes: [{ scope: 'owner', episodes: { open: 1, sealed: 0, summarized: 12, failed: 1 }, pinned: 1, hidden: 0, rollups: 2 }],
    jobs: {
      started: true, stopped: false, queue: [], quota: { day: '2026-11-23', used: 3, limit: 200 },
      breaker: { open: false, consecutiveFailures: 0 }, totals: { succeeded: 3, failed: 0, timedOut: 0, cancelled: 0, deferred: 0 },
    },
    takeover: { kind: 'preset', editable: true, presets: [{ entryId: 'preset-standard', presetId: 'standard', state: 'available', recorded: false }] },
    coexistence: detectCoexistence(['dsh-taskfold/plugins']),
    registrations: { tools: true, command: true, problems: [] },
    fallbacks: [],
    ...overrides,
  }
}

function deps(overrides: Partial<MemoryCommandDeps> = {}): MemoryCommandDeps {
  return {
    status: async () => status(),
    setLevel: vi.fn(async () => ({ ok: true, via: 'settings' }) as const),
    setMode: vi.fn(async () => ({ ok: true, via: 'settings' }) as const),
    compactNow: async () => ({ ok: true, text: 'compacted' }),
    summarizeNow: async () => ({ ok: true, text: 'queued' }),
    rebuild: async () => ({ ok: true, text: 'rebuilt' }),
    takeover: async () => ({ kind: 'preset', ok: true, action: 'applied' }),
    restore: async () => ({ kind: 'preset', ok: false, code: 'overridden', message: 'home patch overrides it' }),
    backfill: async () => ({ ok: false, text: 'not supported' }),
    ...overrides,
  }
}

const run = (dependencies: MemoryCommandDeps, rawInput: string) => runMemoryCommand(dependencies, { agent, rawInput, signal: new AbortController().signal })

describe('/memory', () => {
  it('renders status by default with mode, budget, counts, jobs, takeover, and coexistence', async () => {
    const result = await run(deps(), '')
    expect(result.kind).toBe('success')
    const text = result.kind === 'success' ? result.text ?? '' : ''
    expect(text).toContain('模式：assist')
    expect(text).toContain('压缩阈值 112K')
    expect(text).toContain('记忆块 24K')
    expect(text).toContain('上下文压力 42%')
    expect(text).toContain('summarized 12 · failed 1')
    expect(text).toContain('今日 3/200')
    expect(text).toContain('接管压缩（预设 standard）：可接管压缩')
    expect(text).toContain('dsh-taskfold')
    expect(text).toContain('- 未匹配规则的会话：使用私有 owner 作用域，可以读取主人记忆（unmatchedSessions=auto，未检测到已知聊天桥接插件）')
  })

  it('shows that unmatched sessions are isolated while a chat bridge is loaded', async () => {
    const result = await run(deps({ status: async () => status({ firewall: decideUnmatched('auto', ['qqbot']) }) }), 'status')
    const text = result.kind === 'success' ? result.text ?? '' : ''
    expect(text).toContain('- 未匹配规则的会话：各自隔离，无权读取主人记忆（unmatchedSessions=auto，检测到聊天桥接插件 qqbot）。只把你独用的会话标签映射到 owner。')
  })

  it('distinguishes a fallback to host thresholds from a fallback to host summaries', async () => {
    const result = await run(deps({ status: async () => status({ fallbacks: [{ stage: 'threshold', kind: 'budget-error', sessionId: 's-1', detail: 'model lookup failed', at: 10 }] }) }), 'status')
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('最近一次回退到宿主压缩阈值：budget-error（threshold，会话 s-1，model lookup failed）') })
  })

  it('preserves the cause when the takeover report is unavailable', async () => {
    const result = await run(deps({ status: async () => status({ takeover: { kind: 'preset', editable: false, presets: [], error: 'profile /test unavailable' } }) }), 'status')
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('读取压缩接管状态失败 — profile /test unavailable') })
  })

  it('validates and persists level and mode', async () => {
    const dependencies = deps()
    await expect(run(dependencies, ' level  4 ')).resolves.toMatchObject({ kind: 'success' })
    expect(dependencies.setLevel).toHaveBeenCalledWith(4)
    await expect(run(dependencies, 'level 0')).resolves.toMatchObject({ kind: 'error' })
    await expect(run(dependencies, 'MODE Engine')).resolves.toMatchObject({ kind: 'success' })
    expect(dependencies.setMode).toHaveBeenCalledWith('engine')
    await expect(run(dependencies, 'mode turbo')).resolves.toMatchObject({ kind: 'error' })
    expect(dependencies.setLevel).toHaveBeenCalledTimes(1)
    expect(dependencies.setMode).toHaveBeenCalledTimes(1)
    const failing = deps({ setLevel: async () => ({ ok: false, message: 'no settings service' }) })
    await expect(run(failing, 'level 2')).resolves.toEqual({ kind: 'error', text: '保存压缩档位失败 — no settings service' })
  })

  it('reports takeover outcomes, unknown subcommands, and handler failures as results', async () => {
    await expect(run(deps(), 'takeover')).resolves.toMatchObject({ kind: 'success', text: expect.stringContaining('已接管') })
    await expect(run(deps(), 'restore standard')).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('overridden') })
    await expect(run(deps(), 'help')).resolves.toMatchObject({ kind: 'success', text: expect.stringMatching(/\/memory backfill[^\n]*尚未实现/) })
    await expect(run(deps(), 'backfill')).resolves.toEqual({ kind: 'error', text: 'not supported' })
    await expect(run(deps(), 'frobnicate')).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('/memory status') })
    const throwing = deps({ compactNow: async () => { throw new Error('busy') } })
    await expect(run(throwing, 'compact-now')).resolves.toEqual({ kind: 'error', text: '/memory compact-now 失败：busy' })
  })
})
