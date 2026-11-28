/**
 * Structural views of the browser services the settings page uses. They are
 * provided by DSH's Web client at runtime (`ctx.remote` from
 * `@deepseek-ai/dsh-api-gateway/client`, `ctx.slots` from
 * `@deepseek-ai/dsh-client-ui-slots`, `ctx.locale` from
 * `@deepseek-ai/dsh-client-locale`); this bundle never imports those packages.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import type { CompactionMode, CompressionLevel } from '../contracts.ts'
import type { SettingWriteResult } from '../runtime/settings.ts'
import type { MemoryCloudStatus, TakeoverActionResult } from '../runtime/status.ts'
import type { ConfigPatch, ConfigView, RemoteContribution } from './contract.ts'

/** A snapshot source; slot `inject.hooks` members of this shape become `use<Name>(selector)` props. */
export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface RemoteFailureLike {
  readonly code: string
  readonly message: string
}

/** `RemoteResult<T>`: generated Remote methods resolve to it and never reject for carrier failures. */
export type RemoteResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailureLike }

/** `ctx.remote.memoryCloud` once {@link memoryCloudContribution} is mounted; a trailing `AbortSignal` is optional. */
export interface MemoryCloudRemoteClient {
  status(sessionId: string | undefined, signal?: AbortSignal): Promise<RemoteResultLike<MemoryCloudStatus>>
  setLevel(level: CompressionLevel, signal?: AbortSignal): Promise<RemoteResultLike<SettingWriteResult>>
  setMode(mode: CompactionMode, signal?: AbortSignal): Promise<RemoteResultLike<SettingWriteResult>>
  takeover(presetId: string | undefined, signal?: AbortSignal): Promise<RemoteResultLike<TakeoverActionResult>>
  restore(presetId: string | undefined, signal?: AbortSignal): Promise<RemoteResultLike<TakeoverActionResult>>
  getConfig(signal?: AbortSignal): Promise<RemoteResultLike<ConfigView>>
  setConfig(patch: ConfigPatch, signal?: AbortSignal): Promise<RemoteResultLike<SettingWriteResult>>
}

export interface ClientRemoteLike {
  $mount(contribution: RemoteContribution): Promise<() => Promise<void>>
  readonly memoryCloud: MemoryCloudRemoteClient
}

export interface LocaleSnapshot {
  readonly active: string
}

export interface LocaleLike extends HostObservable<LocaleSnapshot> {
  register(ns: string, dictionaries: { readonly en: Readonly<Record<string, string>>; readonly zh: Readonly<Record<string, string>> }): () => void
}

/**
 * One slot registration. `key` addresses a keyed slot (the bundle's own card);
 * `id`, `order` and `label` register a list entry, such as a row in the
 * Settings page's section list.
 */
export interface SlotRegistration {
  readonly name: string
  readonly key?: string
  readonly id?: string
  readonly order?: number
  readonly label?: () => string
  readonly locale: string
  readonly inject?: () => object
}

export interface SlotsLike {
  inject(owner: string, install: () => () => void): unknown
  register(options: SlotRegistration, component: ComponentType<never>): () => void
}

export interface ClientContext extends Context {
  readonly remote: ClientRemoteLike
  readonly slots: SlotsLike
  readonly locale: LocaleLike
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Emitted by the Client Remote service each time the Host connection (re)opens. */
    'connection/reset'(): void
  }
}
