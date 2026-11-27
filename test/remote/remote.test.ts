import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  memoryCloudContribution,
  PACKAGE_NAME,
  parseConfigPatch,
  parseLevel,
  parseMode,
  parseOptionalId,
  REMOTE_METHODS,
  REMOTE_NAMESPACE,
  REMOTE_SERVICE,
} from '../../src/client/contract.ts'
import type { RemoteMethod } from '../../src/client/contract.ts'
import type { MemoryCloudApi, MemoryCloudStatus } from '../../src/runtime/status.ts'
import { createRecentSessions, MemoryCloudRemote, toWire } from '../../src/runtime/remote.ts'
import type { ConfigAccess } from '../../src/runtime/settings.ts'
import { configView, wireStatus } from '../client/fixtures.ts'
import { createHarness, userMessage } from '../integration/harness.ts'
import type { Harness } from '../integration/harness.ts'

/** DSH lookup providers' SRC parameter names (`dsh-session`, `dsh-agent`, `dsh-api-workspace-files`). */
const LOOKUP_PARAMETERS = ['session', 'agent', 'workspaceFileScope']

/** The Typert Gateway's SRC signature parser (`dsh-api-gateway` `methodParameterNames`). */
function srcParameters(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const body = source.slice(source.indexOf('(') + 1, source.indexOf(')')).trim()
  return body.length === 0 ? [] : body.split(',').map(part => part.trim())
}

function fakeApi(): MemoryCloudApi & { readonly [K in keyof MemoryCloudApi]: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn(async () => wireStatus()),
    setLevel: vi.fn(async () => ({ ok: true, via: 'settings' }) as const),
    setMode: vi.fn(async () => ({ ok: true, via: 'settings' }) as const),
    takeover: vi.fn(async () => ({ kind: 'preset', ok: true, action: 'applied' }) as const),
    restore: vi.fn(async () => ({ kind: 'preset', ok: true, action: 'restored' }) as const),
  }
}

function fakeConfig(): ConfigAccess & { readonly [K in keyof ConfigAccess]: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(() => configView()),
    set: vi.fn(async () => ({ ok: true, via: 'settings' }) as const),
  }
}

