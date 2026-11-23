import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { CompactionMode, CompressionLevel } from '../contracts.ts'
import { AdvancedSettings } from './AdvancedSettings.tsx'
import type { ConfigSnapshot } from './config-store.ts'
import type { ConfigPatch } from './contract.ts'
import type { LocaleSnapshot } from './host.ts'
import type { StatusAction, StatusSnapshot } from './store.ts'
import { STYLES } from './styles.ts'
import { languageOf, levelTable, modeOptions, noticeView, statusFacts, takeoverControls } from './view-model.ts'
import type { Fact, Translate } from './view-model.ts'

/** Props of the `plugins.bundle.config` entry: owner `view`, the locale `t` seat, bound hooks, and store actions. */
export interface MemoryCloudPageProps {
  readonly view: 'summary' | 'page'
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

function FactList({ facts }: { readonly facts: readonly Fact[] }): ReactNode {
  return (
    <dl className="mcb-facts">
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

function Notice({ snapshot, actions, t }: { readonly snapshot: StatusSnapshot; readonly actions: readonly StatusAction[]; readonly t: Translate }): ReactNode {
  const notice = snapshot.notice
  if (notice === undefined || !actions.includes(notice.action)) return null
  const view = noticeView(notice, t)
  return <p className="mcb-notice" data-tone={view.tone} role="status">{view.lines.join('\n')}</p>
}

function Option({ checked, disabled, title, detail, current, onSelect }: {
  readonly checked: boolean
  readonly disabled: boolean
  readonly title: string
  readonly detail: string
  readonly current: string
  readonly onSelect: () => void
}): ReactNode {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className="mcb-option"
      disabled={disabled}
      onClick={() => { if (!checked) onSelect() }}
    >
      <span className="mcb-option-head">
        {title}
        {checked ? <span className="mcb-option-current">{current}</span> : null}
      </span>
      <span className="mcb-option-detail">{detail}</span>
    </button>
  )
}

/** The bundle's page on the Plugins page: status, level and mode controls, the compaction takeover, and the advanced settings. */
export function MemoryCloudPage(props: MemoryCloudPageProps): ReactNode {
  const { t, reload } = props
  const snapshot = props.useStatus(value => value)
  const language = languageOf(props.useLocale(value => value.active))
  useEffect(() => { reload() }, [reload])
  if (props.view !== 'page') return null

  const { status, pending, failure } = snapshot
  const locked = pending !== undefined || status === undefined
  const controls = status === undefined ? undefined : takeoverControls(status.takeover)
  return (
    <div className="mcb-page" data-memory-cloud-settings="">
      <style>{STYLES}</style>
      <section className="mcb-section" data-section="status">
        <div className="mcb-head">
          <h4 className="mcb-title">{t('statusTitle')}</h4>
          <button type="button" className="mcb-button" disabled={snapshot.refreshing || pending !== undefined} onClick={reload}>
            {snapshot.refreshing ? t('refreshing') : t('refresh')}
          </button>
        </div>
        {failure === undefined ? null : <p className="mcb-notice" data-tone="error" role="status">{t('loadFailed', { code: failure.code, message: failure.message })}</p>}
        {status === undefined
          ? (failure === undefined ? <p className="mcb-hint">{t('loading')}</p> : null)
          : <FactList facts={statusFacts(status, t, language)} />}
      </section>

      <section className="mcb-section" data-section="level">
        <h4 className="mcb-title">{t('levelTitle')}</h4>
        <div className="mcb-options" role="radiogroup" aria-label={t('levelTitle')}>
          {levelTable(t).map(row => (
            <Option
              key={row.level}
              checked={row.level === status?.configured.level}
              disabled={locked}
              title={t('levelValue', { level: row.level, title: row.title })}
              detail={row.detail}
              current={t('current')}
              onSelect={() => { props.setLevel(row.level) }}
            />
          ))}
        </div>
        <p className="mcb-hint">{t('levelHint')}</p>
        <Notice snapshot={snapshot} actions={['level']} t={t} />
      </section>

      <section className="mcb-section" data-section="mode">
        <h4 className="mcb-title">{t('modeTitle')}</h4>
        <div className="mcb-options" role="radiogroup" aria-label={t('modeTitle')}>
          {modeOptions(t).map(option => (
            <Option
              key={option.mode}
              checked={option.mode === status?.configured.compactionMode}
              disabled={locked}
              title={`${option.label} · ${option.mode}`}
              detail={option.hint}
              current={t('current')}
              onSelect={() => { props.setMode(option.mode) }}
            />
          ))}
        </div>
        <Notice snapshot={snapshot} actions={['mode']} t={t} />
      </section>

      <section className="mcb-section" data-section="takeover">
        <h4 className="mcb-title">{t('takeoverTitle')}</h4>
        <p className="mcb-text">{t(controls?.kind === 'host' ? 'takeoverHostExplain' : 'takeoverExplain')}</p>
        <div className="mcb-actions">
          <button
            type="button"
            className="mcb-button"
            data-primary=""
            data-action="takeover"
            disabled={locked || controls?.canTakeOver !== true}
            onClick={props.takeover}
          >
            {pending === 'takeover' ? t('working') : t('takeoverAction')}
          </button>
          <button
            type="button"
            className="mcb-button"
            data-action="restore"
            disabled={locked || controls?.canRestore !== true}
            onClick={props.restore}
          >
            {pending === 'restore' ? t('working') : t('restoreAction')}
          </button>
        </div>
        <Notice snapshot={snapshot} actions={['takeover', 'restore']} t={t} />
      </section>

      <AdvancedSettings
        t={t}
        useConfig={props.useConfig}
        loadConfig={props.loadConfig}
        saveConfig={props.saveConfig}
        level={status?.configured.level}
        budget={status?.agent?.budget}
      />
    </div>
  )
}
