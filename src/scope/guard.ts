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
 * isolates unmatched sessions when a known bridge is detected. A bridge may
 * supply no chat-specific tag. Without a detected bridge, `auto` uses owner.
 * An invalid setting fails closed to `isolated`.
 */
export function decideUnmatched(setting: unknown, bridges: readonly string[] = []): UnmatchedDecision {
  if (setting === 'owner') {
    return { setting, mode: 'owner', bridges: [], reason: 'unmatchedSessions=owner · 未匹配的会话使用主人的私有作用域。 / Unmatched sessions use the private owner scope.' }
  }
  if (setting === 'auto') {
    return bridges.length > 0
      ? { setting, mode: 'isolated', bridges: [...bridges], reason: `unmatchedSessions=auto (${bridges.join(', ')}) · 已加载聊天桥接，未匹配的会话各自隔离。要访问主人记忆，请用规则将自己的会话映射到 owner。 / A chat bridge is loaded. Unmatched sessions are isolated. Map your own sessions to owner to access owner memory.` }
      : { setting, mode: 'owner', bridges: [], reason: 'unmatchedSessions=auto · 未检测到已知聊天桥接，未匹配的会话可以读取主人记忆。 / No recognized chat bridge was detected. Unmatched sessions use the private owner scope and can read owner memory.' }
  }
  if (setting === 'isolated') {
    return { setting, mode: 'isolated', bridges: [], reason: 'unmatchedSessions=isolated · 未匹配的会话各自隔离。 / Unmatched sessions are isolated.' }
  }
  return { setting: 'isolated', mode: 'isolated', bridges: [], reason: `unmatchedSessions=${JSON.stringify(setting)} · 设置值无效，未匹配的会话各自隔离。 / Unrecognized setting. Unmatched sessions are isolated.` }
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
