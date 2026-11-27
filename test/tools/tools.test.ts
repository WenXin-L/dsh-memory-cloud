import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, {
  assertObjectJsonSchema, assertSupportedJsonSchema, defineTool, ToolArgsError, validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { ScopeDecision, ScopeId } from '../../src/contracts.ts'
import {
  COMPACT_CHECKPOINT_SOURCE_KIND, EVENT_MEMORY_SOURCE_KIND, MEMORY_SOURCE_KIND, OWNER_SCOPE, RUNTIME_CONTEXT_SOURCE_KIND, SYNTHETIC_SOURCE_KINDS,
} from '../../src/contracts.ts'
import { EMPTY_EPISODE_ERROR } from '../../src/runtime/sources.ts'
import { createEventMemory, EventMemoryError } from '../../src/store/event-memory.ts'
import { createProfileNotes, type ProfileNoteResult } from '../../src/store/profile-notes.ts'
import { createMemorySearch, createMemoryTools, MEMORY_TOOL_NAMES, recallPolicy, registerMemoryTools } from '../../src/tools/index.ts'
import type { EventFindOutput, FlagOutput, MemoryToolCaller, MemoryToolDeps, ReadOutput, SearchOutput, TimelineOutput } from '../../src/tools/index.ts'
import { assistantRecord, at, estimator, eventRecord, stepRecord, toolResultRecord, userRecord, withTempStore } from './helpers.ts'
import type { FakeStore, SeedEpisode } from './helpers.ts'

const NOW = at(2026, 11, 23, 12)
const owner = OWNER_SCOPE
const group = 'qq-group-42' as ScopeId
const agent = { name: 'fake-agent' } as unknown as MemoryToolCaller

const CAT = '20261101-1000_aaaa1111_1'
const SHOPPING = '20261103-0800_aaaa1111_2'
const TRIP = '20261105-2100_aaaa1111_3'
const TS = '20261110-0900_bbbb2222_1'
const SECRET = '20261112-0900_bbbb2222_2'
const LONG = '20261114-0900_bbbb2222_3'
const RAW = '20261120-1000_dddd4444_1'
const GROUP_CAT = '20261121-1200_hhhh8888_1'

const rawAt = (minute: number): number => at(2026, 11, 20, 10, minute)

const rawRecords = [
  stepRecord(rawAt(0), 101),
  userRecord('我把红色雨伞忘在咖啡馆了', rawAt(1), 102),
  userRecord('<system-reminder>cwd: /work</system-reminder>', rawAt(1), 103, { kind: RUNTIME_CONTEXT_SOURCE_KIND }),
  assistantRecord('别担心，明天可以回去问店员。', rawAt(2), 104),
  userRecord('<memory-events>已确认的决定</memory-events>', rawAt(3), 105, { kind: EVENT_MEMORY_SOURCE_KIND }),
  userRecord('<memory-cloud>旧记忆</memory-cloud>', rawAt(3), 106, { kind: MEMORY_SOURCE_KIND }),
  userRecord('好的，谢谢你提醒我。', rawAt(4), 107, null),
  assistantRecord('我查一下营业时间。', rawAt(5), 108, { id: 'c1', name: 'find_shop', arguments: '{"name":"咖啡馆"}' }),
  toolResultRecord('c1', '营业到晚上九点', rawAt(5), 109),
  userRecord('<compacted-summary>早先的对话</compacted-summary>', rawAt(6), 110, { kind: COMPACT_CHECKPOINT_SOURCE_KIND }),
  eventRecord('compaction/summary-error', { error: 'summary failed' }, rawAt(6), 111),
  eventRecord('turn/end', { turn: 1, reason: { kind: 'completed' } }, rawAt(6), 112),
  assistantRecord('不客气，记得带上小票。', rawAt(7), 113),
  userRecord('Tools changed: find_shop was added.', rawAt(7), 114, { kind: 'tool-registry' }),
  eventRecord('request/header', { turn: 2, step: 1 }, rawAt(8), 115),
  userRecord('小票在钱包里。', rawAt(8), 116),
]

const conversationLines = [
  '#102 10:01 user: 我把红色雨伞忘在咖啡馆了',
  '#104 10:02 assistant: 别担心，明天可以回去问店员。',
  '#107 10:04 user: 好的，谢谢你提醒我。',
  '#108 10:05 assistant: 我查一下营业时间。\n→ find_shop({"name":"咖啡馆"})',
  '#109 10:05 ← tool: 营业到晚上九点',
  '#113 10:07 assistant: 不客气，记得带上小票。',
  '#116 10:08 user: 小票在钱包里。',
]

const pageSeqs = (text: string): number[] => [...text.matchAll(/^#(\d+) /gm)].map(match => Number(match[1]))

const ownerCorpus: SeedEpisode[] = [
  { id: CAT, sessionId: 's-a', startedAt: at(2026, 11, 1, 10), gist: '聊了猫粮品牌，决定买皇家猫粮。', summary: '用户的猫咪小橘挑食，我们比较了几个猫粮品牌，决定试试皇家猫粮。', keywords: ['猫粮'], people: ['小橘'] },
  { id: SHOPPING, sessionId: 's-a', startedAt: at(2026, 11, 3, 8), gist: '整理了购物清单。', summary: '牛奶、鸡蛋，猫粮快吃完了。', keywords: ['购物'] },
  { id: TRIP, sessionId: 's-a', startedAt: at(2026, 11, 5, 21), gist: '计划周末去杭州。', summary: '用户和小明计划去杭州西湖。', keywords: ['杭州'], people: ['小明'] },
  { id: TS, sessionId: 's-b', startedAt: at(2026, 11, 10, 9), gist: 'Helped with TypeScript generics.', summary: 'We discussed TypeScript generics.', keywords: ['typescript'] },
  { id: SECRET, sessionId: 's-b', startedAt: at(2026, 11, 12, 9), gist: '不想再提的事。', summary: '用户要求忘掉这件事。', hidden: true },
  { id: LONG, sessionId: 's-b', startedAt: at(2026, 11, 14, 9), gist: '一次很长的聊天。', summary: '今天我们聊了很多事情。'.repeat(300), keywords: ['长谈'] },
  { id: RAW, sessionId: 's-c', startedAt: at(2026, 11, 20, 10), status: 'sealed', raw: rawRecords },
]

interface Harness {
  readonly store: FakeStore
  readonly deps: MemoryToolDeps
  readonly state: { pressure: number; limit: number; decision: ScopeDecision; scopeError: Error | undefined }
  call<T>(name: string, args: Record<string, unknown>, caller?: MemoryToolCaller | null): Promise<{ value: T; text: string }>
}

const ownerDecision: ScopeDecision = { scope: owner, capture: true, private: true, reason: 'owner session' }

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  await withTempStore(async store => {
    await store.seed(owner, ownerCorpus)
    await store.seed(group, [{ id: GROUP_CAT, sessionId: 's-g', startedAt: at(2026, 11, 21, 12), gist: '群里拼单买猫粮。', summary: '群友拼单买猫粮。', keywords: ['猫粮'] }])
    const state: Harness['state'] = { pressure: 0, limit: 8192, decision: ownerDecision, scopeError: undefined }
    const clock = { now: () => NOW }
    const notes = createProfileNotes(store.root)
    vi.spyOn(notes, 'apply')
    const deps: MemoryToolDeps = {
      store,
      notes,
      events: createEventMemory(store.root, clock),
      search: createMemorySearch({ store, estimator }),
      scopeFor: vi.fn(() => {
        if (state.scopeError !== undefined) throw state.scopeError
        return state.decision
      }),
      pressure: () => state.pressure,
      recallLimitTokens: () => state.limit,
      estimator,
      clock,
    }
    const tools = new Map(createMemoryTools(deps).map(definition => [definition.name, definition]))
    const call = async <T,>(name: string, args: Record<string, unknown>, caller: MemoryToolCaller | null = agent) => {
      const definition = tools.get(name)!
      const exec = { agent: caller ?? undefined, signal: new AbortController().signal } as unknown as ToolRunContext
      const value = await definition.execute(args, exec)
      const snapshot: unknown = JSON.parse(JSON.stringify(value))
      expect(value).toStrictEqual(snapshot)
      expect(validateJsonSchemaValue(definition.output.schema, snapshot, 'value')).toEqual([])
      const content = definition.output.render(args, snapshot as never)
      expect(JSON.parse(JSON.stringify(content))).toStrictEqual(content)
      return { value: snapshot as T, text: content.map(block => block.type === 'text' ? block.text : '').join('\n') }
    }
    await run({ store, deps, state, call })
  })
}

describe('tool definitions', () => {
  it('build through defineTool with output contracts and register on the real ToolsService', async () => {
    await withHarness(async ({ deps }) => {
      const definitions = createMemoryTools(deps)
      const names = Object.values(MEMORY_TOOL_NAMES)
      expect(definitions.map(definition => definition.name)).toEqual(names)
      for (const definition of definitions) {
        assertObjectJsonSchema(definition.parameters)
        assertSupportedJsonSchema(definition.output.schema)
        expect(typeof definition.output.render).toBe('function')
      }

      const ctx = new Context()
      const promptFiber = await ctx.plugin(SystemPrompt)
      const toolsFiber = await ctx.plugin(ToolsService)
      const service = ctx.get('tools')!
      const dispose = registerMemoryTools({ tools: service }, deps)
      expect(service.definitions().map(definition => definition.name).sort()).toEqual([...names].sort())
      expect(service.schemas().find(schema => schema.name === MEMORY_TOOL_NAMES.read)?.parameters).toMatchObject({ required: ['id'] })
      const noteSchema = service.schemas().find(schema => schema.name === 'memory_note')?.parameters
      expect(noteSchema?.required).toEqual(['action'])
      expect(noteSchema?.properties).toEqual({
        action: expect.objectContaining({ type: 'string', enum: ['list', 'add', 'replace', 'remove'] }),
        text: expect.objectContaining({ type: 'string' }), oldText: expect.objectContaining({ type: 'string' }),
      })
      const event = service.definitions().find(definition => definition.name === 'memory_event')!
      expect(event.parameters.required).toEqual(['action'])
      expect(event.parameters.properties).toEqual({
        action: expect.objectContaining({ type: 'string', enum: ['find', 'save', 'remove'] }),
        query: expect.objectContaining({ type: 'string' }),
        subject: expect.objectContaining({ type: 'string' }),
        text: expect.objectContaining({ type: 'string' }),
        expectedRevision: expect.objectContaining({ type: 'integer' }),
      })
      for (const invalid of [
        {}, { revision: '2' }, { revision: 2, removed: true }, { removed: true, text: 'private' },
        { total: 1, entries: [{ subject: 'topic', text: 'fact', revision: 1 }] },
      ]) {
        expect(validateJsonSchemaValue(event.output.schema, invalid)).not.toEqual([])
      }
      expect(() => registerMemoryTools({ tools: service }, deps)).toThrow(/already registered/)
      expect(service.definitions()).toHaveLength(names.length)
      dispose()
      dispose()
      expect(service.definitions()).toEqual([])

      const blocker: ToolDefinition = defineTool({
        name: MEMORY_TOOL_NAMES.timeline,
        description: 'occupies a name',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'x',
      })
      const unblock = service.register(blocker)
      expect(() => registerMemoryTools({ tools: service }, deps)).toThrow(/already registered/)
      expect(service.definitions().map(definition => definition.name)).toEqual([MEMORY_TOOL_NAMES.timeline])
      unblock()
      toolsFiber.dispose()
      promptFiber.dispose()
    })
  })

  it('rejects arguments that violate the parameter schema', async () => {
    await withHarness(async ({ call }) => {
      await expect(call(MEMORY_TOOL_NAMES.read, {})).rejects.toBeInstanceOf(ToolArgsError)
      await expect(call(MEMORY_TOOL_NAMES.read, { id: CAT, level: 'everything' })).rejects.toBeInstanceOf(ToolArgsError)
    })
  })
})

describe('memory_search', () => {
  it('returns the true total, ranked hits, and a compact rendering', async () => {
    await withHarness(async ({ call }) => {
      const { value, text } = await call<SearchOutput>(MEMORY_TOOL_NAMES.search, { query: '猫粮品牌', limit: 1 })
      expect(value.total).toBe(2)
      expect(value.hits.map(hit => hit.id)).toEqual([CAT])
      expect(text).toContain('2 memories match "猫粮品牌", showing 1:')
      expect(text).toContain(`#${CAT} 2026-11-01 聊了猫粮品牌，决定买皇家猫粮。`)
    })
  })

  it('applies from/to and rejects bad dates', async () => {
    await withHarness(async ({ call }) => {
      const { value } = await call<SearchOutput>(MEMORY_TOOL_NAMES.search, { query: '猫粮', from: '2026-11-02', to: '2026-11-30' })
      expect(value.hits.map(hit => hit.id)).toEqual([SHOPPING])
      await expect(call(MEMORY_TOOL_NAMES.search, { query: 'x', from: 'yesterday' })).rejects.toMatchObject({ code: 'MEMORY_INVALID_ARGS' })
      await expect(call(MEMORY_TOOL_NAMES.search, { query: 'x', from: '2026-12-01', to: '2026-11-01' })).rejects.toMatchObject({ code: 'MEMORY_INVALID_ARGS' })
    })
  })

  it('reads dotted dates like dashed ones and rejects dates V8 would guess at', async () => {
    await withHarness(async ({ call }) => {
      const dotted = await call<SearchOutput>(MEMORY_TOOL_NAMES.search, { query: '', from: '2026.11.03', to: '2026.11.05' })
      expect(dotted.value.hits.map(hit => hit.id)).toEqual([TRIP, SHOPPING])
      for (const bound of [{ to: '11-20' }, { from: '11-20' }, { to: 'Nov 20 2026' }, { from: '2026-11-01', to: '11-20' }, { to: '2026-02-30T10:00' }]) {
        await expect(call(MEMORY_TOOL_NAMES.search, { query: '', ...bound }), JSON.stringify(bound)).rejects.toMatchObject({ code: 'MEMORY_INVALID_ARGS' })
      }
    })
  })

  it('drops hits that do not fit the recall cap but keeps the total', async () => {
    await withHarness(async ({ call, state }) => {
      state.limit = 70
      const { value } = await call<SearchOutput>(MEMORY_TOOL_NAMES.search, { query: '', limit: 50 })
      expect(value.total).toBe(6)
      expect(value.hits.length).toBeGreaterThan(0)
      expect(value.hits.length).toBeLessThan(6)
      expect(value.notice).toMatch(/left out to save context/)
    })
  })
})

describe('memory_read', () => {
  it('returns the summary without frontmatter and re-promotes the episode', async () => {
    await withHarness(async ({ call, store }) => {
      const { value, text } = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: `#${CAT}` })
      expect(value).toMatchObject({ id: CAT, level: 'summary', truncated: false, date: '2026-11-01 10:00' })
      expect(value.text).toBe('用户的猫咪小橘挑食，我们比较了几个猫粮品牌，决定试试皇家猫粮。')
      expect(text.startsWith(`#${CAT} 2026-11-01 10:00 · summary\n`)).toBe(true)
      expect(store.calls.updateEpisode).toEqual([{ scope: owner, id: CAT, patch: { strength: 2, lastRecalledAt: NOW } }])
      expect(store.meta(owner, CAT)).toMatchObject({ strength: 2, lastRecalledAt: NOW })
    })
  })

  it('re-promotes from the strength current at write time, not the one read before', async () => {
    await withHarness(async ({ call, store }) => {
      const update = store.updateEpisode.bind(store)
      store.updateEpisode = async (scope, id, patch) => {
        await update(scope, id, { strength: 5 })
        return update(scope, id, patch)
      }
      await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: CAT })
      expect(store.meta(owner, CAT)).toMatchObject({ strength: 6, lastRecalledAt: NOW })
    })
  })

  it('does not re-promote gist reads or episodes without a summary', async () => {
    await withHarness(async ({ call, store }) => {
      const gist = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: CAT, level: 'gist' })
      expect(gist.value.text).toBe('聊了猫粮品牌，决定买皇家猫粮。')
      const pending = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: RAW })
      expect(pending.value.text).toBe('')
      expect(pending.value.notice).toMatch(/not summarized yet \(status: sealed\).*level "raw"/)
      expect(store.calls.updateEpisode).toEqual([])
    })
  })

  it('pages raw conversation records as compact text and re-promotes', async () => {
    await withHarness(async ({ call, store }) => {
      const first = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: `#${RAW}`, level: 'raw', limit: 4 })
      expect(first.value).toMatchObject({ id: RAW, level: 'raw', offset: 0, count: 4, total: 7, hiddenRecords: 9, nextOffset: 4, truncated: false })
      expect(first.value.text).toBe(conversationLines.slice(0, 4).join('\n'))
      expect(first.text).toContain('[records 0–3 of 7; next offset 4; 9 system records hidden]')
      const last = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: RAW, level: 'raw', offset: 4, limit: 10 })
      expect(last.value).toMatchObject({ offset: 4, count: 3, total: 7, hiddenRecords: 9 })
      expect(last.value.text).toBe(conversationLines.slice(4).join('\n'))
      expect(last.value.nextOffset).toBeUndefined()
      expect(last.text).toContain('[records 4–6 of 7; end; 9 system records hidden]')
      const past = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: RAW, level: 'raw', offset: 50 })
      expect(past.value).toMatchObject({ offset: 50, count: 0, total: 7, text: '' })
      expect(past.value.notice).toBe('Offset 50 is past the end of this episode (7 conversation records).')
      expect(store.calls.updateEpisode.map(call => call.patch)).toEqual([{ strength: 2, lastRecalledAt: NOW }])
    })
  })

  it('counts one recall per raw read, however many pages it takes', async () => {
    await withHarness(async ({ call, store }) => {
      for (let read = 0; read < 2; read++) {
        let offset: number | undefined = 0
        let pages = 0
        while (offset !== undefined) {
          const { value }: { value: ReadOutput } = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: RAW, level: 'raw', offset, limit: 2 })
          offset = value.nextOffset
          pages++
        }
        expect(pages).toBe(4)
      }
      expect(store.meta(owner, RAW)).toMatchObject({ strength: 3, lastRecalledAt: NOW })
    })
  })

  it('hides system reminders, injected blocks and log events unless includeSystem is set', async () => {
    await withHarness(async ({ call }) => {
      const plain = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: RAW, level: 'raw', limit: 200 })
      expect(plain.value).toMatchObject({ offset: 0, count: 7, total: 7, hiddenRecords: 9 })
      expect(plain.value.text).toBe(conversationLines.join('\n'))
      for (const kind of [...SYNTHETIC_SOURCE_KINDS, 'tool-registry']) expect(plain.text).not.toContain(`[${kind}]`)
      expect(plain.text).not.toMatch(/system-reminder|memory-cloud|memory-events|compacted-summary|\[(compaction|request|step|turn)\//)

      const system = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: RAW, level: 'raw', limit: 200, includeSystem: true })
      expect(system.value).toMatchObject({ offset: 0, count: 16, total: 16 })
      expect(system.value.hiddenRecords).toBeUndefined()
      expect(system.value.nextOffset).toBeUndefined()
      for (const kind of SYNTHETIC_SOURCE_KINDS) expect(system.value.text).toContain(`user[${kind}]: `)
      expect(system.value.text).toContain('#103 10:01 user[runtime-context]: <system-reminder>cwd: /work</system-reminder>')
      expect(system.value.text).toContain('#114 10:07 user[tool-registry]: Tools changed: find_shop was added.')
      expect(system.value.text).toContain('#111 10:06 [compaction/summary-error]: {"error":"summary failed"}')
      expect(pageSeqs(system.value.text)).toEqual([102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 113, 114, 116])
      expect(system.text).toContain('[records 0–15 of 16; end]')
    })
  })

  it('continues raw paging across hidden records without loss or duplication', async () => {
    await withHarness(async ({ call }) => {
      const pages: ReadOutput[] = []
      let offset: number | undefined = 0
      while (offset !== undefined) {
        const { value }: { value: ReadOutput } = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: RAW, level: 'raw', offset, limit: 2 })
        pages.push(value)
        offset = value.nextOffset
      }
      expect(pages.map(page => [page.offset, page.count, page.total])).toEqual([[0, 2, 7], [2, 2, 7], [4, 2, 7], [6, 1, 7]])
      expect(pages.flatMap(page => pageSeqs(page.text))).toEqual([102, 104, 107, 108, 109, 113, 116])

      const systemSeqs: number[] = []
      offset = 0
      let systemPages = 0
      while (offset !== undefined) {
        const { value }: { value: ReadOutput } = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: RAW, level: 'raw', offset, limit: 5, includeSystem: true })
        expect(value).toMatchObject({ offset, total: 16 })
        systemSeqs.push(...pageSeqs(value.text))
        systemPages++
        offset = value.nextOffset
      }
      expect(systemPages).toBe(4)
      expect(systemSeqs).toEqual([102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 113, 114, 116])
    })
  })

  it('stops a raw page at the token cap and continues from the next offset', async () => {
    await withHarness(async ({ call, state }) => {
      state.limit = 60
      const { value } = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: RAW, level: 'raw' })
      expect(value.truncated).toBe(true)
      expect(value.nextOffset).toBeGreaterThan(0)
      expect(value.nextOffset).toBeLessThan(7)
      const next = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: RAW, level: 'raw', offset: value.nextOffset })
      expect(pageSeqs(next.value.text)[0]).toBe(pageSeqs(conversationLines.join('\n'))[value.nextOffset!])
    })
  })

  it('points to includeSystem when an episode has no conversation records', async () => {
    await withHarness(async ({ call, store }) => {
      const quiet = '20261122-0900_eeee5555_1'
      await store.seed(owner, [{
        id: quiet,
        startedAt: at(2026, 11, 22, 9),
        status: 'sealed',
        raw: [stepRecord(rawAt(0), 1), userRecord('<system-reminder/>', rawAt(0), 2, { kind: RUNTIME_CONTEXT_SOURCE_KIND })],
      }])
      const { value, text } = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: quiet, level: 'raw' })
      expect(value).toMatchObject({ text: '', offset: 0, count: 0, total: 0, hiddenRecords: 2 })
      expect(value.notice).toBe('This episode has no conversation records; includeSystem: true shows its 2 system records.')
      expect(text).toContain('[no records from 0 of 0; end; 2 system records hidden]')
      expect(store.calls.updateEpisode).toEqual([])
    })
  })
})

