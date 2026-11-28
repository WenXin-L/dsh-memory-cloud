import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { CompressionLevel, ResolvedBudget } from '../contracts.ts'
import { UNMATCHED_SESSIONS } from '../scope/guard.ts'
import {
  addRule, configNoticeView, draftOf, editRule, moveRule, NUMBER_LIMITS, overridePlaceholder, readDraft, readNumber, rebaseDraft, removeRule,
} from './advanced-model.ts'
import type { ConfigDraft } from './advanced-model.ts'
import type { ConfigSnapshot } from './config-store.ts'
import type { ConfigPatch, NumberField, SummarizerField, VolatileConfig } from './contract.ts'
import { NUMBER_FIELDS, OVERRIDE_FIELDS } from './contract.ts'
import type { MemoryCloudKey } from './locales.ts'
import { formatPercent } from './view-model.ts'
import type { Translate } from './view-model.ts'

export interface AdvancedSettingsProps {
  readonly t: Translate
  readonly useConfig: <S>(selector: (snapshot: ConfigSnapshot) => S) => S
  readonly loadConfig: () => void
  readonly saveConfig: (patch: ConfigPatch) => void
  /** Configured level from the status, for override placeholders. */
  readonly level: CompressionLevel | undefined
  /** Resolved budget of the live session in the status, for override placeholders. */
  readonly budget: ResolvedBudget | undefined
  /** Load on the first visit. Keep the draft mounted when another tab is active. */
  readonly active: boolean
}

interface Form {
  readonly draft: ConfigDraft
  /** The live settings the draft is compared with. */
  readonly base: VolatileConfig
}

const NUMBER_KEYS: Readonly<Record<NumberField, { readonly label: MemoryCloudKey; readonly hint: MemoryCloudKey }>> = {
  idleMinutes: { label: 'advIdleMinutes', hint: 'advIdleMinutesHint' },
  idleCompactRatio: { label: 'advIdleCompactRatio', hint: 'advIdleCompactRatioHint' },
  halfLifeDays: { label: 'advHalfLifeDays', hint: 'advHalfLifeDaysHint' },
  maxEpisodeTokens: { label: 'advMaxEpisodeTokens', hint: 'advMaxEpisodeTokensHint' },
}

const SUMMARIZER_KEYS: readonly { readonly field: SummarizerField; readonly label: MemoryCloudKey; readonly placeholder: MemoryCloudKey; readonly hint: MemoryCloudKey }[] = [
  { field: 'provider', label: 'advProvider', placeholder: 'advProviderPlaceholder', hint: 'advProviderHint' },
  { field: 'model', label: 'advModel', placeholder: 'advModelPlaceholder', hint: 'advModelHint' },
  { field: 'reasoningEffort', label: 'advEffort', placeholder: 'advEffortPlaceholder', hint: 'advEffortHint' },
]

function Field({ label, hint, error, value, placeholder, disabled, numeric, onChange }: {
  readonly label: string
  readonly hint?: string | undefined
  readonly error?: string | undefined
  readonly value: string
  readonly placeholder?: string | undefined
  readonly disabled: boolean
  readonly numeric?: true
  readonly onChange: (value: string) => void
}): ReactNode {
  const id = useId()
  const description = error ?? hint
  return (
    <div className="mcb-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="mcb-input"
        type="text"
        inputMode={numeric ? 'decimal' : undefined}
        spellCheck={false}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={description === undefined ? undefined : `${id}-description`}
        onChange={(event) => { onChange(event.target.value) }}
      />
      {description === undefined ? null : (
        <span id={`${id}-description`} className={error === undefined ? 'mcb-hint' : 'mcb-field-error'}>{description}</span>
      )}
    </div>
  )
}

function RuleButton({ t, index, action, disabled, onClick, children }: {
  readonly t: Translate
  readonly index: number
  readonly action: 'advScopeUp' | 'advScopeDown' | 'advScopeRemove'
  readonly disabled: boolean
  readonly onClick: () => void
  readonly children: string
}): ReactNode {
  const label = t('advRuleAction', { rule: t('advScopeRule', { index }), action: t(action) })
  return <button type="button" className="mcb-button" title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>
}

