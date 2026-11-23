import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OWNER_SCOPE, type ScopeDecision, type ScopeId, type ScopeRule, type SessionDescriptor } from '../../src/contracts.ts'
import {
  canReadScope,
  compileGlob,
  createScopeResolver,
  decideUnmatched,
  descriptorTags,
  expandScopeTemplate,
  isolatedScopeId,
  MAX_SCOPE_ID_LENGTH,
  mayUseOwnerMemory,
  sanitizeScopeId,
  templateCaptures,
  type UnmatchedDecision,
} from '../../src/scope/index.ts'
import { isValidScopeId } from '../../src/store/index.ts'

const session = (patch: Partial<SessionDescriptor> = {}): SessionDescriptor => ({ sessionId: 's-1', ...patch })

describe('compileGlob', () => {
  it('anchors, treats * as any run and ? as one character, and returns captures', () => {
    const glob = compileGlob('qqbot:*:group:*')
    expect(glob.match('qqbot:bot1:group:123')).toEqual(['bot1', '123'])
    expect(glob.match('qqbot::group:')).toEqual(['', ''])
    expect(glob.match('xqqbot:bot1:group:123')).toBeUndefined()
    expect(glob.match('qqbot:bot1:private:123')).toBeUndefined()
    expect(compileGlob('room-??').match('room-42')).toEqual(['4', '2'])
    expect(compileGlob('room-??').match('room-4')).toBeUndefined()
    expect(compileGlob('cwd:/home/*').match('cwd:/home/a/b/c')).toEqual(['a/b/c'])
  })

  it('treats regexp metacharacters and escaped wildcards literally', () => {
    expect(compileGlob('a.b(c)[d]+$^|{e}').match('a.b(c)[d]+$^|{e}')).toEqual([])
    expect(compileGlob('a.b').match('axb')).toBeUndefined()
    expect(compileGlob('lit\\*').match('lit*')).toEqual([])
    expect(compileGlob('lit\\*').match('litx')).toBeUndefined()
    expect(compileGlob('a-b-*').match('a-b-c')).toEqual(['c'])
  })

  it('counts its wildcards', () => {
    expect(compileGlob('qqbot:*:group:*').wildcards).toBe(2)
    expect(compileGlob('room-??').wildcards).toBe(2)
    expect(compileGlob('lit\\*').wildcards).toBe(0)
    expect(compileGlob('plain').wildcards).toBe(0)
  })

  it('is case-sensitive unless asked otherwise', () => {
    expect(compileGlob('Preset:*').match('preset:x')).toBeUndefined()
    expect(compileGlob('Preset:*', { caseInsensitive: true }).match('preset:x')).toEqual(['x'])
  })
})

