import { OWNER_SCOPE, type ScopeDecision, type ScopeId, type ScopeResolver, type ScopeRule, type SessionDescriptor } from '../contracts.ts'
import { compileGlob, type CompiledGlob } from './glob.ts'
import { decideUnmatched, type UnmatchedDecision } from './guard.ts'

export const MAX_SCOPE_ID_LENGTH = 64

const HASH_LENGTH = 8
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/
const encoder = new TextEncoder()

/** 32-bit FNV-1a of the UTF-8 bytes, as 8 hex digits. Persisted in directory names, so it must never change. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (const byte of encoder.encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(HASH_LENGTH, '0')
}

/**
 * Turn arbitrary text into a directory-safe scope id: lowercase `[a-z0-9_-]`,
 * at most {@link MAX_SCOPE_ID_LENGTH} characters, no leading/trailing `-`,
 * never a Windows device name. Ids that already satisfy this are returned
 * unchanged; any other input gets a `-<hash>` suffix of the original text so
 * distinct inputs (including ones differing only in case) stay distinct. The
 * result is a fixed point: sanitizing it again changes nothing.
 */
export function sanitizeScopeId(raw: string): ScopeId {
  const base = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (base === raw && base.length > 0 && base.length <= MAX_SCOPE_ID_LENGTH && !WINDOWS_RESERVED.test(base)) {
    return base as ScopeId
  }
  const hash = fnv1a(raw)
  const head = base.slice(0, MAX_SCOPE_ID_LENGTH - HASH_LENGTH - 1).replace(/-+$/, '')
  return `${head || 'scope'}-${hash}` as ScopeId
}

/** Bridge tags first, then the synthetic `preset:`, `cwd:` and `session:` tags, deduplicated. */
export function descriptorTags(session: SessionDescriptor): readonly string[] {
  const tags = new Set<string>()
  for (const tag of session.tags ?? []) {
    if (typeof tag === 'string' && tag !== '') tags.add(tag)
  }
  if (session.agentPreset) tags.add(`preset:${session.agentPreset}`)
  if (session.cwd) tags.add(`cwd:${session.cwd}`)
  if (session.sessionId) tags.add(`session:${session.sessionId}`)
  return [...tags]
}

const TEMPLATE_KEY = /\$([$&\d])/g

/** Highest `$1`–`$9` capture a scope template uses (`$$`, `$&` and `$0` need none). */
export function templateCaptures(template: string): number {
  let highest = 0
  for (const [, key] of template.matchAll(TEMPLATE_KEY)) {
    const index = Number(key)
    if (Number.isInteger(index) && index > highest) highest = index
  }
  return highest
}

/**
 * Substitute wildcard captures into a rule's scope template: `$1`…`$9` are
 * the captures of the matching tag, `$&` (or `$0`) the whole tag, `$$` a
 * literal `$`. A missing or empty capture expands to a hash of the whole tag,
 * so distinct tags never collapse into one scope.
 */
export function expandScopeTemplate(template: string, captures: readonly string[], tag: string): string {
  return template.replace(TEMPLATE_KEY, (_, key: string) => {
    if (key === '$') return '$'
    if (key === '&' || key === '0') return tag
    const capture = captures[Number(key) - 1]
    return capture === undefined || capture === '' ? fnv1a(tag) : capture
  })
}

/** The scope of a session no rule matched while unmatched sessions are isolated. */
export function isolatedScopeId(session: SessionDescriptor): ScopeId {
  const key = session.origin === 'subagent' && session.parentSession ? session.parentSession : session.sessionId
  return `session-${fnv1a(key)}` as ScopeId
}

export interface ScopeResolverOptions {
  /** Read on every `resolve()` call, so a volatile config getter applies live. */
  readonly rules: () => readonly ScopeRule[] | undefined
  /**
   * How sessions no rule matches are scoped, read on every `resolve()` call.
   * Default: the private owner scope. A throwing getter isolates them.
   */
  readonly unmatched?: () => UnmatchedDecision
  /** Reports a rule that is skipped, once per distinct rule. */
  readonly onWarning?: (message: string) => void
}

