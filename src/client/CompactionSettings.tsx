import { useId } from 'react'
import type { ReactNode } from 'react'
import type { CompactionMode, CompressionLevel } from '../contracts.ts'
import type { StatusAction, StatusSnapshot } from './store.ts'
import { levelTable, modeOptions, noticeView, takeoverControls } from './view-model.ts'
import type { Translate } from './view-model.ts'

function Notice({ snapshot, actions, t }: {
  readonly snapshot: StatusSnapshot
  readonly actions: readonly StatusAction[]
  readonly t: Translate
}): ReactNode {
  const notice = snapshot.notice
  if (notice === undefined || !actions.includes(notice.action)) return null
  const view = noticeView(notice, t)
  return <p className="mcb-notice" data-tone={view.tone} role="status">{view.lines.join('\n')}</p>
}

export function CompactionSettings({ snapshot, t, setLevel, setMode, takeover, restore }: {
  readonly snapshot: StatusSnapshot
  readonly t: Translate
  readonly setLevel: (level: CompressionLevel) => void
  readonly setMode: (mode: CompactionMode) => void
  readonly takeover: () => void
  readonly restore: () => void
}): ReactNode {
  const id = useId()
  const { status, pending } = snapshot
  const locked = pending !== undefined || status === undefined
  const controls = status === undefined ? undefined : takeoverControls(status.takeover)
  const levels = levelTable(t)
  const selected = levels.find(row => row.level === status?.configured.level)
  return (
    <div className="mcb-compaction">
      <section className="mcb-section" data-section="mode">
        <h3 className="mcb-title" id={`${id}-mode`}>{t('modeTitle')}</h3>
        <div className="mcb-mode-list" role="radiogroup" aria-labelledby={`${id}-mode`} aria-describedby={`${id}-mode-hint`}>
          {modeOptions(t).map(option => {
            const optionId = `${id}-mode-${option.mode}`
            return (
              <label key={option.mode} className="mcb-mode-option">
                <input
                  type="radio"
                  name={`${id}-mode`}
                  value={option.mode}
                  aria-labelledby={optionId}
                  aria-describedby={`${optionId}-hint`}
                  checked={option.mode === status?.configured.compactionMode}
                  disabled={locked}
                  onChange={() => { setMode(option.mode) }}
                />
                <span className="mcb-choice-text">
                  <span className="mcb-choice-title" id={optionId}>{option.label}</span>
                  <span className="mcb-hint" id={`${optionId}-hint`}>{option.hint}</span>
                </span>
              </label>
            )
          })}
        </div>
        <p className="mcb-hint" id={`${id}-mode-hint`}>{t('modeSaveHint')}</p>
        <Notice snapshot={snapshot} actions={['mode']} t={t} />
      </section>

      <div className="mcb-compression-controls">
        <section className="mcb-section" data-section="level">
          <h3 className="mcb-title" id={`${id}-level`}>{t('levelTitle')}</h3>
          <div className="mcb-level-scale" role="radiogroup" aria-labelledby={`${id}-level`} aria-describedby={`${id}-level-hint`}>
            {levels.map(row => (
              <label key={row.level} className="mcb-level-option">
                <input
                  type="radio"
                  name={`${id}-level`}
                  value={row.level}
                  aria-label={t('levelValue', { level: row.level, title: row.title })}
                  checked={row.level === selected?.level}
                  disabled={locked}
                  onChange={() => { setLevel(row.level) }}
                />
                <span aria-hidden="true">{row.level}</span>
              </label>
            ))}
          </div>
          <div className="mcb-scale-labels"><span>{t('levelScaleKeep')}</span><span>{t('levelScaleCompact')}</span></div>
          {selected === undefined ? null : (
            <div className="mcb-level-detail">
              <p className="mcb-choice-title">{t('levelValue', { level: selected.level, title: selected.title })}</p>
              <p className="mcb-hint">{selected.detail}</p>
            </div>
          )}
          <p className="mcb-hint" id={`${id}-level-hint`}>{t('levelHint')}</p>
          <details className="mcb-disclosure">
            <summary>{t('levelCompare')}</summary>
            <dl className="mcb-level-comparison">
              {levels.map(row => (
                <div key={row.level}>
                  <dt>{t('levelValue', { level: row.level, title: row.title })}</dt>
                  <dd className="mcb-hint">{row.detail}</dd>
                </div>
              ))}
            </dl>
          </details>
          <Notice snapshot={snapshot} actions={['level']} t={t} />
        </section>

        <section className="mcb-section mcb-takeover" data-section="takeover">
          <h3 className="mcb-title">{t('takeoverTitle')}</h3>
          <p className="mcb-text">{t(controls === undefined ? 'takeoverAwaitStatus' : controls.kind === 'host' ? 'takeoverHostExplain' : 'takeoverExplain')}</p>
          <div className="mcb-actions">
            <button
              type="button"
              className="mcb-button"
              data-primary=""
              data-action="takeover"
              disabled={locked || controls?.canTakeOver !== true}
              onClick={takeover}
            >
              {pending === 'takeover' ? t('working') : t('takeoverAction')}
            </button>
            <button
              type="button"
              className="mcb-button"
              data-action="restore"
              disabled={locked || controls?.canRestore !== true}
              onClick={restore}
            >
              {pending === 'restore' ? t('restoring') : t('restoreAction')}
            </button>
          </div>
          <Notice snapshot={snapshot} actions={['takeover', 'restore']} t={t} />
        </section>
      </div>
    </div>
  )
}
