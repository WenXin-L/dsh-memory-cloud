/**
 * Structural views of the optional DSH host services the runtime reads with
 * `ctx.get()`. None of them is declared in `inject`: each may be absent
 * (headless, sdk, older hosts) and every caller degrades when it is.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { ConfigEditorLike, PluginManagerLike } from '../engine/index.ts'

/** `ctx.agentDefaultModel` (dsh-base): the profile's default route. */
export interface AgentDefaultModelLike {
  currentSelection(): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined
}

/** `ctx.agentPresets` (`@deepseek-ai/dsh-agent-preset-registry`). */
export interface AgentPresetsLike {
  serviceFor(agent: Agent, name: 'compaction'): unknown
}

/** The `CompactionEngine` entry point idle consolidation and `/memory compact-now` use. */
export interface CompactionServiceLike {
  compactNow(agent: Agent, signal: AbortSignal): Promise<CompactionResult | null>
}

/** `ctx.settings` (`@deepseek-ai/dsh-settings`): writes volatile fields of a Loader row. */
export interface SettingsLike {
  update(ns: string, patch: object): Promise<void>
}

/** `ctx.profileContext` (`@deepseek-ai/dsh-app-boot`), present only under `dsh --profile`. */
export interface ProfileContextLike {
  readonly name: string
}

/** Narrow handle on the session-log upload service. */
export interface SessionLogLike {
  registerExclusion(exclude: (request: { readonly purpose?: string }) => boolean): () => unknown
}

export function optionalService<T>(ctx: Context, name: string): T | undefined {
  try {
    const value: unknown = ctx.get(name)
    return value === undefined || value === null ? undefined : value as T
  } catch {
    return undefined
  }
}

export function hasMethod<K extends string>(value: unknown, key: K): value is Record<K, (...args: never[]) => unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[key] === 'function'
}

export const configEditorOf = (ctx: Context): ConfigEditorLike | undefined => {
  const editor = optionalService<unknown>(ctx, 'configEditor')
  return hasMethod(editor, 'edit') && hasMethod(editor, 'entries') && hasMethod(editor, 'configuration') ? editor as unknown as ConfigEditorLike : undefined
}

export const pluginManagerOf = (ctx: Context): PluginManagerLike | undefined => {
  const manager = optionalService<unknown>(ctx, 'pluginManager')
  return hasMethod(manager, 'listPlugins') && hasMethod(manager, 'setPluginEnabled') ? manager as unknown as PluginManagerLike : undefined
}

/** The compaction service that owns `agent`: its preset's isolated engine, else the host-level one. */
export function compactionServiceOf(ctx: Context, agent: Agent): unknown {
  const presets = optionalService<unknown>(ctx, 'agentPresets')
  if (hasMethod(presets, 'serviceFor')) {
    try {
      const service = (presets as unknown as AgentPresetsLike).serviceFor(agent, 'compaction')
      if (service !== undefined && service !== null) return service
    } catch {}
  }
  return optionalService<unknown>(ctx, 'compaction')
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
