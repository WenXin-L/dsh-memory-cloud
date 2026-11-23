import { OWNER_SCOPE, type ScopeDecision, type ScopeId } from '../contracts.ts'

/** Config values of `unmatchedSessions`: what a session no scope rule matches gets. */
export const UNMATCHED_SESSIONS = ['auto', 'owner', 'isolated'] as const
export type UnmatchedSessions = (typeof UNMATCHED_SESSIONS)[number]

/** How sessions no scope rule matches are scoped right now, and why. */
export interface UnmatchedDecision {
  readonly setting: UnmatchedSessions
  readonly mode: 'owner' | 'isolated'
  /** Chat-bridge plugins that made `auto` isolate unmatched sessions. */
  readonly bridges: readonly string[]
  readonly reason: string
}

export function isUnmatchedSessions(value: unknown): value is UnmatchedSessions {
  return typeof value === 'string' && (UNMATCHED_SESSIONS as readonly string[]).includes(value)
}

/**
 * Resolve the `unmatchedSessions` setting (design §3.8 firewall): `auto`
 * isolates unmatched sessions whenever a chat-bridge plugin is loaded, because
 * bridge sessions carry no tags that rules could match, and keeps them in the
 * owner scope otherwise. Anything unrecognised fails closed to `isolated`.
 */
export function decideUnmatched(setting: unknown, bridges: readonly string[] = []): UnmatchedDecision {
  if (setting === 'owner') {
    return { setting, mode: 'owner', bridges: [], reason: 'unmatchedSessions=owner: unmatched sessions use the private owner scope' }
  }
  if (setting === 'auto') {
    return bridges.length > 0
      ? { setting, mode: 'isolated', bridges: [...bridges], reason: `unmatchedSessions=auto with chat bridge ${bridges.join(', ')} loaded: unmatched sessions are isolated; map your own sessions to owner with a rule` }
      : { setting, mode: 'owner', bridges: [], reason: 'unmatchedSessions=auto and no chat bridge loaded: unmatched sessions use the private owner scope' }
  }
  if (setting === 'isolated') {
    return { setting, mode: 'isolated', bridges: [], reason: 'unmatchedSessions=isolated: unmatched sessions are isolated' }
  }
  return { setting: 'isolated', mode: 'isolated', bridges: [], reason: `unmatchedSessions ${JSON.stringify(setting)} is not recognised; unmatched sessions are isolated` }
}

/** Whether the session may see owner-private memory: only an owner decision marked private. */
export function mayUseOwnerMemory(decision: ScopeDecision): boolean {
  return decision.scope === OWNER_SCOPE && decision.private
}

/**
 * Whether a session with `decision` may read (inject, recall, checkpoint)
 * memory of `scope`, by default its own: never another session's scope, and
 * the owner scope only through {@link mayUseOwnerMemory}.
 */
export function canReadScope(decision: ScopeDecision, scope: ScopeId = decision.scope): boolean {
  if (scope !== decision.scope) return false
  return scope !== OWNER_SCOPE || mayUseOwnerMemory(decision)
}
