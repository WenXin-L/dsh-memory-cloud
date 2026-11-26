import type { SessionDescriptor } from '../contracts.ts'

/**
 * Structural subset of DSH `Session` (`@deepseek-ai/dsh-session`): `id` plus
 * the immutable `SessionHeader` fields that matter for scoping. A real
 * `Session` is assignable; tests can pass plain objects.
 */
export interface SessionHeaderLike {
  readonly id?: string
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: string
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

export interface SessionLike {
  readonly id?: string
  readonly header?: SessionHeaderLike
}

/**
 * Extra routing tags for one session, e.g. `qqbot:<bot>:group:<id>` from a
 * chat bridge. `SessionHeader` has no tag field,
 * so bridges or the integrator supply tags through providers. `base` is the
 * header-derived descriptor without tags. Providers must be synchronous;
 * a throwing provider is skipped.
 */
export type SessionTagProvider = (session: SessionLike, base: SessionDescriptor) => Iterable<string> | null | undefined | void

export interface DescribeSessionOptions {
  readonly tagProviders?: Iterable<SessionTagProvider>
  readonly onProviderError?: (error: unknown) => void
  /**
   * The preset the session runs now, when known. The header's `agentPreset`
   * is only the creation-time value: a blank session can switch presets
   * (`agent-preset/selected`), and this replaces it.
   */
  readonly agentPreset?: string
}

export const MAX_SESSION_TAGS = 64
export const MAX_TAG_LENGTH = 1024

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function collectTags(output: unknown, into: Set<string>): void {
  if (output === null || output === undefined || typeof output === 'string') return
  if (typeof (output as Iterable<unknown>)[Symbol.iterator] !== 'function') return
  for (const value of output as Iterable<unknown>) {
    if (into.size >= MAX_SESSION_TAGS) return
    if (typeof value !== 'string') continue
    const tag = value.trim()
    if (tag !== '' && tag.length <= MAX_TAG_LENGTH) into.add(tag)
  }
}

/** Build a {@link SessionDescriptor} from a DSH session header plus provider tags. */
export function describeSession(session: SessionLike, options: DescribeSessionOptions = {}): SessionDescriptor {
  const header = session.header ?? {}
  const depth = header.delegationDepth
  const cwd = text(header.cwd)
  const parentSession = text(header.parentSession)
  const agentPreset = text(options.agentPreset) ?? text(header.agentPreset)
  const base: SessionDescriptor = {
    sessionId: text(header.id) ?? text(session.id) ?? '',
    ...header.origin === 'subagent' ? { origin: 'subagent' as const } : {},
    ...parentSession === undefined ? {} : { parentSession },
    ...typeof depth === 'number' && Number.isFinite(depth) && depth >= 0 ? { delegationDepth: depth } : {},
    ...agentPreset === undefined ? {} : { agentPreset },
    ...cwd === undefined ? {} : { cwd },
  }
  const tags = new Set<string>()
  for (const provider of options.tagProviders ?? []) {
    try {
      collectTags(provider(session, base), tags)
    } catch (error) {
      try {
        options.onProviderError?.(error)
      } catch {}
    }
  }
  return tags.size === 0 ? base : { ...base, tags: [...tags] }
}

/**
 * Provider that copies a parent session's tags onto a child (subagents and
 * forks carry `parentSession`), so a subagent spawned inside a group chat
 * resolves to the group's scope instead of falling back to the owner scope.
 * `lookup` typically reads a cache of descriptors built at `session/created`.
 */
export function inheritParentTags(lookup: (sessionId: string) => readonly string[] | undefined): SessionTagProvider {
  return (_session, base) => base.parentSession === undefined ? undefined : lookup(base.parentSession)
}

/** Explicit per-session tags set by the integrator or a bridge, exposed as a provider. */
export interface SessionTagRegistry {
  readonly provider: SessionTagProvider
  set(sessionId: string, tags: Iterable<string>): void
  get(sessionId: string): readonly string[]
  delete(sessionId: string): void
}

/**
 * Pass `tags` to keep the entries somewhere that outlives the registry, e.g.
 * a map shared by plugin reloads in one process, so live sessions keep the
 * tags a bridge set before the reload.
 */
export function createSessionTagRegistry(tags: Map<string, readonly string[]> = new Map()): SessionTagRegistry {
  return {
    provider: (_session, base) => tags.get(base.sessionId),
    set(sessionId, values) {
      const collected = new Set<string>()
      collectTags(values, collected)
      if (collected.size === 0) tags.delete(sessionId)
      else tags.set(sessionId, [...collected])
    },
    get: sessionId => tags.get(sessionId) ?? [],
    delete(sessionId) {
      tags.delete(sessionId)
    },
  }
}