describe('memory_note', () => {
  const original = 'Keep API names in English.'
  const corrected = 'Keep API and CLI names in English.'
  const requests = [
    { action: 'list' },
    { action: 'add', text: original },
    { action: 'replace', oldText: original, text: corrected },
    { action: 'remove', oldText: corrected },
  ] as const

  it('resolves scope once and shows the full profile only on list', async () => {
    await withHarness(async ({ call, deps }) => {
      const entriesAfter = [[], [original], [corrected], []]
      for (const [index, request] of requests.entries()) {
        const entries = entriesAfter[index]!
        const apply = vi.mocked(deps.notes.apply).mockClear()
        const resolve = vi.mocked(deps.scopeFor).mockClear()
        const { value, text } = await call<ProfileNoteResult>(MEMORY_TOOL_NAMES.note, request)
        expect(resolve.mock.calls).toEqual([[agent]])
        expect(apply.mock.calls).toEqual([[request]])
        expect(value).toMatchObject({ usedChars: entries.join('\n').length, changed: request.action !== 'list' })
        expect(value.limitChars).toBeGreaterThan(0)
        expect(text).toContain(`${value.usedChars}/${value.limitChars} characters`)
        if (request.action === 'list') {
          expect(value.entries).toEqual([])
          expect(text).toContain('No entries.')
        } else {
          expect(value).not.toHaveProperty('entries')
          expect(text).toContain('updated')
          expect(text).not.toContain('English')
        }
      }
    })
  })

  it('requires the entire old entry for replace and remove', async () => {
    await withHarness(async ({ call }) => {
      await call(MEMORY_TOOL_NAMES.note, { action: 'add', text: original })
      for (const request of [
        { action: 'replace', oldText: 'API names', text: corrected },
        { action: 'remove', oldText: ` ${original}` },
      ]) {
        await expect(call(MEMORY_TOOL_NAMES.note, request)).rejects.toThrow(/exact/i)
      }
      const listed = await call<ProfileNoteResult>(MEMORY_TOOL_NAMES.note, { action: 'list' })
      expect(listed.value.entries).toEqual([original])
      expect(listed.text).toContain(`- ${original}`)
    })
  })

  it('reports malformed arguments before touching notes', async () => {
    await withHarness(async ({ call, deps }) => {
      for (const args of [{}, { action: 'clear' }, { action: 'add', text: 42 }]) {
        await expect(call(MEMORY_TOOL_NAMES.note, args)).rejects.toBeInstanceOf(ToolArgsError)
      }
      for (const args of [
        { action: 'list', text: 'extra' }, { action: 'list', scope: 'owner' },
        { action: 'add' }, { action: 'add', text: '   ' }, { action: 'add', oldText: original, text: corrected },
        { action: 'replace', text: corrected }, { action: 'replace', oldText: original },
        { action: 'remove', text: original }, { action: 'remove', oldText: original, text: corrected },
      ]) {
        await expect(call(MEMORY_TOOL_NAMES.note, args)).rejects.toMatchObject({ code: 'MEMORY_INVALID_ARGS' })
      }
      expect(deps.notes.apply).not.toHaveBeenCalled()
    })
  })

  it('keeps owner notes inaccessible for every action outside a private owner session', async () => {
    await withHarness(async ({ call, state, deps }) => {
      for (const decision of [
        { ...ownerDecision, private: false },
        { ...ownerDecision, scope: group, private: false },
        { ...ownerDecision, scope: 'session-isolated' as ScopeId, private: false },
        { ...ownerDecision, scope: group, private: true },
      ]) {
        state.decision = decision
        for (const request of requests) {
          const resolve = vi.mocked(deps.scopeFor).mockClear()
          await expect(call(MEMORY_TOOL_NAMES.note, request)).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
          expect(resolve.mock.calls).toEqual([[agent]])
        }
      }
      expect(deps.notes.apply).not.toHaveBeenCalled()
    })
  })

  it('allows a private owner to list notes with capture disabled and blocks every mutation', async () => {
    await withHarness(async ({ call, state, deps }) => {
      await call(MEMORY_TOOL_NAMES.note, { action: 'add', text: original })
      state.decision = { ...ownerDecision, capture: false }
      const apply = vi.mocked(deps.notes.apply).mockClear()
      vi.mocked(deps.scopeFor).mockClear()
      const [list, ...mutations] = requests
      const listed = await call<ProfileNoteResult>(MEMORY_TOOL_NAMES.note, list)
      expect(listed.value).toMatchObject({ entries: [original], usedChars: original.length, changed: false })
      for (const request of mutations) {
        await expect(call(MEMORY_TOOL_NAMES.note, request)).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
      }
      expect(apply.mock.calls).toEqual([[list]])
      expect(deps.scopeFor).toHaveBeenCalledTimes(requests.length)
    })
  })

  it('fails closed when the caller or the scope decision is missing', async () => {
    await withHarness(async ({ call, state, deps }) => {
      state.scopeError = new Error('resolver failed')
      for (const request of requests) {
        const resolve = vi.mocked(deps.scopeFor).mockClear()
        await expect(call(MEMORY_TOOL_NAMES.note, request, null)).rejects.toMatchObject({ code: 'MEMORY_NO_AGENT' })
        expect(resolve).not.toHaveBeenCalled()
        await expect(call(MEMORY_TOOL_NAMES.note, request)).rejects.toMatchObject({ code: 'MEMORY_SCOPE_UNAVAILABLE' })
        expect(resolve.mock.calls).toEqual([[agent]])
      }
      expect(deps.notes.apply).not.toHaveBeenCalled()
    })
  })
})

