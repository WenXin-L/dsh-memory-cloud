import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { CompactionMode, CompressionLevel } from '../contracts.ts'
import type { MemoryCloudStatus } from '../runtime/status.ts'
import { AdvancedSettings } from './AdvancedSettings.tsx'
import { CompactionSettings } from './CompactionSettings.tsx'
import type { ConfigSnapshot } from './config-store.ts'
import type { ConfigPatch } from './contract.ts'
import type { LocaleSnapshot } from './host.ts'
import type { StatusSnapshot } from './store.ts'
import { STYLES } from './styles.ts'
import { languageOf, statusFacts } from './view-model.ts'
import type { Fact, Language, Translate } from './view-model.ts'

export interface MemoryCloudPageProps {
  /** Only the plugin card supplies a view. */
  readonly view?: 'summary' | 'page'
  readonly surface?: 'panel'
  readonly t: Translate
  readonly useStatus: <S>(selector: (snapshot: StatusSnapshot) => S) => S
  readonly useLocale: <S>(selector: (snapshot: LocaleSnapshot) => S) => S
  readonly useConfig: <S>(selector: (snapshot: ConfigSnapshot) => S) => S
  readonly loadConfig: () => void
  readonly saveConfig: (patch: ConfigPatch) => void
  readonly reload: () => void
  readonly takeover: () => void
  readonly restore: () => void
  readonly setLevel: (level: CompressionLevel) => void
  readonly setMode: (mode: CompactionMode) => void
}

const TABS = [
  { id: 'status', label: 'tabStatus' },
  { id: 'compaction', label: 'tabCompaction' },
  { id: 'advanced', label: 'tabAdvanced' },
] as const

type Tab = typeof TABS[number]['id']

const OVERVIEW_FACTS = new Set(['mode', 'level'])
const MEMORY_FACTS = new Set(['budget', 'firewall', 'episodes', 'storage'])

function FactList({ facts, overview }: { readonly facts: readonly Fact[]; readonly overview?: true }): ReactNode {
  return (
    <dl className={overview ? 'mcb-facts mcb-overview' : 'mcb-facts'}>
      {facts.map(fact => (
        <div key={fact.key} className="mcb-fact" data-fact={fact.key}>
          <dt>{fact.label}</dt>
          <dd>
            {fact.tag === undefined ? null : <span className="mcb-tag" data-tone={fact.tag.tone}>{fact.tag.text}</span>}
            {fact.lines.map((line, index) => (
              <span key={index} className="mcb-line" data-tone={line.tone} data-muted={line.muted ? '' : undefined}>{line.text}</span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function StatusOverview({ status, language, t }: {
  readonly status: MemoryCloudStatus
  readonly language: Language
  readonly t: Translate
}): ReactNode {
  const facts = statusFacts(status, t, language)
  return (
    <section className="mcb-status" data-section="status" aria-label={t('statusTitle')}>
      <FactList facts={facts.filter(fact => OVERVIEW_FACTS.has(fact.key))} overview />
      <div className="mcb-status-details">
        <section className="mcb-detail-group">
          <h3 className="mcb-title">{t('statusMemoryTitle')}</h3>
          <FactList facts={facts.filter(fact => MEMORY_FACTS.has(fact.key))} />
        </section>
        <section className="mcb-detail-group">
          <h3 className="mcb-title">{t('statusRuntimeTitle')}</h3>
          <FactList facts={facts.filter(fact => !MEMORY_FACTS.has(fact.key) && !OVERVIEW_FACTS.has(fact.key))} />
        </section>
      </div>
    </section>
  )
}

/** The same console fits the sidebar panel, the Settings dialog, and the plugin card. */
export function MemoryCloudPage(props: MemoryCloudPageProps): ReactNode {
  const { t, reload, view } = props
  const snapshot = props.useStatus(value => value)
  const language = languageOf(props.useLocale(value => value.active))
  const instanceId = useId()
  const surface = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<Tab>('status')
  useEffect(() => { if (view !== 'summary') reload() }, [reload, view])
  if (view === 'summary') return null

  const { status, pending, failure } = snapshot
  const isPanel = props.surface === 'panel'
  const tabId = (item: Tab) => `${instanceId}-tab-${item}`
  const panelId = (item: Tab) => `${instanceId}-panel-${item}`
  const selectTab = (next: Tab): void => {
    if (next === tab) return
    setTab(next)
    if (isPanel && surface.current !== null) surface.current.scrollTop = 0
  }
  const moveTab = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const index = TABS.findIndex(item => item.id === tab)
    const last = TABS.length - 1
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = index === 0 ? last : index - 1; break
      case 'ArrowRight': next = index === last ? 0 : index + 1; break
      case 'Home': next = 0; break
      case 'End': next = last; break
      default: return
    }
    const item = TABS[next]
    if (item === undefined) return
    event.preventDefault()
    selectTab(item.id)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div ref={surface} className="mcb-surface" data-surface={isPanel ? 'panel' : 'embedded'} data-memory-cloud-settings="">
      <style>{STYLES}</style>
      <div className="mcb-frame">
        <header className="mcb-header">
          {isPanel ? <h2 className="mcb-heading">{t('settingsNav')}</h2> : null}
          <div className="mcb-toolbar">
            <div className="mcb-tabs" role="tablist" aria-label={t('tabsLabel')} onKeyDown={moveTab}>
              {TABS.map(item => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={tabId(item.id)}
                  aria-selected={tab === item.id}
                  aria-controls={panelId(item.id)}
                  data-tab={item.id}
                  tabIndex={tab === item.id ? 0 : -1}
                  className="mcb-tab"
                  onClick={() => { selectTab(item.id) }}
                >
                  {t(item.label)}
                </button>
              ))}
            </div>
            <button type="button" className="mcb-button mcb-refresh" title={t('refreshHint')} disabled={snapshot.refreshing || pending !== undefined} onClick={reload}>
              {snapshot.refreshing ? t('refreshing') : t('refresh')}
            </button>
          </div>
        </header>
        {failure === undefined ? null : (
          <p className="mcb-notice mcb-status-error" data-tone="error" role="status">{t('loadFailed', { code: failure.code, message: failure.message })}</p>
        )}
        <div className="mcb-panel" role="tabpanel" id={panelId('status')} aria-labelledby={tabId('status')} tabIndex={0} hidden={tab !== 'status'}>
          {status === undefined
            ? (failure === undefined ? <p className="mcb-hint" role="status">{t('loading')}</p> : null)
            : <StatusOverview status={status} language={language} t={t} />}
        </div>
        <div className="mcb-panel" role="tabpanel" id={panelId('compaction')} aria-labelledby={tabId('compaction')} tabIndex={0} hidden={tab !== 'compaction'}>
          <CompactionSettings snapshot={snapshot} t={t} setLevel={props.setLevel} setMode={props.setMode} takeover={props.takeover} restore={props.restore} />
        </div>
        <div className="mcb-panel" role="tabpanel" id={panelId('advanced')} aria-labelledby={tabId('advanced')} tabIndex={0} hidden={tab !== 'advanced'}>
          <AdvancedSettings
            t={t}
            useConfig={props.useConfig}
            loadConfig={props.loadConfig}
            saveConfig={props.saveConfig}
            level={status?.configured.level}
            budget={status?.agent?.budget}
            active={tab === 'advanced'}
          />
        </div>
      </div>
    </div>
  )
}
