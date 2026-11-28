/**
 * Browser half: one page mounted in three seats — the bundle's card on the
 * Plugins page (`plugins.bundle.config`, keyed by package name), a section of
 * the Settings dialog (`settings.section`), and a full-width panel with its own
 * sidebar row (`main` + `sidebar.panellist`). They share one set of stores
 * backed by `ctx.remote.memoryCloud`, bound in `src/runtime/remote.ts`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { memoryCloudContribution, PACKAGE_NAME, REMOTE_NAMESPACE } from './contract.ts'
import type { ClientContext } from './host.ts'
import { en, NS, zh } from './locales.ts'
import { MemoryCloudIcon } from './MemoryCloudIcon.tsx'
import { MemoryCloudPage } from './MemoryCloudPage.tsx'
import { createConfigStore } from './config-store.ts'
import { createStatusStore } from './store.ts'
import { languageOf } from './view-model.ts'

/** Sidebar panel id; the same key selects the `main` entry and the `sidebar.panellist` row. */
const PANEL_ID = 'memory-cloud'

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
  // Re-resolved on every locale revision, so the section title follows the host language.
  const sectionLabel = (): string => languageOf(ctx.locale.getSnapshot().active) === 'zh' ? zh.settingsNav : en.settingsNav
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory-cloud',
    order: 20,
    label: sectionLabel,
    locale: NS,
    inject: () => face,
  }, MemoryCloudPage))
  const panelFace = { ...face, surface: 'panel' as const }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => panelFace,
  }, MemoryCloudPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: sectionLabel,
    locale: NS,
  }, MemoryCloudIcon))
}

export async function apply(ctx: Context): Promise<void> {
  const client = ctx as ClientContext
  client.effect(() => client.locale.register(NS, { en, zh }), 'memory-cloud: dictionaries')
  await client.remote.$mount(memoryCloudContribution())
  ctx.inject([`remote.${REMOTE_NAMESPACE}`], (scope) => { mountPage(scope as ClientContext) })
}