describe('memory_event', () => {
  const name = 'memory_event'
  const subject = 'Atlas release'
  const original = 'Ship on Friday.'
  const correction = 'Ship on Monday.'
  const create = { action: 'save', subject, text: original, expectedRevision: 0 }
  const find = { action: 'find', query: subject }

  it('creates, finds, revises and removes the same subject with content-free write receipts', async () => {
    await withHarness(async ({ call }) => {
      const saved = await call<{ revision: number }>(name, create)
      expect(saved.value).toEqual({ revision: 1 })
      expect(saved.text).toBe('Saved at revision 1.')
      const initial = await call<EventFindOutput>(name, find)
      const entry = { subject, text: original, revision: 1, updatedAt: NOW }
      expect(initial.value).toEqual({ total: 1, entries: [entry] })
      expect(JSON.parse(initial.text)).toEqual(initial.value)

      const firstRevision = initial.value.entries[0]!.revision
      const updated = await call<{ revision: number }>(name, { ...create, text: correction, expectedRevision: firstRevision })
      expect(updated.value).toEqual({ revision: 2 })
      for (const stale of [
        { ...create, text: 'Stale overwrite', expectedRevision: firstRevision },
        { action: 'remove', subject, expectedRevision: firstRevision },
      ]) {
        await expect(call(name, stale)).rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT', message: expect.stringMatching(/find.*revision/i) })
      }
      const current = await call<EventFindOutput>(name, find)
      expect(current.value).toEqual({ total: 1, entries: [{ ...entry, text: correction, revision: 2 }] })
      const remove = { action: 'remove', subject, expectedRevision: current.value.entries[0]!.revision }
      const removed = await call(name, remove)
      expect(removed).toEqual({ value: { removed: true }, text: 'Removed.' })
      expect((await call(name, remove)).value).toEqual({ removed: false })
      expect((await call(name, find)).value).toEqual({ total: 0, entries: [] })
    })
  })

  it('returns the five most recently revised entries or the five best subject and text matches', async () => {
    await withHarness(async ({ call }) => {
      await call(name, { ...create, subject: 'Compass' })
      for (let i = 1; i <= 6; i++) {
        await call(name, { ...create, subject: `Stop ${i}`, text: 'Check the compass here.' })
      }
      for (const args of [{ action: 'find' }, { action: 'find', query: '' }, { action: 'find', query: '   ' }]) {
        const { value } = await call<EventFindOutput>(name, args)
        expect(value.total).toBe(7)
        expect(value.entries.map(entry => entry.subject)).toEqual(['Stop 6', 'Stop 5', 'Stop 4', 'Stop 3', 'Stop 2'])
      }
      const match = await call<EventFindOutput>(name, { action: 'find', query: 'compass' })
      expect(match.value.total).toBe(7)
      expect(match.value.entries).toHaveLength(5)
      expect(match.value.entries[0]?.subject).toBe('Compass')
      expect((await call(name, { action: 'find', query: 'volcano' })).value).toEqual({ total: 0, entries: [] })
    })
  })

  it('checks the caller on every operation and again before returning the room’s events', async () => {
    await withHarness(async ({ call, deps, state }) => {
      const resolve = vi.mocked(deps.scopeFor)
      await call(name, create)
      const room = { scope: group, capture: true, private: false, reason: 'room' }
      state.decision = room
      expect((await call(name, find)).value).toEqual({ entries: [], total: 0 })
      await call(name, { ...create, text: 'Room decision.' })
      state.decision = { ...room, capture: false }
      const listed = await call<EventFindOutput>(name, find)
      expect(listed.value.entries).toEqual([{ subject, text: 'Room decision.', revision: 1, updatedAt: NOW }])
      const remove = { action: 'remove', subject, expectedRevision: 1 }
      for (const mutation of [{ ...create, expectedRevision: 1 }, remove]) {
        await expect(call(name, mutation)).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
      }
      state.decision = { ...ownerDecision, private: false }
      for (const args of [find, create, remove]) {
        await expect(call(name, args)).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
      }
      state.decision = room
      expect((await call(name, remove)).value).toEqual({ removed: true })
      state.decision = ownerDecision
      expect((await call<EventFindOutput>(name, find)).value.entries[0]?.text).toBe(original)
      // Eleven calls to the tool, with a second scope check on the three successful finds.
      expect(resolve.mock.calls).toEqual(Array.from({ length: 14 }, () => [agent]))
    })
  })

  it('validates action-specific arguments and caller identity before accessing storage', async () => {
    await withHarness(async ({ call, deps, state }) => {
      const accesses = [vi.spyOn(deps.events, 'list'), vi.spyOn(deps.events, 'save'), vi.spyOn(deps.events, 'remove')]
      for (const args of [{}, { action: 'list' }, { ...find, query: 3 }, { ...create, expectedRevision: 1.5 }]) {
        await expect(call(name, args)).rejects.toBeInstanceOf(ToolArgsError)
      }
      for (const args of [
        { ...find, subject }, { ...find, scope: group }, { ...create, scope: group }, { ...create, query: subject },
        { action: 'save', subject, text: original }, { ...create, subject: '  ' }, { ...create, text: '' },
        { ...create, expectedRevision: -1 }, { ...create, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
        { action: 'remove', subject }, { action: 'remove', subject, expectedRevision: 0 },
        { action: 'remove', subject, expectedRevision: 1, text: original },
      ]) await expect(call(name, args), JSON.stringify(args)).rejects.toMatchObject({ code: 'MEMORY_INVALID_ARGS' })
      state.scopeError = new Error('scope lookup failed')
      for (const args of [find, create, { action: 'remove', subject, expectedRevision: 1 }]) {
        await expect(call(name, args, null)).rejects.toMatchObject({ code: 'MEMORY_NO_AGENT' })
        await expect(call(name, args)).rejects.toMatchObject({ code: 'MEMORY_SCOPE_UNAVAILABLE' })
      }
      for (const access of accesses) expect(access).not.toHaveBeenCalled()
    })
  })

  it('fits structured and rendered finds to the recall cap and keeps writes available under pressure', async () => {
    await withHarness(async ({ call, deps, state }) => {
      const text = '已确认"东"\\北。'.repeat(60)
      await call(name, { ...create, text })
      state.limit = 160
      for (const [pressure, cap] of [[0, 160], [0.7, 80]] as const) {
        state.pressure = pressure
        const found = await call<EventFindOutput>(name, find)
        expect(estimator.estimate(JSON.stringify(found.value))).toBeLessThanOrEqual(cap)
        expect(estimator.estimate(found.text)).toBeLessThanOrEqual(cap)
        expect(found.value.entries[0]).toMatchObject({ subject, revision: 1, text: expect.stringMatching(/…$/u) })
      }
      state.limit = 1
      await expect(call(name, find)).rejects.toMatchObject({ code: 'MEMORY_RECALL_PAUSED' })
      state.pressure = 0.95
      const list = vi.spyOn(deps.events, 'list')
      await expect(call(name, find)).rejects.toMatchObject({ code: 'MEMORY_RECALL_PAUSED', message: expect.stringContaining('95% full') })
      expect(list).not.toHaveBeenCalled()
      expect((await call(name, { ...create, text: correction, expectedRevision: 1 })).value).toEqual({ revision: 2 })
      expect((await call(name, { action: 'remove', subject, expectedRevision: 2 })).value).toEqual({ removed: true })
    })
  })

  it('distinguishes store validation and capacity errors without echoing private input', async () => {
    await withHarness(async ({ call, deps }) => {
      const invalid = call(name, { ...create, text: 'private\nfact' })
      await expect(invalid).rejects.toMatchObject({ code: 'MEMORY_INVALID_ARGS', message: expect.stringMatching(/line/) })
      await expect(invalid).rejects.not.toThrow(/private|events\.json/)
      vi.spyOn(deps.events, 'save').mockRejectedValueOnce(new EventMemoryError('/private/scope', 'capacity'))
      const full = call(name, create)
      await expect(full).rejects.toMatchObject({ code: 'MEMORY_EVENT_CAPACITY' })
      await expect(full).rejects.not.toThrow(/private|events\.json/)
    })
  })

  it('withholds a private lookup if the session moves to another scope while reading', async () => {
    await withHarness(async ({ call, deps, state }) => {
      await call(name, create)
      const ownerList = deps.events.list.bind(deps.events)
      vi.spyOn(deps.events, 'list').mockImplementationOnce(async scope => {
        const entries = await ownerList(scope)
        state.decision = { ...ownerDecision, scope: group, private: false }
        return entries
      })
      await expect(call(name, find)).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
      expect((await call<EventFindOutput>(name, find)).value.entries).toEqual([])
    })
  })

  it('keeps raw storage exceptions out of all three tool responses', async () => {
    await withHarness(async ({ call, deps }) => {
      const failure = new Error('EIO at /private/scopes/owner/events.json containing a private fact')
      vi.spyOn(deps.events, 'list').mockRejectedValue(failure)
      vi.spyOn(deps.events, 'save').mockRejectedValue(failure)
      vi.spyOn(deps.events, 'remove').mockRejectedValue(failure)
      for (const args of [find, create, { action: 'remove', subject, expectedRevision: 1 }]) {
        const response = call(name, args)
        await expect(response).rejects.toMatchObject({ code: 'MEMORY_EVENT_STORE_ERROR' })
        await expect(response).rejects.not.toThrow(/private|events\.json|EIO/)
      }
    })
  })
})

describe('context pressure', () => {
  it('follows the documented thresholds', () => {
    expect(recallPolicy(0.6, 1000)).toEqual({ kind: 'allow', pressure: 0.6, capTokens: 1000, allowRaw: true })
    expect(recallPolicy(0.61, 1000)).toMatchObject({ kind: 'allow', capTokens: 500, allowRaw: true })
    expect(recallPolicy(0.75, 1000)).toMatchObject({ allowRaw: true })
    expect(recallPolicy(0.76, 1000)).toMatchObject({ kind: 'allow', capTokens: 500, allowRaw: false })
    expect(recallPolicy(0.9, 1000)).toMatchObject({ kind: 'allow' })
    expect(recallPolicy(0.91, 1000)).toMatchObject({ kind: 'refuse' })
    expect(recallPolicy(Number.NaN, Number.NaN)).toEqual({ kind: 'allow', pressure: 0, capTokens: 8192, allowRaw: true })
  })

  it('halves caps above 60%, swaps raw for the summary above 75%, and refuses above 90%', async () => {
    await withHarness(async ({ call, state, store }) => {
      state.limit = 1000
      const full = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: LONG })
      expect(full.value.truncated).toBe(true)
      const fullTokens = estimator.estimate(full.value.text)
      expect(fullTokens).toBeLessThanOrEqual(1000)
      expect(fullTokens).toBeGreaterThan(600)

      state.pressure = 0.7
      const halved = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: LONG })
      expect(estimator.estimate(halved.value.text)).toBeLessThanOrEqual(500)
      expect(halved.value.text.length).toBeLessThan(full.value.text.length)

      state.pressure = 0.8
      const swapped = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: CAT, level: 'raw' })
      expect(swapped.value.level).toBe('summary')
      expect(swapped.value.notice).toContain('Raw text is unavailable at 80% context use')
      expect(swapped.value.offset).toBeUndefined()

      state.pressure = 0.95
      for (const [name, args] of [
        [MEMORY_TOOL_NAMES.search, { query: '猫粮' }],
        [MEMORY_TOOL_NAMES.read, { id: CAT }],
        [MEMORY_TOOL_NAMES.timeline, { id: CAT }],
      ] as const) {
        const failure = call(name, args)
        await expect(failure).rejects.toBeInstanceOf(HarnessError)
        await expect(failure).rejects.toMatchObject({ code: 'MEMORY_RECALL_PAUSED', message: expect.stringContaining('95% full') })
      }
      const pinned = await call<FlagOutput>(MEMORY_TOOL_NAMES.pin, { id: CAT })
      expect(pinned.value.pinned).toBe(true)
      expect(store.calls.updateEpisode.filter(call => call.patch.strength !== undefined)).toHaveLength(3)
    })
  })
})