const MAX_CACHED_GLOBS = 256

function isRule(value: unknown): value is ScopeRule {
  if (typeof value !== 'object' || value === null) return false
  const { match, scope } = value as Record<string, unknown>
  return typeof match === 'string' && match !== '' && typeof scope === 'string'
}

/**
 * Map sessions to memory scopes (design §3.8). Rules are tried in order and
 * the first rule whose glob matches any of the session's tags wins; matching
 * is case-insensitive. Only a rule whose template is literally `owner` makes a
 * session private; a template that merely expands to `owner` gets a hashed
 * scope instead. A rule whose template uses more captures than its glob has
 * wildcards is skipped. Sessions no rule matches follow `unmatched`: the
 * private owner scope, or an isolated per-session scope. Subagent sessions
 * resolve like any other session but are never captured.
 */
export function createScopeResolver(options: ScopeResolverOptions): ScopeResolver {
  const globs = new Map<string, CompiledGlob>()
  const compiled = (pattern: string): CompiledGlob => {
    let glob = globs.get(pattern)
    if (glob === undefined) {
      if (globs.size >= MAX_CACHED_GLOBS) globs.clear()
      glob = compileGlob(pattern, { caseInsensitive: true })
      globs.set(pattern, glob)
    }
    return glob
  }

  const readRules = (): readonly unknown[] => {
    try {
      const rules = options.rules()
      return Array.isArray(rules) ? rules : []
    } catch {
      return []
    }
  }

  const warned = new Set<string>()
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    if (warned.size >= MAX_CACHED_GLOBS) warned.clear()
    warned.add(key)
    try {
      options.onWarning?.(message)
    } catch {}
  }

  const readUnmatched = (): UnmatchedDecision => {
    if (options.unmatched === undefined) return decideUnmatched('owner')
    try {
      return options.unmatched()
    } catch (error) {
      const decision = decideUnmatched('isolated')
      return { ...decision, reason: `could not decide how to scope unmatched sessions (${error instanceof Error ? error.message : String(error)}); unmatched sessions are isolated` }
    }
  }

  return {
    resolve(session: SessionDescriptor): ScopeDecision {
      const capture = session.origin !== 'subagent'
      const suffix = capture ? '' : '; subagent session, capture disabled'
      const tags = descriptorTags(session)
      const rules = readRules()
      for (const [index, rule] of rules.entries()) {
        if (!isRule(rule)) continue
        const glob = compiled(rule.match)
        const needed = templateCaptures(rule.scope)
        if (needed > glob.wildcards) {
          warnOnce(`${rule.match}\0${rule.scope}`, `scope rule ${index + 1} ${JSON.stringify(rule.match)} -> ${JSON.stringify(rule.scope)} is skipped: the scope uses $${needed} but the pattern has ${glob.wildcards} wildcard(s)`)
          continue
        }
        for (const tag of tags) {
          const captures = glob.match(tag)
          if (captures === undefined) continue
          const raw = expandScopeTemplate(rule.scope, captures, tag)
          const literalOwner = rule.scope === OWNER_SCOPE
          let scope = sanitizeScopeId(raw)
          if (scope === OWNER_SCOPE && !literalOwner) scope = `${OWNER_SCOPE}-${fnv1a(tag)}` as ScopeId
          const sanitized = raw === scope ? '' : ` (sanitized from ${JSON.stringify(raw)})`
          return {
            scope,
            capture,
            private: literalOwner,
            reason: `scope rule ${index + 1} ${JSON.stringify(rule.match)} matched tag ${JSON.stringify(tag)} -> scope ${scope}${sanitized}${suffix}`,
          }
        }
      }
      const unmatched = readUnmatched()
      if (unmatched.mode === 'owner') {
        return { scope: OWNER_SCOPE, capture, private: true, reason: `no scope rule matched; ${unmatched.reason}${suffix}` }
      }
      const scope = isolatedScopeId(session)
      return {
        scope,
        capture,
        private: false,
        reason: `no scope rule matched; ${unmatched.reason}; isolated scope ${scope} without owner memory${suffix}`,
      }
    },
  }
}
