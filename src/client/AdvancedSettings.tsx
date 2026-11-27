import { useEffect, useState } from 'react'
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

function Field({ label, hint, error, children }: {
  readonly label: string
  readonly hint?: string | undefined
  readonly error?: string | undefined
  readonly children: ReactNode
}): ReactNode {
  return (
    <label className="mcb-field">
      <span>{label}</span>
      {children}
      {error === undefined
        ? (hint === undefined ? null : <span className="mcb-hint">{hint}</span>)
        : <span className="mcb-field-error" role="alert">{error}</span>}
    </label>
  )
}

function TextInput({ value, placeholder, error, disabled, numeric, onChange }: {
  readonly value: string
  readonly placeholder?: string | undefined
  readonly error: string | undefined
  readonly disabled: boolean
  readonly numeric?: true
  readonly onChange: (value: string) => void
}): ReactNode {
  return (
    <input
      className="mcb-input"
      type="text"
      inputMode={numeric ? 'decimal' : undefined}
      spellCheck={false}
      autoComplete="off"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={error !== undefined}
      onChange={(event) => { onChange(event.target.value) }}
    />
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

/** Collapsible editor for every live setting besides level and mode; loads on first open. */
export function AdvancedSettings({ t, useConfig, loadConfig, saveConfig, level, budget }: AdvancedSettingsProps): ReactNode {
  const snapshot = useConfig(value => value)
  const [form, setForm] = useState<Form | undefined>(undefined)
  const view = snapshot.view

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
          <div className="mcb-fields">
            {SUMMARIZER_KEYS.map(({ field, label, placeholder, hint }) => (
              <Field key={field} label={t(label)} hint={t(hint)}>
                <TextInput
                  value={draft.summarizer[field]}
                  placeholder={t(placeholder)}
                  error={undefined}
                  disabled={locked}
                  onChange={(value) => { update(current => ({ ...current, summarizer: { ...current.summarizer, [field]: value } })) }}
                />
              </Field>
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
              >
                <TextInput
                  value={draft.numbers[field]}
                  error={errors[field]}
                  disabled={locked}
                  numeric
                  onChange={(value) => { update(current => ({ ...current, numbers: { ...current.numbers, [field]: value } })) }}
                />
              </Field>
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
          <div className="mcb-fields">
            {OVERRIDE_FIELDS.map(field => (
              <Field key={field} label={t(`override_${field}`)} error={errors[`overrides.${field}`]}>
                <TextInput
                  value={draft.overrides[field]}
                  placeholder={overridePlaceholder(field, level ?? form.base.level, t, budget === undefined ? undefined : { budget, overrides: form.base.overrides })}
                  error={errors[`overrides.${field}`]}
                  disabled={locked}
                  numeric
                  onChange={(value) => { update(current => ({ ...current, overrides: { ...current.overrides, [field]: value } })) }}
                />
              </Field>
            ))}
          </div>
        </fieldset>

        <fieldset className="mcb-group">
          <legend className="mcb-group-title">{t('advScopeTitle')}</legend>
          <p className="mcb-hint">{t('advScopeHint')}</p>
          <p className="mcb-text" data-scope-firewall="">{t('advScopeFirewall')}</p>
          {draft.scopeRules.length === 0
            ? <p className="mcb-hint">{t('advScopeEmpty')}</p>
            : (
                <ol className="mcb-rules">
                  {draft.scopeRules.map((rule, index) => (
                    <li key={rule.id} className="mcb-rule" aria-label={t('advScopeRule', { index: index + 1 })}>
                      <Field label={t('advScopeMatch')} error={errors[`scopeRules.${rule.id}.match`]}>
                        <TextInput
                          value={rule.match}
                          placeholder={t('advScopeMatchPlaceholder')}
                          error={errors[`scopeRules.${rule.id}.match`]}
                          disabled={locked}
                          onChange={(value) => { update(current => editRule(current, rule.id, 'match', value)) }}
                        />
                      </Field>
                      <Field label={t('advScopeScope')} error={errors[`scopeRules.${rule.id}.scope`]}>
                        <TextInput
                          value={rule.scope}
                          placeholder={t('advScopeScopePlaceholder')}
                          error={errors[`scopeRules.${rule.id}.scope`]}
                          disabled={locked}
                          onChange={(value) => { update(current => editRule(current, rule.id, 'scope', value)) }}
                        />
                      </Field>
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
          <fieldset className="mcb-group" data-setting="unmatchedSessions">
            <legend className="mcb-group-title">{t('advUnmatchedTitle')}</legend>
            <p className="mcb-hint">{t('advUnmatchedHint')}</p>
            {UNMATCHED_SESSIONS.map(value => (
              <label key={value} className="mcb-check">
                <input
                  type="radio"
                  name="mcb-unmatched-sessions"
                  value={value}
                  checked={draft.unmatchedSessions === value}
                  disabled={locked}
                  onChange={() => { update(current => ({ ...current, unmatchedSessions: value })) }}
                />
                {t(`advUnmatched_${value}`)}
              </label>
            ))}
          </fieldset>
        </fieldset>

        <div className="mcb-group">
          <div className="mcb-actions">
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
              data-action="defaults-config"
              disabled={locked}
              onClick={() => { setForm({ draft: draftOf(view.defaults), base: view.config }) }}
            >
              {t('advDefaults')}
            </button>
          </div>
          {invalid
            ? <p className="mcb-notice" data-tone="error" role="status">{t('advInvalid')}</p>
            : reading.changed ? <p className="mcb-notice" data-tone="warn" role="status">{t('advUnsaved')}</p> : null}
          {notice === undefined ? null : <p className="mcb-notice" data-tone={notice.tone} role="status">{notice.lines.join('\n')}</p>}
          <p className="mcb-hint">{t('advFooterHint')}</p>
        </div>
      </>
    )
  }

  return (
    <section className="mcb-section" data-section="advanced">
      <details
        className="mcb-advanced"
        onToggle={(event) => { if (event.currentTarget.open && snapshot.phase === 'idle') loadConfig() }}
      >
        <summary><h4 className="mcb-title">{t('advancedTitle')}</h4></summary>
        <div className="mcb-advanced-body">
          <p className="mcb-hint">{t('advancedHint')}</p>
          {snapshot.failure === undefined
            ? null
            : <p className="mcb-notice" data-tone="error" role="status">{t('advLoadFailed', { code: snapshot.failure.code, message: snapshot.failure.message })}</p>}
          {body()}
        </div>
      </details>
    </section>
  )
}