describe('sanitizeScopeId', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('keeps ids that are already safe', () => {
    expect(sanitizeScopeId('owner')).toBe(OWNER_SCOPE)
    expect(sanitizeScopeId('qq-group-123_a')).toBe('qq-group-123_a')
    expect(sanitizeScopeId('a--b')).toBe('a--b')
    expect(sanitizeScopeId('x'.repeat(MAX_SCOPE_ID_LENGTH))).toBe('x'.repeat(MAX_SCOPE_ID_LENGTH))
  })

  it('rewrites unsafe ids and appends a hash of the original', () => {
    const upper = sanitizeScopeId('QQ Group/123')
    expect(upper).toMatch(/^qq-group-123-[0-9a-f]{8}$/)
    expect(sanitizeScopeId('QQ Group/123')).toBe(upper)
    expect(sanitizeScopeId('Owner')).toMatch(/^owner-[0-9a-f]{8}$/)
    expect(sanitizeScopeId('Owner')).not.toBe(OWNER_SCOPE)
    expect(sanitizeScopeId('../../etc')).toMatch(/^etc-[0-9a-f]{8}$/)
    expect(sanitizeScopeId('-lead')).toMatch(/^lead-[0-9a-f]{8}$/)
    expect(sanitizeScopeId('')).toMatch(/^scope-[0-9a-f]{8}$/)
    expect(sanitizeScopeId('家人群')).toMatch(/^scope-[0-9a-f]{8}$/)
    expect(sanitizeScopeId('con')).toMatch(/^con-[0-9a-f]{8}$/)
    expect(sanitizeScopeId('lpt1')).toMatch(/^lpt1-[0-9a-f]{8}$/)
  })

  it('uses a pinned hash so existing scope directories keep their names', () => {
    expect(sanitizeScopeId('Owner')).toBe('owner-9b22be74')
    expect(sanitizeScopeId('QQ Group/123')).toBe('qq-group-123-17879c07')
    expect(sanitizeScopeId('家人群')).toBe('scope-d769bd7b')
    expect(sanitizeScopeId('')).toBe('scope-811c9dc5')
  })

  it('caps the length at 64 and stays distinct for distinct inputs', () => {
    const long = sanitizeScopeId('y'.repeat(200))
    expect(long.length).toBeLessThanOrEqual(MAX_SCOPE_ID_LENGTH)
    expect(long).toMatch(/^y+-[0-9a-f]{8}$/)
    expect(sanitizeScopeId('y'.repeat(201))).not.toBe(long)
    expect(sanitizeScopeId('A')).not.toBe(sanitizeScopeId('a'))
    expect(sanitizeScopeId('a b')).not.toBe(sanitizeScopeId('a/b'))
  })

  it('is a fixed point', () => {
    for (const raw of ['owner', 'QQ Group/123', '', 'y'.repeat(200), '家人群', 'con', '--x--']) {
      const once = sanitizeScopeId(raw)
      expect(sanitizeScopeId(once)).toBe(once)
      expect(once).toMatch(/^[a-z0-9_-]{1,64}$/)
    }
  })

  it('always produces ids the store accepts, including the first character', () => {
    const tricky = ['-', '--', '-x', '_', '_x', '.', '..', '.hidden', 'x.', ' x', '\tx', '-'.repeat(70), `-${'z'.repeat(70)}`, '_'.repeat(70), '家', 'a:b', 'qqbot:1:group:2', '$1', 'CON', 'x'.repeat(65)]
    let seed = 7
    const random = (): string => {
      let text = ''
      const length = seed % 90
      for (let index = 0; index < length; index++) {
        seed = (seed * 1103515245 + 12345) % 2147483648
        text += String.fromCharCode(32 + (seed % 95))
      }
      seed = (seed * 1103515245 + 12345) % 2147483648
      return text
    }
    for (const raw of [...tricky, ...Array.from({ length: 500 }, random)]) {
      const id = sanitizeScopeId(raw)
      expect(isValidScopeId(id), `${JSON.stringify(raw)} -> ${id}`).toBe(true)
      expect(id).not.toMatch(/^[-.]/)
    }
  })

  it('produces distinct, creatable directory names on the real filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcb-scope-'))
    dirs.push(root)
    const inputs = ['owner', 'Owner', 'OWNER', 'qq group 1', 'qq/group/1', 'qq-group-1', '..', '.', 'con', 'NUL', '家人群', '家人群2', 'a'.repeat(300)]
    const ids = inputs.map(sanitizeScopeId)
    expect(new Set(ids).size).toBe(inputs.length)
    for (const id of ids) await mkdir(join(root, id))
    expect((await readdir(root)).length).toBe(inputs.length)
  })
})

describe('expandScopeTemplate', () => {
  it('substitutes captures, the whole tag and literal dollars', () => {
    expect(expandScopeTemplate('qq-group-$2', ['bot', '123'], 'qqbot:bot:group:123')).toBe('qq-group-123')
    expect(expandScopeTemplate('$1-$2', ['a', 'b'], 't')).toBe('a-b')
    expect(expandScopeTemplate('t-$&', [], 'tag')).toBe('t-tag')
    expect(expandScopeTemplate('t-$0', [], 'tag')).toBe('t-tag')
    expect(expandScopeTemplate('cost-$$', [], 'tag')).toBe('cost-$')
  })

  it('replaces a missing or empty capture with a hash of the whole tag', () => {
    const a = expandScopeTemplate('qq-group-$2', ['bot', ''], 'qqbot:bot:group:')
    const b = expandScopeTemplate('qq-group-$2', ['other', ''], 'qqbot:other:group:')
    expect(a).toMatch(/^qq-group-[0-9a-f]{8}$/)
    expect(b).toMatch(/^qq-group-[0-9a-f]{8}$/)
    expect(a).not.toBe(b)
    expect(expandScopeTemplate('g-$3', ['a'], 'tag')).toMatch(/^g-[0-9a-f]{8}$/)
  })
})