describe('scope isolation', () => {
  it('keeps a group session inside its own scope', async () => {
    await withHarness(async ({ call, state, store }) => {
      state.decision = { scope: group, capture: true, private: false, reason: 'qq group' }
      const { value } = await call<SearchOutput>(MEMORY_TOOL_NAMES.search, { query: '猫粮' })
      expect(value.hits.map(hit => hit.id)).toEqual([GROUP_CAT])
      expect(value.total).toBe(1)
      for (const name of [MEMORY_TOOL_NAMES.read, MEMORY_TOOL_NAMES.timeline, MEMORY_TOOL_NAMES.pin, MEMORY_TOOL_NAMES.hide]) {
        await expect(call(name, { id: CAT })).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' })
      }
      expect(store.meta(owner, CAT)).toMatchObject({ pinned: false, hidden: false, strength: 1 })
      const own = await call<ReadOutput>(MEMORY_TOOL_NAMES.read, { id: GROUP_CAT })
      expect(own.value.text).toBe('群友拼单买猫粮。')
    })
  })

  it('refuses owner memory to non-private sessions and fails closed', async () => {
    await withHarness(async ({ call, state }) => {
      state.decision = { scope: owner, capture: false, private: false, reason: 'guest room' }
      await expect(call(MEMORY_TOOL_NAMES.search, { query: '猫粮' })).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
      await expect(call(MEMORY_TOOL_NAMES.unhide, { id: SECRET })).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
      state.decision = ownerDecision
      state.scopeError = new Error('resolver broke')
      await expect(call(MEMORY_TOOL_NAMES.read, { id: CAT })).rejects.toMatchObject({ code: 'MEMORY_SCOPE_UNAVAILABLE' })
      state.scopeError = undefined
      await expect(call(MEMORY_TOOL_NAMES.read, { id: CAT }, null)).rejects.toMatchObject({ code: 'MEMORY_NO_AGENT' })
      await expect(call(MEMORY_TOOL_NAMES.read, { id: '../qq-group-42/episodes/x' })).rejects.toMatchObject({ code: 'MEMORY_INVALID_ARGS' })
    })
  })
})

