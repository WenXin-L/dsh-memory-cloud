/**
 * Host half of the `memoryCloud` Remote: exposes `ctx.memoryCloud.api` to the
 * browser settings page through DSH's Typert Gateway (`@deepseek-ai/dsh-api-gateway`).
 * The service is discovered in SRC mode: a provided object carrying a
 * `typertRemote` binding whose prototype methods carry `@Remote` markers. The
 * Gateway derives wire parameters from the method source, checks JSON safety
 * only, and refuses non-owner peers unless remote access allows them.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertGatewayBinding } from '@deepseek-ai/dsh-typert-protocol'
import { parseConfigPatch, parseLevel, parseMode, parseOptionalId, REMOTE_METHODS, REMOTE_NAMESPACE, REMOTE_SERVICE } from '../client/contract.ts'
import type { ConfigView } from '../client/contract.ts'
import { errorMessage } from './host.ts'
import type { ConfigAccess, SettingWriteResult } from './settings.ts'
import type { MemoryCloudApi, MemoryCloudStatus, TakeoverActionResult } from './status.ts'

interface AgentLike {
  readonly session: { readonly id: string; readonly header: { readonly origin?: string } }
}

/** Live non-subagent sessions ordered by their last activity. */
export interface RecentSessions {
  touch(agent: AgentLike): void
  forget(agent: AgentLike): void
  latest(): string | undefined
}

export function createRecentSessions(): RecentSessions {
  const owners = new Map<string, AgentLike>()
  return {
    touch(agent) {
      if (agent.session.header.origin === 'subagent') return
      owners.delete(agent.session.id)
      owners.set(agent.session.id, agent)
    },
    forget(agent) {
      if (owners.get(agent.session.id) === agent) owners.delete(agent.session.id)
    },
    latest: () => [...owners.keys()].at(-1),
  }
}

/** Plain JSON as the browser receives it: `undefined` fields dropped, non-finite numbers as `null`. */
export function toWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function withArgument<A, R>(parse: (value: unknown) => A, value: unknown, invalid: (message: string) => R, run: (argument: A) => Promise<R>): Promise<R> {
  let argument: A
  try {
    argument = parse(value)
  } catch (error) {
    return invalid(errorMessage(error))
  }
  return toWire(await run(argument))
}

const invalidSetting = (message: string): SettingWriteResult => ({ ok: false, message })
const invalidPreset = (message: string): TakeoverActionResult => ({ kind: 'preset', ok: false, code: 'preset-not-found', message })

/**
 * Remote face of {@link MemoryCloudApi} plus the live settings
 * ({@link ConfigAccess}). Arguments arrive as unchecked JSON, so each method
 * validates with the shared contract parsers and answers a failure result
 * instead of throwing. `status()` without a session id describes the most
 * recently active session, if any.
 */
export class MemoryCloudRemote {
  readonly typertRemote: TypertGatewayBinding<MemoryCloudRemote>
  readonly #api: MemoryCloudApi
  readonly #config: ConfigAccess
  readonly #recentSession: () => string | undefined

  constructor(api: MemoryCloudApi, config: ConfigAccess, recentSession: () => string | undefined) {
    this.#api = api
    this.#config = config
    this.#recentSession = recentSession
    this.typertRemote = bindTypertRemote(this, REMOTE_SERVICE, { namespace: REMOTE_NAMESPACE })
  }

  async status(sessionId: unknown): Promise<MemoryCloudStatus> {
    const requested = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
    return toWire(await this.#api.status(requested ?? this.#recentSession()))
  }

  setLevel(level: unknown): Promise<SettingWriteResult> {
    return withArgument(parseLevel, level, invalidSetting, value => this.#api.setLevel(value))
  }

  setMode(mode: unknown): Promise<SettingWriteResult> {
    return withArgument(parseMode, mode, invalidSetting, value => this.#api.setMode(value))
  }

  takeover(presetId: unknown): Promise<TakeoverActionResult> {
    return withArgument(parseOptionalId, presetId, invalidPreset, value => this.#api.takeover(value))
  }

  restore(presetId: unknown): Promise<TakeoverActionResult> {
    return withArgument(parseOptionalId, presetId, invalidPreset, value => this.#api.restore(value))
  }

  async getConfig(): Promise<ConfigView> {
    return toWire(this.#config.get())
  }

  setConfig(patch: unknown): Promise<SettingWriteResult> {
    return withArgument(parseConfigPatch, patch, invalidSetting, value => this.#config.set(value))
  }
}

/**
 * Apply `@Remote` to each method through the standard decorator protocol,
 * because this package's build (tsdown/rolldown) cannot lower decorator syntax.
 */
function markRemoteMethods(prototype: object, methods: readonly string[]): void {
  for (const name of methods) {
    const method = Reflect.get(prototype, name) as (this: object, ...args: unknown[]) => unknown
    Remote(method, {
      kind: 'method',
      name,
      static: false,
      private: false,
      metadata: {},
      access: { has: object => name in object, get: object => Reflect.get(object, name) },
      addInitializer: initializer => initializer.call(Object.create(prototype)),
    } as ClassMethodDecoratorContext<object, (this: object, ...args: unknown[]) => unknown>)
  }
}

markRemoteMethods(MemoryCloudRemote.prototype, Object.keys(REMOTE_METHODS))

/**
 * Provide the Remote binding for `api` and `config` on `ctx` and track session
 * activity for `status()`. Inert without a Typert Gateway (headless, sdk).
 */
export function registerMemoryCloudRemote(ctx: Context, api: MemoryCloudApi, config: ConfigAccess): MemoryCloudRemote {
  const recent = createRecentSessions()
  ctx.on('agent/created', ({ agent }) => {
    recent.touch(agent)
    return undefined
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') recent.touch(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => recent.forget(agent))
  const remote = new MemoryCloudRemote(api, config, () => recent.latest())
  ctx.provide(REMOTE_SERVICE, remote)
  return remote
}
