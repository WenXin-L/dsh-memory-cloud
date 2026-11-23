/** Session-to-scope mapping, the group-chat privacy firewall, and coexistence detection (design §3.8). */
export type { ScopeDecision, ScopeId, ScopeResolver, ScopeRule, SessionDescriptor } from '../contracts.ts'
export { OWNER_SCOPE } from '../contracts.ts'
export { compileGlob, matchGlob, type CompiledGlob, type GlobOptions } from './glob.ts'
export {
  createScopeResolver,
  descriptorTags,
  expandScopeTemplate,
  isolatedScopeId,
  MAX_SCOPE_ID_LENGTH,
  sanitizeScopeId,
  templateCaptures,
  type ScopeResolverOptions,
} from './resolver.ts'
export {
  canReadScope,
  decideUnmatched,
  isUnmatchedSessions,
  mayUseOwnerMemory,
  UNMATCHED_SESSIONS,
  type UnmatchedDecision,
  type UnmatchedSessions,
} from './guard.ts'
export {
  createSessionTagRegistry,
  describeSession,
  inheritParentTags,
  MAX_SESSION_TAGS,
  MAX_TAG_LENGTH,
  type DescribeSessionOptions,
  type SessionHeaderLike,
  type SessionLike,
  type SessionTagProvider,
  type SessionTagRegistry,
} from './describe.ts'
export {
  detectCoexistence,
  KNOWN_PLUGINS,
  matchesKnownPlugin,
  parseModuleSpecifier,
  type CoexistenceKind,
  type CoexistenceReport,
  type DetectedPlugin,
  type KnownPlugin,
  type ModuleIdentity,
  type ToolConflict,
} from './coexistence.ts'
export { listLoadedRows, listLoadedRowsDeep, loadedRowNames, type LoadedRow, type ServiceLookup } from './loader-rows.ts'
