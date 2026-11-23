import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Injector } from './injector.ts'
import { USAGE_SECTION_NAME } from './usage.ts'

export interface AttachInjectorOptions {
  /** Output of `buildUsageSection()`; registered verbatim with `interpolate: false`. */
  readonly usageSection: string
  readonly sectionName?: string
  /** Defaults to just after the SDK tool sections. */
  readonly sectionOrder?: number
}

/**
 * Register the usage section, the `agent/pre-step` injector, and per-session
 * cleanup on `agent/disposed`. The returned disposer (also run when `ctx`
 * unloads) removes all three and disposes the injector.
 */
export function attachInjector(ctx: Context, injector: Injector<Agent>, options: AttachInjectorOptions): () => void {
  return ctx.effect(() => {
    const disposers = [
      ctx.systemPrompt.section({
        name: options.sectionName ?? USAGE_SECTION_NAME,
        order: options.sectionOrder ?? ctx.systemPrompt.getSectionOrder('TOOLS_SDK') + 100,
        text: options.usageSection,
        interpolate: false,
      }),
      ctx.on('agent/pre-step', (payload, next) => injector.preStep(payload, next)),
      ctx.on('agent/disposed', ({ agent }) => {
        injector.forget(agent.session.id)
      }),
    ]
    return () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
      injector.dispose()
    }
  }, 'memory-cloud inject')
}