export function AdvancedSettings({ t, useConfig, loadConfig, saveConfig, level, budget, active }: AdvancedSettingsProps): ReactNode {
  const snapshot = useConfig(value => value)
  const [form, setForm] = useState<Form | undefined>(undefined)
  const unmatchedId = useId()
  const view = snapshot.view

  useEffect(() => { if (active && snapshot.phase === 'idle') loadConfig() }, [active, snapshot.phase, loadConfig])

  useEffect(() => {
    if (view === undefined) return
    setForm(current => current === undefined
      ? { draft: draftOf(view.config), base: view.config }
      : { draft: rebaseDraft(current.draft, current.base, view.config), base: view.config })
  }, [view])

  const update = (change: (draft: ConfigDraft) => ConfigDraft): void => {
    setForm(current => current === undefined ? current : { ...current, draft: change(current.draft) })
  }

  const body = (): ReactNode => {
    if (form === undefined || view === undefined) {
      if (snapshot.phase === 'error') {
        return (
          <div className="mcb-actions">
            <button type="button" className="mcb-button" onClick={loadConfig}>{t('advRetry')}</button>
          </div>
        )
      }
      return <p className="mcb-hint" role="status">{t('advLoading')}</p>
    }
    const { draft } = form
    const reading = readDraft(draft, form.base, t)
    const { errors } = reading
    const invalid = Object.keys(errors).length > 0
    const locked = snapshot.saving
    const ratio = readNumber(draft.numbers.idleCompactRatio, NUMBER_LIMITS.idleCompactRatio, t)
    const notice = snapshot.notice === undefined ? undefined : configNoticeView(snapshot.notice, t)
    return (
      <>
        <fieldset className="mcb-group">
          <legend className="mcb-group-title">{t('advSummarizerTitle')}</legend>
          <div className="mcb-fields" data-fields="summary">
            {SUMMARIZER_KEYS.map(({ field, label, placeholder, hint }) => (
              <Field
                key={field}
                label={t(label)}
                hint={t(hint)}
                value={draft.summarizer[field]}
                placeholder={t(placeholder)}
                disabled={locked}
                onChange={(value) => { update(current => ({ ...current, summarizer: { ...current.summarizer, [field]: value } })) }}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="mcb-group">
          <legend className="mcb-group-title">{t('advCaptureTitle')}</legend>
          <div className="mcb-fields">
            {NUMBER_FIELDS.map(field => (
              <Field
                key={field}
                label={t(NUMBER_KEYS[field].label)}
                hint={t(NUMBER_KEYS[field].hint, { percent: 'value' in ratio ? formatPercent(ratio.value) : '—' })}
                error={errors[field]}
                value={draft.numbers[field]}
                disabled={locked}
                numeric
                onChange={(value) => { update(current => ({ ...current, numbers: { ...current.numbers, [field]: value } })) }}
              />
            ))}
          </div>
          <label className="mcb-check">
            <input
              type="checkbox"
              checked={draft.captureReasoning}
              disabled={locked}
              onChange={(event) => {
                const checked = event.target.checked
                update(current => ({ ...current, captureReasoning: checked }))
              }}
            />
            {t('advCaptureReasoning')}
          </label>
        </fieldset>

        <fieldset className="mcb-group">
          <legend className="mcb-group-title">{t('advOverridesTitle')}</legend>
          <p className="mcb-hint">{t('advOverridesHint')}</p>
          <div className="mcb-fields" data-fields="budget">
            {OVERRIDE_FIELDS.map(field => (
              <Field
                key={field}
                label={t(`override_${field}`)}
                value={draft.overrides[field]}
                placeholder={overridePlaceholder(field, level ?? form.base.level, t, budget === undefined ? undefined : { budget, overrides: form.base.overrides })}
                error={errors[`overrides.${field}`]}
                disabled={locked}
                numeric
                onChange={(value) => { update(current => ({ ...current, overrides: { ...current.overrides, [field]: value } })) }}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="mcb-group">
          <legend className="mcb-group-title">{t('advScopeTitle')}</legend>
          <p className="mcb-text" data-scope-firewall="">{t('advScopeFirewall')}</p>
          <details className="mcb-disclosure">
            <summary>{t('advScopeSyntax')}</summary>
            <p className="mcb-hint">{t('advScopeHint')}</p>
          </details>
          {draft.scopeRules.length === 0
            ? <p className="mcb-hint">{t('advScopeEmpty')}</p>
            : (
                <ol className="mcb-rules">
                  {draft.scopeRules.map((rule, index) => (
                    <li key={rule.id} className="mcb-rule" aria-label={t('advScopeRule', { index: index + 1 })}>
                      <Field
                        label={t('advScopeMatch')}
                        value={rule.match}
                        placeholder={t('advScopeMatchPlaceholder')}
                        error={errors[`scopeRules.${rule.id}.match`]}
                        disabled={locked}
                        onChange={(value) => { update(current => editRule(current, rule.id, 'match', value)) }}
                      />
                      <Field
                        label={t('advScopeScope')}
                        value={rule.scope}
                        placeholder={t('advScopeScopePlaceholder')}
                        error={errors[`scopeRules.${rule.id}.scope`]}
                        disabled={locked}
                        onChange={(value) => { update(current => editRule(current, rule.id, 'scope', value)) }}
                      />
                      <div className="mcb-rule-actions">
                        <RuleButton t={t} index={index + 1} action="advScopeUp" disabled={locked || index === 0} onClick={() => { update(current => moveRule(current, rule.id, -1)) }}>↑</RuleButton>
                        <RuleButton t={t} index={index + 1} action="advScopeDown" disabled={locked || index === draft.scopeRules.length - 1} onClick={() => { update(current => moveRule(current, rule.id, 1)) }}>↓</RuleButton>
                        <RuleButton t={t} index={index + 1} action="advScopeRemove" disabled={locked} onClick={() => { update(current => removeRule(current, rule.id)) }}>×</RuleButton>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
          <div className="mcb-actions">
            <button type="button" className="mcb-button" data-action="add-rule" disabled={locked} onClick={() => { update(addRule) }}>{t('advScopeAdd')}</button>
          </div>
          <fieldset className="mcb-unmatched" data-setting="unmatchedSessions" aria-describedby={`${unmatchedId}-hint`}>
            <legend className="mcb-group-title">{t('advUnmatchedTitle')}</legend>
            <div className="mcb-unmatched-options">
              {UNMATCHED_SESSIONS.map(value => (
                <label key={value} className="mcb-check">
                  <input
                    type="radio"
                    name={`${unmatchedId}-sessions`}
                    value={value}
                    checked={draft.unmatchedSessions === value}
                    disabled={locked}
                    onChange={() => { update(current => ({ ...current, unmatchedSessions: value })) }}
                  />
                  {t(`advUnmatched_${value}`)}
                </label>
              ))}
            </div>
            <p className="mcb-hint" id={`${unmatchedId}-hint`}>{t('advUnmatchedHint')}</p>
          </fieldset>
        </fieldset>

        <footer className="mcb-savebar" data-dirty={reading.changed ? '' : undefined}>
          <div className="mcb-savebar-row">
            {invalid
              ? <p className="mcb-notice" data-tone="error" role="status">{t('advInvalid')}</p>
              : reading.changed ? <p className="mcb-notice" data-tone="warn" role="status">{t('advUnsaved')}</p> : null}
            <div className="mcb-actions">
              <button
                type="button"
                className="mcb-button"
                data-quiet=""
                data-action="defaults-config"
                disabled={locked}
                onClick={() => { setForm({ draft: draftOf(view.defaults), base: view.config }) }}
              >
                {t('advDefaults')}
              </button>
              <button
                type="button"
                className="mcb-button"
                data-action="discard-config"
                title={t('advDiscardHint')}
                disabled={locked || !reading.changed}
                onClick={() => { setForm({ draft: draftOf(view.config), base: view.config }) }}
              >
                {t('advDiscard')}
              </button>
              <button
                type="button"
                className="mcb-button"
                data-primary=""
                data-action="save-config"
                disabled={locked || invalid || !reading.changed}
                onClick={() => { saveConfig(reading.patch) }}
              >
                {locked ? t('advSaving') : t('advSave')}
              </button>
            </div>
          </div>
          {notice === undefined ? null : <p className="mcb-notice" data-tone={notice.tone} role="status">{notice.lines.join('\n')}</p>}
          <p className="mcb-hint">{t('advFooterHint')}</p>
        </footer>
      </>
    )
  }

  return (
    <section className="mcb-advanced" data-section="advanced" aria-label={t('advancedTitle')}>
      <p className="mcb-text">{t('advancedHint')}</p>
      {snapshot.failure === undefined ? null : (
        <p className="mcb-notice" data-tone="error" role="status">{t('advLoadFailed', { code: snapshot.failure.code, message: snapshot.failure.message })}</p>
      )}
      {body()}
    </section>
  )
}