describe('templateCaptures', () => {
  it('reports the highest numbered capture only', () => {
    expect(templateCaptures('qq-group-$2')).toBe(2)
    expect(templateCaptures('$1-$3-$2')).toBe(3)
    expect(templateCaptures('t-$&-$0-$$')).toBe(0)
    expect(templateCaptures('owner')).toBe(0)
  })
})

describe('descriptorTags', () => {
  it('lists bridge tags first, then synthetic preset/cwd/session tags', () => {
    expect(descriptorTags(session({ tags: ['qqbot:b:group:1', 'qqbot:b:group:1'], agentPreset: 'standard', cwd: '/w' }))).toEqual([
      'qqbot:b:group:1',
      'preset:standard',
      'cwd:/w',
      'session:s-1',
    ])
    expect(descriptorTags({ sessionId: '' })).toEqual([])
  })
})

describe('createScopeResolver', () => {
  const resolverFor = (rules: ScopeRule[], unmatched?: UnmatchedDecision) =>
    createScopeResolver({ rules: () => rules, ...unmatched === undefined ? {} : { unmatched: () => unmatched } })

  it('puts unmatched sessions in the private owner scope', () => {
    const decision = resolverFor([{ match: 'qqbot:*', scope: 'qq' }]).resolve(session())
    expect(decision).toMatchObject({ scope: OWNER_SCOPE, capture: true, private: true })
    expect(decision.reason).toContain('no scope rule matched')
  })

  it('isolates unmatched sessions per session when asked, without owner memory', () => {
    const resolver = resolverFor([{ match: 'cwd:/Users/me/*', scope: 'owner' }], decideUnmatched('isolated'))
    const a = resolver.resolve(session({ sessionId: 'qq-a' }))
    const b = resolver.resolve(session({ sessionId: 'qq-b' }))
    expect(a).toMatchObject({ scope: isolatedScopeId({ sessionId: 'qq-a' }), capture: true, private: false })
    expect(a.scope).toMatch(/^session-[0-9a-f]{8}$/)
    expect(b.scope).not.toBe(a.scope)
    expect(a.reason).toContain('unmatchedSessions=isolated')
    expect(canReadScope(a)).toBe(true)
    expect(mayUseOwnerMemory(a)).toBe(false)
    expect(canReadScope(a, OWNER_SCOPE)).toBe(false)
    const own = resolver.resolve(session({ cwd: '/Users/me/project' }))
    expect(own).toMatchObject({ scope: OWNER_SCOPE, private: true })
    expect(mayUseOwnerMemory(own)).toBe(true)
  })

  it('isolates a subagent with its parent session', () => {
    const resolver = resolverFor([], decideUnmatched('isolated'))
    const child = resolver.resolve(session({ sessionId: 'child', origin: 'subagent', parentSession: 'qq-a', delegationDepth: 1 }))
    expect(child).toMatchObject({ scope: resolver.resolve(session({ sessionId: 'qq-a' })).scope, capture: false, private: false })
  })

  it('auto isolates unmatched sessions only while a chat bridge is loaded', () => {
    let bridges: string[] = []
    const resolver = createScopeResolver({ rules: () => [], unmatched: () => decideUnmatched('auto', bridges) })
    const alone = resolver.resolve(session())
    expect(alone).toMatchObject({ scope: OWNER_SCOPE, private: true })
    expect(alone.reason).toContain('no chat bridge loaded')
    bridges = ['dsh-qqbot']
    const bridged = resolver.resolve(session())
    expect(bridged).toMatchObject({ private: false })
    expect(bridged.scope).toMatch(/^session-/)
    expect(bridged.reason).toContain('dsh-qqbot')
    expect(resolverFor([], decideUnmatched('owner')).resolve(session())).toMatchObject({ scope: OWNER_SCOPE, private: true })
  })

  it('fails closed when the unmatched policy cannot be decided', () => {
    const throwing = createScopeResolver({ rules: () => [], unmatched: () => { throw new Error('rows unavailable') } })
    const decision = throwing.resolve(session())
    expect(decision.scope).toMatch(/^session-/)
    expect(decision.private).toBe(false)
    expect(decision.reason).toContain('rows unavailable')
    expect(decideUnmatched('bogus').mode).toBe('isolated')
  })

  it('skips and reports a rule whose template uses more captures than the glob has, once', () => {
    const warnings: string[] = []
    const resolver = createScopeResolver({
      rules: () => [{ match: 'qqbot:*:group', scope: 'qq-group-$2' }, { match: 'qqbot:*', scope: 'qq-$1' }],
      onWarning: message => warnings.push(message),
    })
    expect(resolver.resolve(session({ tags: ['qqbot:a:group'] })).scope).toMatch(/^qq-a-group-[0-9a-f]{8}$/)
    expect(resolver.resolve(session({ tags: ['qqbot:b:group'] })).reason).toContain('scope rule 2')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('$2')
    expect(warnings[0]).toContain('1 wildcard')
  })

  it('never makes a session private when a capture expands to owner', () => {
    const resolver = resolverFor([{ match: 'qqbot:*:private:*', scope: '$2' }])
    const guest = resolver.resolve(session({ tags: ['qqbot:fish:private:owner'] }))
    expect(guest.private).toBe(false)
    expect(guest.scope).not.toBe(OWNER_SCOPE)
    expect(guest.scope).toMatch(/^owner-[0-9a-f]{8}$/)
    expect(mayUseOwnerMemory(guest)).toBe(false)
    const whole = resolverFor([{ match: 'owner', scope: '$&' }]).resolve(session({ tags: ['owner'] }))
    expect(whole.private).toBe(false)
    expect(whole.scope).not.toBe(OWNER_SCOPE)
  })

  it('makes matched non-owner scopes non-private', () => {
    const decision = resolverFor([{ match: 'qqbot:*:group:*', scope: 'qq-groups' }]).resolve(session({ tags: ['qqbot:fish:group:42'] }))
    expect(decision).toMatchObject({ scope: 'qq-groups', capture: true, private: false })
    expect(decision.reason).toContain('scope rule 1')
    expect(decision.reason).toContain('qqbot:fish:group:42')
  })

  it('keeps an explicit owner mapping private', () => {
    const rules = [{ match: 'qqbot:*:private:10001', scope: 'owner' }, { match: 'qqbot:*', scope: 'qq-guests' }]
    expect(resolverFor(rules).resolve(session({ tags: ['qqbot:fish:private:10001'] }))).toMatchObject({ scope: OWNER_SCOPE, private: true })
    expect(resolverFor(rules).resolve(session({ tags: ['qqbot:fish:private:20002'] }))).toMatchObject({ scope: 'qq-guests', private: false })
  })

  it('applies the first matching rule in rule order, not tag order', () => {
    const rules = [
      { match: 'preset:companion', scope: 'companion' },
      { match: 'qqbot:*:group:*', scope: 'qq-group-$2' },
      { match: 'qqbot:*', scope: 'qq-any' },
    ]
    const resolver = resolverFor(rules)
    expect(resolver.resolve(session({ tags: ['qqbot:fish:group:7'], agentPreset: 'companion' })).scope).toBe('companion')
    expect(resolver.resolve(session({ tags: ['qqbot:fish:group:7'], agentPreset: 'standard' })).scope).toBe('qq-group-7')
    expect(resolver.resolve(session({ tags: ['qqbot:fish:private:7'] })).scope).toBe('qq-any')
  })

  it('isolates groups through capture templates', () => {
    const resolver = resolverFor([{ match: 'qqbot:*:group:*', scope: 'qq-group-$2' }])
    const a = resolver.resolve(session({ tags: ['qqbot:fish:group:111'] }))
    const b = resolver.resolve(session({ tags: ['qqbot:fish:group:222'] }))
    expect(a.scope).toBe('qq-group-111')
    expect(b.scope).toBe('qq-group-222')
  })

  it('matches synthetic preset, cwd and session tags', () => {
    const resolver = resolverFor([
      { match: 'session:pinned-*', scope: 'pinned' },
      { match: 'preset:qq-room*', scope: 'rooms' },
      { match: 'cwd:/srv/guest/*', scope: 'guest' },
    ])
    expect(resolver.resolve(session({ sessionId: 'pinned-9' })).scope).toBe('pinned')
    expect(resolver.resolve(session({ agentPreset: 'qq-room-public' })).scope).toBe('rooms')
    expect(resolver.resolve(session({ cwd: '/srv/guest/alice' })).scope).toBe('guest')
    expect(resolver.resolve(session({ cwd: '/srv/other' })).scope).toBe(OWNER_SCOPE)
  })

  it('matches case-insensitively', () => {
    expect(resolverFor([{ match: 'QQBOT:*:GROUP:*', scope: 'qq' }]).resolve(session({ tags: ['qqbot:x:group:1'] })).scope).toBe('qq')
  })

  it('sanitizes scope ids and says so in the reason', () => {
    const decision = resolverFor([{ match: 'wechat:*', scope: 'WeChat $1' }]).resolve(session({ tags: ['wechat:家人群'] }))
    expect(decision.scope).toMatch(/^wechat-[0-9a-f]{8}$/)
    expect(decision.private).toBe(false)
    expect(decision.reason).toContain('sanitized from')
  })

  it('never lets a non-owner rule fall back to owner privacy when its template expands to nothing', () => {
    const resolver = resolverFor([{ match: 'room*:*', scope: '$2' }])
    const decision = resolver.resolve(session({ tags: ['room1:'] }))
    expect(decision.scope).toMatch(/^[0-9a-f]{8}$/)
    expect(decision.private).toBe(false)
    expect(resolver.resolve(session({ tags: ['room2:'] })).scope).not.toBe(decision.scope)
  })

  it('does not capture subagents but still scopes them', () => {
    const resolver = resolverFor([{ match: 'qqbot:*:group:*', scope: 'qq-group-$2' }])
    const group = resolver.resolve(session({ origin: 'subagent', tags: ['qqbot:fish:group:5'] }))
    expect(group).toMatchObject({ scope: 'qq-group-5', capture: false, private: false })
    expect(group.reason).toContain('subagent')
    const owner = resolver.resolve(session({ origin: 'subagent', parentSession: 'p', delegationDepth: 1 }))
    expect(owner).toMatchObject({ scope: OWNER_SCOPE, capture: false, private: true })
  })

  it('reads rules live and skips malformed rules', () => {
    let rules: unknown[] = [{ match: 'a:*', scope: 'first' }]
    const resolver = createScopeResolver({ rules: () => rules as ScopeRule[] })
    expect(resolver.resolve(session({ tags: ['a:1'] })).scope).toBe('first')
    rules = [null, { match: '', scope: 'x' }, { match: 'a:*' }, { match: 7, scope: 'x' }, { match: 'a:*', scope: 'second' }]
    expect(resolver.resolve(session({ tags: ['a:1'] })).scope).toBe('second')
  })

  it('treats a throwing or missing rule source as no rules', () => {
    const throwing = createScopeResolver({ rules: () => { throw new Error('boom') } })
    expect(throwing.resolve(session({ tags: ['a'] }))).toMatchObject({ scope: OWNER_SCOPE, private: true })
    const missing = createScopeResolver({ rules: () => undefined })
    expect(missing.resolve(session()).scope).toBe(OWNER_SCOPE)
  })
})

describe('owner guard', () => {
  const decision = (scope: string, isPrivate: boolean): ScopeDecision => ({ scope: scope as ScopeId, capture: true, private: isPrivate, reason: 'test' })

  it('lets only a private owner decision use owner memory', () => {
    expect(mayUseOwnerMemory(decision('owner', true))).toBe(true)
    expect(mayUseOwnerMemory(decision('owner', false))).toBe(false)
    expect(mayUseOwnerMemory(decision('qq-group-1', true))).toBe(false)
  })

  it('reads only the decision\'s own scope, and owner only when private', () => {
    expect(canReadScope(decision('owner', true))).toBe(true)
    expect(canReadScope(decision('owner', false))).toBe(false)
    expect(canReadScope(decision('qq-group-1', false))).toBe(true)
    expect(canReadScope(decision('qq-group-1', false), OWNER_SCOPE)).toBe(false)
    expect(canReadScope(decision('owner', true), 'qq-group-1' as ScopeId)).toBe(false)
  })
})