describe('wire contract', () => {
  it('parses arguments the same way on both halves', () => {
    expect(parseLevel(5)).toBe(5)
    expect(() => parseLevel('5')).toThrow('请选择一个有效的压缩档位。 / level must be one of 1, 2, 3, 4, 5')
    expect(() => parseLevel(6)).toThrow()
    expect(parseMode('assist')).toBe('assist')
    expect(() => parseMode('turbo')).toThrow('请选择一个有效的压缩模式。 / mode must be one of auto, engine, assist, off')
    expect(parseOptionalId(undefined)).toBeUndefined()
    expect(parseOptionalId('ptc')).toBe('ptc')
    expect(() => parseOptionalId('  ')).toThrow()
    expect(() => parseOptionalId(3)).toThrow()
  })

  it('accepts known live fields with JSON types in a settings patch', () => {
    const patch = {
      level: 2,
      idleMinutes: 5,
      captureReasoning: false,
      summarizer: { model: 'deepseek-chat' },
      overrides: { gistTokens: 40 },
      scopeRules: [{ match: 'qqbot:*:group:*', scope: 'qq-group-$2' }],
      unmatchedSessions: 'isolated',
    }
    expect(parseConfigPatch(patch)).toBe(patch)
    expect(parseConfigPatch({ overrides: {}, scopeRules: [] })).toEqual({ overrides: {}, scopeRules: [] })
    const rejected: [unknown, string][] = [
      [null, '要保存设置，请传入一个对象。 / settings patch must be an object'],
      [[], '要保存设置，请传入一个对象。 / settings patch must be an object'],
      [{}, '请至少填写一项要保存的设置。 / settings patch changes nothing'],
      [{ storageRoot: '/tmp/x' }, '未识别此设置项，请核对字段名。 / unknown setting "storageRoot"'],
      [JSON.parse('{"__proto__": {"level": 1}}'), '未识别此设置项，请核对字段名。 / unknown setting "__proto__"'],
      [{ level: 7 }, '请选择一个有效的压缩档位。 / level must be one of 1, 2, 3, 4, 5'],
      [{ compactionMode: 'turbo' }, '请选择一个有效的压缩模式。 / mode must be one of auto, engine, assist, off'],
      [{ idleMinutes: '5' }, '此字段需要填写有限数值。 / idleMinutes must be a finite number'],
      [{ captureReasoning: 1 }, '是否记录推理内容需要填写 true 或 false。 / captureReasoning must be a boolean'],
      [{ summarizer: { temperature: 'x' } }, '未识别此设置项，请核对字段名。 / unknown setting "summarizer.temperature"'],
      [{ summarizer: { model: 3 } }, '此字段需要填写字符串。 / summarizer.model must be a string'],
      [{ overrides: { gistTokens: null } }, '此字段需要填写有限数值。 / overrides.gistTokens must be a finite number'],
      [{ overrides: { thresholdRatio: 1 } }, '未识别此设置项，请核对字段名。 / unknown setting "overrides.thresholdRatio"'],
      [{ scopeRules: {} }, '作用域规则需要按顺序放在一个数组里。 / scopeRules must be an array'],
      [{ scopeRules: [{ match: 'a' }] }, '请补全这条作用域规则的必填字段。 / scopeRules[0].scope is required'],
      [{ scopeRules: [{ match: 'a', scope: 'b', private: true }] }, '未识别此设置项，请核对字段名。 / unknown setting "scopeRules[0].private"'],
      [{ unmatchedSessions: 'public' }, '请选择未匹配会话的处理方式。 / unmatchedSessions must be one of auto, owner, isolated'],
      [{ unmatchedSessions: true }, '请选择未匹配会话的处理方式。 / unmatchedSessions must be one of auto, owner, isolated'],
    ]
    for (const [value, message] of rejected) expect(() => parseConfigPatch(value), message).toThrow(message)
  })

  it('describes every endpoint for the Client Gateway with strict input codecs', () => {
    const contribution = memoryCloudContribution()
    expect(contribution.package).toBe(PACKAGE_NAME)
    expect(contribution.descriptors.map(descriptor => descriptor.method)).toEqual(Object.keys(REMOTE_METHODS))
    expect(new Set(contribution.descriptors.map(descriptor => descriptor.id)).size).toBe(contribution.descriptors.length)
    for (const descriptor of contribution.descriptors) {
      expect(descriptor).toMatchObject({
        id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${descriptor.method}`,
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        invocation: { kind: 'direct' },
        cancellation: { parameter: 'signal' },
        result: { mode: 'src-json' },
      })
      expect(descriptor.parameters.map(parameter => parameter.wire)).toEqual(REMOTE_METHODS[descriptor.method as RemoteMethod])
      for (const parameter of descriptor.parameters) {
        expect(parameter.codec.mode).toBe('strict')
        expect(parameter.codec.typeSymbol.startsWith(`${PACKAGE_NAME}#`)).toBe(true)
        expect(typeof parameter.codec.create().parse).toBe('function')
      }
    }
    const [setLevel] = contribution.descriptors.filter(descriptor => descriptor.method === 'setLevel')
    expect(setLevel?.parameters[0]?.acceptsUndefined).toBeUndefined()
    expect(setLevel?.parameters[0]?.codec.jsonSchema).toEqual({ type: 'integer', enum: [1, 2, 3, 4, 5] })
    expect(() => setLevel?.parameters[0]?.codec.create().parse(9)).toThrow()
    const [takeover] = contribution.descriptors.filter(descriptor => descriptor.method === 'takeover')
    expect(takeover?.parameters[0]?.acceptsUndefined).toBe(true)
    const [getConfig] = contribution.descriptors.filter(descriptor => descriptor.method === 'getConfig')
    expect(getConfig?.parameters).toEqual([])
    const [setConfig] = contribution.descriptors.filter(descriptor => descriptor.method === 'setConfig')
    expect(setConfig?.parameters[0]?.acceptsUndefined).toBeUndefined()
    expect(setConfig?.parameters[0]?.codec.jsonSchema).toMatchObject({ type: 'object', minProperties: 1, additionalProperties: false })
    expect(() => setConfig?.parameters[0]?.codec.create().parse({ storageRoot: '/x' })).toThrow('未识别此设置项，请核对字段名。 / unknown setting "storageRoot"')
  })
})

describe('host binding', () => {
  it('exposes each api method as a direct Remote method with matching SRC parameters', () => {
    const remote = new MemoryCloudRemote(fakeApi(), fakeConfig(), () => undefined)
    expect(remote.typertRemote).toEqual({ service: remote, serviceKey: REMOTE_SERVICE, namespace: REMOTE_NAMESPACE })
    expect(remoteMethods(remote).map(marker => [marker.method, marker.invocation.kind])).toEqual(Object.keys(REMOTE_METHODS).map(name => [name, 'direct']))
    for (const [method, parameters] of Object.entries(REMOTE_METHODS)) {
      const implementation = Reflect.get(MemoryCloudRemote.prototype, method) as (...args: never[]) => unknown
      expect(srcParameters(implementation), method).toEqual(parameters)
      for (const parameter of parameters) expect([...LOOKUP_PARAMETERS, 'signal']).not.toContain(parameter)
    }
  })

  it('normalizes results to the JSON the browser receives', () => {
    expect(toWire({ kept: 1, dropped: undefined, limit: Number.POSITIVE_INFINITY, list: [undefined, 2] })).toEqual({ kept: 1, limit: null, list: [null, 2] })
  })

  it('describes the requested session, else the most recently active one', async () => {
    const api = fakeApi()
    let latest: string | undefined = 'recent-session'
    const remote = new MemoryCloudRemote(api, fakeConfig(), () => latest)
    await remote.status(undefined)
    await remote.status('')
    await remote.status('explicit')
    latest = undefined
    await remote.status(42)
    expect(api.status.mock.calls).toEqual([['recent-session'], ['recent-session'], ['explicit'], [undefined]])
    api.status.mockResolvedValueOnce({ ...wireStatus(), jobs: { ...wireStatus().jobs, quota: { day: 'd', used: 1, limit: Number.POSITIVE_INFINITY } } })
    const status = await remote.status(undefined) as MemoryCloudStatus
    expect(status.jobs.quota.limit).toBeNull()
  })

  it('validates arguments before calling the api and never throws', async () => {
    const api = fakeApi()
    const remote = new MemoryCloudRemote(api, fakeConfig(), () => undefined)
    await expect(remote.setLevel(2)).resolves.toEqual({ ok: true, via: 'settings' })
    await expect(remote.setLevel('2')).resolves.toEqual({ ok: false, message: '请选择一个有效的压缩档位。 / level must be one of 1, 2, 3, 4, 5' })
    await expect(remote.setMode('engine')).resolves.toEqual({ ok: true, via: 'settings' })
    await expect(remote.setMode(null)).resolves.toEqual({ ok: false, message: '请选择一个有效的压缩模式。 / mode must be one of auto, engine, assist, off' })
    await expect(remote.takeover(undefined)).resolves.toEqual({ kind: 'preset', ok: true, action: 'applied' })
    await expect(remote.restore('ptc')).resolves.toEqual({ kind: 'preset', ok: true, action: 'restored' })
    await expect(remote.restore(7)).resolves.toEqual({ kind: 'preset', ok: false, code: 'preset-not-found', message: '会话或预设 ID 需要填写非空字符串。 / identifier must be a non-empty string' })
    expect(api.setLevel.mock.calls).toEqual([[2]])
    expect(api.setMode.mock.calls).toEqual([['engine']])
    expect(api.takeover.mock.calls).toEqual([[undefined]])
    expect(api.restore.mock.calls).toEqual([['ptc']])
  })

  it('serves the live settings and validates settings patches before writing', async () => {
    const config = fakeConfig()
    config.get.mockReturnValueOnce({ ...configView(), config: { ...configView().config, halfLifeDays: Number.NaN } })
    const remote = new MemoryCloudRemote(fakeApi(), config, () => undefined)
    expect((await remote.getConfig()).config.halfLifeDays).toBeNull()
    await expect(remote.getConfig()).resolves.toEqual(configView())
    await expect(remote.setConfig({ idleMinutes: 5 })).resolves.toEqual({ ok: true, via: 'settings' })
    await expect(remote.setConfig({ storageRoot: '/tmp' })).resolves.toEqual({ ok: false, message: '未识别此设置项，请核对字段名。 / unknown setting "storageRoot"' })
    await expect(remote.setConfig(undefined)).resolves.toEqual({ ok: false, message: '要保存设置，请传入一个对象。 / settings patch must be an object' })
    expect(config.set.mock.calls).toEqual([[{ idleMinutes: 5 }]])
  })

  it('orders live sessions by activity and skips subagents', () => {
    const recent = createRecentSessions()
    const agent = (id: string, origin?: string) => ({ session: { id, header: origin === undefined ? {} : { origin } } })
    const first = agent('first')
    const second = agent('second')
    expect(recent.latest()).toBeUndefined()
    recent.touch(first)
    recent.touch(second)
    recent.touch(agent('child', 'subagent'))
    expect(recent.latest()).toBe('second')
    recent.touch(first)
    expect(recent.latest()).toBe('first')
    recent.forget(agent('first'))
    expect(recent.latest()).toBe('first')
    recent.forget(first)
    expect(recent.latest()).toBe('second')
  })
})

describe('registered with the runtime', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('serves status for the latest live session and writes settings', async () => {
    const h = harness = await createHarness({ engine: 'none', level: 3 })
    expect(h.ctx.reflect.props[REMOTE_SERVICE]?.type).toBe('service')
    const remote = h.ctx.get(REMOTE_SERVICE) as MemoryCloudRemote
    expect(remote).toBeInstanceOf(MemoryCloudRemote)

    const idle = await remote.status(undefined)
    expect(idle.agent).toBeUndefined()

    const conversation = await h.conversation('remote-session')
    await h.preStep(conversation.agent, [userMessage('你好')])
    const live = await remote.status(undefined)
    expect(live.agent?.sessionId).toBe('remote-session')
    expect(live.agent?.budget.level).toBe(3)
    expect(JSON.parse(JSON.stringify(live))).toEqual(live)

    await expect(remote.setLevel(5)).resolves.toEqual({ ok: true, via: 'settings' })
    expect((await remote.status('remote-session')).configured.level).toBe(5)
    await expect(remote.setMode('turbo')).resolves.toMatchObject({ ok: false })
  })

  it('reads and writes the live settings, applying them to running sessions', async () => {
    const h = harness = await createHarness({ engine: 'none', level: 3 })
    const remote = h.ctx.get(REMOTE_SERVICE) as MemoryCloudRemote
    const view = await remote.getConfig()
    expect(view.config).toMatchObject({ level: 3, idleMinutes: 30, overrides: {}, scopeRules: [], summarizer: { model: 'deepseek-flash' } })
    expect(view.defaults).toEqual({ ...view.config, level: 3, compactionMode: 'auto' })

    const conversation = await h.conversation('remote-session')
    const before = await remote.status('remote-session')
    expect(before.agent?.scope.scope).toBe('owner')

    await expect(remote.setConfig({
      idleMinutes: 5,
      overrides: { memoryBudgetTokens: 2048 },
      scopeRules: [{ match: 'session:remote-*', scope: 'remote-$1' }],
    })).resolves.toEqual({ ok: true, via: 'settings' })
    expect(h.config.idleMinutes.get()).toBe(5)
    const after = await remote.status('remote-session')
    expect(after.agent?.budget.memoryBudgetTokens).toBe(2048)
    expect(after.agent?.scope).toMatchObject({ scope: 'remote-session', private: false })
    expect((await remote.getConfig()).config).toMatchObject({ idleMinutes: 5, overrides: { memoryBudgetTokens: 2048 }, scopeRules: [{ match: 'session:remote-*', scope: 'remote-$1' }] })

    await expect(remote.setConfig({ idleMinutes: 0 })).resolves.toEqual({ ok: false, message: '$.idleMinutes expected number >= 1 but got 0' })
    await expect(remote.setConfig({ scopeRules: [{ match: ' ', scope: 'x' }] })).resolves.toEqual({ ok: false, message: '请填写作用域规则的匹配式。 / scopeRules[0].match must not be empty' })
    expect(h.config.idleMinutes.get()).toBe(5)
    expect(conversation.agent.session.id).toBe('remote-session')
  })
})
