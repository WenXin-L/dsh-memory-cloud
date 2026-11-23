/**
 * Browser half: the settings page registered into the Plugins page's
 * `plugins.bundle.config` slot (keyed by package name). It mounts the
 * `memoryCloud` Remote contribution and reads status and runs actions through
 * `ctx.remote.memoryCloud`, which the host half binds in `src/runtime/remote.ts`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { memoryCloudContribution, PACKAGE_NAME, REMOTE_NAMESPACE } from './contract.ts'
import type { ClientContext } from './host.ts'
import { en, NS, zh } from './locales.ts'
import { MemoryCloudPage } from './MemoryCloudPage.tsx'
import { createConfigStore } from './config-store.ts'
import { createStatusStore } from './store.ts'

export const inject = ['remote', 'slots', 'locale']

function mountPage(ctx: ClientContext): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() }, 'memory-cloud: status queries')
  const store = createStatusStore(ctx.remote.memoryCloud, lifetime.signal)
  const config = createConfigStore(ctx.remote.memoryCloud, lifetime.signal)
  ctx.on('connection/reset', () => {
    if (store.getSnapshot().phase !== 'idle') store.reload()
    if (config.getSnapshot().phase !== 'idle') void config.load()
  })
  const face = {
    hooks: { status: store, locale: ctx.locale, config },
    reload: store.reload,
    takeover: () => { void store.takeover() },
    restore: () => { void store.restore() },
    setLevel: (level: Parameters<typeof store.setLevel>[0]) => { void store.setLevel(level) },
    setMode: (mode: Parameters<typeof store.setMode>[0]) => { void store.setMode(mode) },
    loadConfig: () => { void config.load() },
    saveConfig: (patch: Parameters<typeof config.save>[0]) => {
      void config.save(patch).then((saved) => { if (saved) store.reload() })
    },
  }
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: PACKAGE_NAME,
    locale: NS,
    inject: () => face,
  }, MemoryCloudPage))
}

export async function apply(ctx: Context): Promise<void> {
  const client = ctx as ClientContext
  client.effect(() => client.locale.register(NS, { en, zh }), 'memory-cloud: dictionaries')
  await client.remote.$mount(memoryCloudContribution())
  ctx.inject([`remote.${REMOTE_NAMESPACE}`], (scope) => { mountPage(scope as ClientContext) })
}
