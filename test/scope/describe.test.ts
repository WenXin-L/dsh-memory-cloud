import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { OWNER_SCOPE } from '../../src/contracts.ts'
import {
  createScopeResolver,
  createSessionTagRegistry,
  describeSession,
  inheritParentTags,
  MAX_SESSION_TAGS,
  type SessionLike,
  type SessionTagProvider,
} from '../../src/scope/index.ts'

const header = (patch: Record<string, unknown> = {}) => ({ version: 4, id: 'sess-1', createdAt: 1, isSeeded: false, ...patch })

describe('describeSession', () => {
  it('accepts a real DSH Session type', () => {
    expectTypeOf<Session>().toExtend<SessionLike>()
  })

  it('copies the scoping fields of a top-level session header', () => {
    expect(describeSession({ id: 'sess-1', header: header({ cwd: '/w', agentPreset: 'standard' }) })).toEqual({
      sessionId: 'sess-1',
      agentPreset: 'standard',
      cwd: '/w',
    })
  })

  it('marks subagents and keeps their lineage', () => {
    const descriptor = describeSession({ header: header({ origin: 'subagent', parentSession: 'parent-1', delegationDepth: 2 }) })
    expect(descriptor).toEqual({ sessionId: 'sess-1', origin: 'subagent', parentSession: 'parent-1', delegationDepth: 2 })
  })

  it('omits unknown or malformed header values instead of setting undefined', () => {
    const descriptor = describeSession({ id: 'fallback', header: { origin: 'fork', delegationDepth: Number.NaN, cwd: '', agentPreset: '' } })
    expect(descriptor).toEqual({ sessionId: 'fallback' })
    expect(Object.keys(descriptor)).toEqual(['sessionId'])
    expect(describeSession({})).toEqual({ sessionId: '' })
  })

  it('merges, trims and deduplicates provider tags in provider order', () => {
    const providers: SessionTagProvider[] = [
      () => ['qqbot:fish:group:1', '  qqbot:fish:group:1  ', ''],
      () => new Set(['room:lobby']),
      () => undefined,
      () => 'not-an-iterable-of-tags' as unknown as string[],
      () => [42 as unknown as string, 'x'.repeat(5000), 'ok'],
    ]
    expect(describeSession({ header: header() }, { tagProviders: providers }).tags).toEqual(['qqbot:fish:group:1', 'room:lobby', 'ok'])
  })

  it('caps the number of tags', () => {
    const many = Array.from({ length: 200 }, (_, index) => `t${index}`)
    expect(describeSession({ header: header() }, { tagProviders: [() => many] }).tags).toHaveLength(MAX_SESSION_TAGS)
  })

  it('passes the header-derived descriptor to providers', () => {
    const seen: unknown[] = []
    describeSession({ header: header({ agentPreset: 'p' }) }, { tagProviders: [(_session, base) => { seen.push(base) }] })
    expect(seen).toEqual([{ sessionId: 'sess-1', agentPreset: 'p' }])
  })

  it('skips throwing providers and reports their errors', () => {
    const errors: unknown[] = []
    const descriptor = describeSession({ header: header() }, {
      tagProviders: [() => { throw new Error('bridge down') }, () => ['ok']],
      onProviderError: (error) => { errors.push(error); throw new Error('reporter also broken') },
    })
    expect(descriptor.tags).toEqual(['ok'])
    expect(errors).toHaveLength(1)
  })
})

describe('inheritParentTags', () => {
  it('lets a subagent of a group session resolve to the group scope', () => {
    const cache = new Map<string, readonly string[]>([['parent-1', ['qqbot:fish:group:9']]])
    const providers = [inheritParentTags(id => cache.get(id))]
    const resolver = createScopeResolver({ rules: () => [{ match: 'qqbot:*:group:*', scope: 'qq-group-$2' }] })
    const child = describeSession({ header: header({ id: 'child', origin: 'subagent', parentSession: 'parent-1', delegationDepth: 1 }) }, { tagProviders: providers })
    expect(child.tags).toEqual(['qqbot:fish:group:9'])
    expect(resolver.resolve(child)).toMatchObject({ scope: 'qq-group-9', capture: false, private: false })
    const orphan = describeSession({ header: header({ id: 'top' }) }, { tagProviders: providers })
    expect(orphan.tags).toBeUndefined()
    expect(resolver.resolve(orphan)).toMatchObject({ scope: OWNER_SCOPE, private: true })
  })
})

describe('createSessionTagRegistry', () => {
  it('serves explicitly set tags through its provider', () => {
    const registry = createSessionTagRegistry()
    registry.set('sess-1', ['wechat:group:a', 'wechat:group:a', ' '])
    expect(registry.get('sess-1')).toEqual(['wechat:group:a'])
    expect(describeSession({ header: header() }, { tagProviders: [registry.provider] }).tags).toEqual(['wechat:group:a'])
    expect(describeSession({ header: header({ id: 'other' }) }, { tagProviders: [registry.provider] }).tags).toBeUndefined()
    registry.delete('sess-1')
    expect(registry.get('sess-1')).toEqual([])
    registry.set('sess-2', ['a'])
    registry.set('sess-2', [])
    expect(registry.get('sess-2')).toEqual([])
  })
})