describe('pin, hide and timeline', () => {
  it('hides without deleting and unhides', async () => {
    await withHarness(async ({ call, store }) => {
      const hidden = await call<FlagOutput>(MEMORY_TOOL_NAMES.hide, { id: CAT })
      expect(hidden.value).toEqual({ id: CAT, pinned: false, hidden: true, changed: true })
      expect(hidden.text).toContain('nothing was deleted')
      const search = await call<SearchOutput>(MEMORY_TOOL_NAMES.search, { query: '猫粮品牌' })
      expect(search.value.hits.map(hit => hit.id)).toEqual([SHOPPING])
      await expect(call(MEMORY_TOOL_NAMES.read, { id: CAT })).rejects.toMatchObject({ code: 'MEMORY_HIDDEN' })
      await expect(readFile(join(store.root, 'scopes', owner, 'episodes', CAT, 'summary.md'), 'utf8')).resolves.toContain('皇家猫粮')

      const restored = await call<FlagOutput>(MEMORY_TOOL_NAMES.unhide, { id: CAT })
      expect(restored.value).toMatchObject({ hidden: false, changed: true })
      const again = await call<SearchOutput>(MEMORY_TOOL_NAMES.search, { query: '猫粮品牌' })
      expect(again.value.hits[0]?.id).toBe(CAT)
    })
  })

  it('pins idempotently', async () => {
    await withHarness(async ({ call, store }) => {
      expect((await call<FlagOutput>(MEMORY_TOOL_NAMES.pin, { id: TRIP })).value.changed).toBe(true)
      const repeat = await call<FlagOutput>(MEMORY_TOOL_NAMES.pin, { id: TRIP })
      expect(repeat.value).toEqual({ id: TRIP, pinned: true, hidden: false, changed: false })
      expect(repeat.text).toContain('(no change)')
      expect((await call<FlagOutput>(MEMORY_TOOL_NAMES.unpin, { id: TRIP })).value.pinned).toBe(false)
      expect(store.calls.updateEpisode).toHaveLength(2)
    })
  })

  it('shows neighbouring episodes in time order, skipping hidden ones', async () => {
    await withHarness(async ({ call }) => {
      const { value, text } = await call<TimelineOutput>(MEMORY_TOOL_NAMES.timeline, { id: TS, before: 1, after: 1 })
      expect(value.entries.map(entry => entry.id)).toEqual([TRIP, TS, LONG])
      expect(value.entries.map(entry => entry.current)).toEqual([false, true, false])
      expect(value.entries[0]).toMatchObject({ sameSession: false, gist: '计划周末去杭州。', date: '2026-11-05 21:00' })
      expect(text).toContain(`→ #${TS} 2026-11-10 09:00 Helped with TypeScript generics.`)
      const hashed = await call<TimelineOutput>(MEMORY_TOOL_NAMES.timeline, { id: `#${TS}`, before: 1, after: 1 })
      expect(hashed.value).toEqual(value)
      const edge = await call<TimelineOutput>(MEMORY_TOOL_NAMES.timeline, { id: RAW })
      expect(edge.value.entries.map(entry => entry.id)).toEqual([TRIP, TS, LONG, RAW])
      expect(edge.value.entries.at(-1)?.gist).toBe('(sealed; not summarized yet)')
    })
  })

  it('leaves empty episodes out of the timeline unless asked about one', async () => {
    await withHarness(async ({ call, store }) => {
      const empty = '20261112-1000_eeee5555_1'
      await store.seed(owner, [{ id: empty, sessionId: 's-b', startedAt: at(2026, 11, 12, 10), status: 'failed', raw: [stepRecord(at(2026, 11, 12, 10), 1)] }])
      await store.updateEpisode(owner, empty as never, { lastError: `${EMPTY_EPISODE_ERROR}: no conversation content` })
      const { value } = await call<TimelineOutput>(MEMORY_TOOL_NAMES.timeline, { id: TS, before: 1, after: 1 })
      expect(value.entries.map(entry => entry.id)).toEqual([TRIP, TS, LONG])
      const own = await call<TimelineOutput>(MEMORY_TOOL_NAMES.timeline, { id: empty, before: 1, after: 1 })
      expect(own.value.entries.map(entry => [entry.id, entry.current])).toEqual([[TS, false], [empty, true], [LONG, false]])
    })
  })

  it('trims the timeline to the recall cap around the current episode', async () => {
    await withHarness(async ({ call, state }) => {
      state.limit = 70
      const { value } = await call<TimelineOutput>(MEMORY_TOOL_NAMES.timeline, { id: TRIP, before: 5, after: 5 })
      expect(value.entries.some(entry => entry.current)).toBe(true)
      expect(value.entries.length).toBeLessThan(6)
      expect(value.notice).toMatch(/left out to save context/)
    })
  })
})
