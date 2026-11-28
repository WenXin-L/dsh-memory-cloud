/** Styles shared by the sidebar panel and its embedded views. Breakpoints use the content width. */
export const STYLES = `
.mcb-surface {
  min-inline-size: 0;
  color: var(--dsw-alias-label-primary);
  --mcb-divider: var(--dsw-alias-border-l2);
  --mcb-accent: var(--dsw-alias-state-business-primary);
  --mcb-fill: var(--dsw-alias-bg-module-platform);
}
.mcb-surface[data-surface='panel'] {
  box-sizing: border-box;
  flex: 1 1 0;
  inline-size: 100%;
  min-block-size: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  padding-inline: clamp(14px, 3vw, 36px);
  scroll-padding-block: 112px 110px;
}
.mcb-frame { container: mcb / inline-size; max-inline-size: 944px; margin-inline: auto; }
.mcb-surface[data-surface='panel'] .mcb-frame { padding-block-end: 28px; }
.mcb-surface[data-surface='panel'] .mcb-header { padding-block-start: 24px; background: var(--dsw-alias-bg-base); }
@media (min-height: 480px) {
  .mcb-surface[data-surface='panel'] .mcb-header { position: sticky; inset-block-start: 0; z-index: 2; }
}
.mcb-heading { margin: 0 0 12px; font-size: clamp(22px, 3.4cqi, 28px); line-height: 1.3; font-weight: 650; }
.mcb-toolbar { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 2px 12px; border-block-end: 1px solid var(--mcb-divider); }
.mcb-tabs { display: flex; flex-wrap: wrap; gap: 0 4px; min-inline-size: 0; }
.mcb-tab {
  min-block-size: 38px;
  padding: 0 12px;
  border: 0;
  border-block-end: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  font-weight: 550;
  white-space: nowrap;
  cursor: pointer;
}
.mcb-tab[aria-selected='true'] { border-block-end-color: var(--mcb-accent); color: var(--dsw-alias-label-primary); font-weight: 650; }
.mcb-panel { padding-block-start: 20px; min-inline-size: 0; }
.mcb-panel[hidden] { display: none; }
.mcb-section { display: flex; flex-direction: column; gap: 10px; min-inline-size: 0; }
.mcb-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 650; }
.mcb-text, .mcb-hint { margin: 0; max-inline-size: 76ch; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
.mcb-text { font-size: 13px; line-height: 20px; }
.mcb-hint { font-size: 12px; line-height: 18px; }
.mcb-notice { margin: 0; font-size: 13px; line-height: 19px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.mcb-status-error { margin-block-start: 14px; padding: 10px 12px; border-inline-start: 2px solid currentColor; background: var(--mcb-fill); }

/* Lead with the two decisions, then keep longer diagnostics in readable rows. */
.mcb-status { display: grid; gap: 24px; }
.mcb-facts { margin: 0; }
.mcb-fact { display: grid; min-inline-size: 0; gap: 3px; padding-block: 9px; border-block-end: 1px solid var(--mcb-divider); }
.mcb-fact:last-child { border-block-end: 0; }
.mcb-fact dt { font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.mcb-fact dd { display: flex; flex-direction: column; gap: 3px; min-inline-size: 0; margin: 0; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.mcb-line[data-muted] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.mcb-line[data-tone='warn'], .mcb-notice[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.mcb-line[data-tone='error'], .mcb-notice[data-tone='error'], .mcb-field-error { color: var(--dsw-alias-state-error-primary); }
.mcb-line[data-tone='success'], .mcb-notice[data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
.mcb-tag { align-self: flex-start; max-inline-size: 100%; box-sizing: border-box; border-radius: 4px; padding: 1px 6px; font-size: 12px; line-height: 18px; font-weight: 600; background: var(--mcb-fill); color: var(--dsw-alias-label-primary); }
.mcb-tag[data-tone='success'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); color: var(--dsw-alias-state-success-primary); }
.mcb-tag[data-tone='info'] { background: color-mix(in srgb, var(--mcb-accent) 10%, transparent); color: var(--mcb-accent); }
.mcb-overview, .mcb-status-details, .mcb-compaction { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 20px 28px; }
.mcb-overview { align-items: stretch; gap: 10px 14px; }
.mcb-overview .mcb-fact { align-content: start; gap: 8px; padding: 13px 16px; border-radius: 9px; border: 1px solid var(--mcb-divider); background: var(--mcb-fill); }
.mcb-overview .mcb-fact dd { gap: 6px; }
.mcb-overview .mcb-fact[data-fact='level'] dd > :first-child { font-size: 15px; font-weight: 650; }
.mcb-overview .mcb-tag { font-size: 14px; line-height: 21px; padding: 1px 7px; }
.mcb-detail-group { min-inline-size: 0; }
.mcb-detail-group > .mcb-title { padding-block-end: 7px; border-block-end: 1px solid var(--mcb-divider); }

/* Compact choices, with a comparison available without changing live settings. */
.mcb-mode-list { display: grid; gap: 2px; }
.mcb-mode-option { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 10px; padding: 9px 10px; border-radius: 6px; cursor: pointer; }
.mcb-mode-option:has(:checked) { background: color-mix(in srgb, var(--mcb-accent) 9%, transparent); }
.mcb-choice-text { display: grid; gap: 2px; }
.mcb-choice-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 650; overflow-wrap: anywhere; }
.mcb-surface input:is([type='radio'], [type='checkbox']) { flex: none; margin: 3px 0 0; accent-color: var(--mcb-accent); }
.mcb-mode-option:has(:disabled), .mcb-level-option:has(:disabled), .mcb-check:has(:disabled) { cursor: not-allowed; opacity: .65; }
.mcb-compression-controls { display: grid; min-inline-size: 0; gap: 20px; }
.mcb-level-scale { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; }
.mcb-level-option { position: relative; min-inline-size: 0; cursor: pointer; }
.mcb-level-option input { position: absolute; inline-size: 1px; block-size: 1px; opacity: 0; }
.mcb-level-option > span { display: grid; place-items: center; min-block-size: 34px; border: 1px solid var(--mcb-divider); border-radius: 6px; font-size: 14px; line-height: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.mcb-level-option input:checked + span { border-color: var(--mcb-accent); background: color-mix(in srgb, var(--mcb-accent) 11%, transparent); color: var(--mcb-accent); }
.mcb-scale-labels { display: flex; justify-content: space-between; gap: 8px; margin-block-start: -4px; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.mcb-scale-labels > :last-child { text-align: end; }
.mcb-level-detail { display: grid; gap: 4px; padding: 10px 12px; border-radius: 6px; background: var(--mcb-fill); }
.mcb-disclosure { min-inline-size: 0; font-size: 13px; line-height: 20px; }
.mcb-disclosure > summary { width: fit-content; max-inline-size: 100%; color: var(--mcb-accent); cursor: pointer; }
.mcb-disclosure > :not(summary) { margin-block: 6px 0; }
.mcb-level-comparison { display: grid; gap: 5px; }
.mcb-level-comparison > div { padding-block-start: 5px; border-block-start: 1px solid var(--mcb-divider); }
.mcb-level-comparison dt { font-weight: 550; }
.mcb-level-comparison dd { margin: 0; }
.mcb-takeover { padding-block-start: 16px; border-block-start: 1px solid var(--mcb-divider); }

.mcb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; min-inline-size: 0; }
.mcb-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-block-size: 32px;
  max-inline-size: 100%;
  padding: 4px 11px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 19px;
  text-align: center;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.mcb-button[data-primary] { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.mcb-button[data-quiet] { border-color: transparent; }
.mcb-button:disabled { cursor: not-allowed; opacity: .5; }
.mcb-refresh { margin-block-end: 5px; margin-inline-start: auto; }
.mcb-tab:focus-visible, .mcb-button:focus-visible, .mcb-panel:focus-visible, .mcb-disclosure > summary:focus-visible, .mcb-level-option input:focus-visible + span {
  outline: 2px solid var(--mcb-accent);
  outline-offset: 2px;
}

/* Keep form text, narrow numeric inputs, and rule actions on predictable tracks. */
.mcb-advanced { display: flex; flex-direction: column; gap: 22px; min-inline-size: 0; }
.mcb-group, .mcb-unmatched { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; border: 0; min-inline-size: 0; }
.mcb-group + .mcb-group { padding-block-start: 10px; border-block-start: 1px solid var(--mcb-divider); }
.mcb-group-title { padding: 0; margin-block-end: 9px; font-size: 15px; line-height: 21px; font-weight: 650; }
.mcb-group + .mcb-group > .mcb-group-title { padding-inline-end: 10px; margin-block-end: 0; }
.mcb-unmatched { padding-block-start: 6px; }
.mcb-unmatched .mcb-group-title { font-size: 13px; margin-block-end: 0; }
.mcb-unmatched-options { display: grid; gap: 8px; }
.mcb-fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px 18px; }
.mcb-field { display: flex; flex-direction: column; gap: 5px; min-inline-size: 0; font-size: 13px; line-height: 18px; }
.mcb-field > label { font-weight: 550; }
.mcb-field-error { font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.mcb-check { display: flex; align-items: start; gap: 8px; font-size: 13px; line-height: 20px; cursor: pointer; overflow-wrap: anywhere; }
.mcb-input { box-sizing: border-box; inline-size: 100%; min-inline-size: 0; block-size: 34px; padding-inline: 9px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; background: var(--dsw-alias-bg-base); color: inherit; font: inherit; }
.mcb-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: .9; }
.mcb-input:focus-visible { outline: 2px solid var(--mcb-accent); outline-offset: -1px; }
.mcb-input[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }
.mcb-input:disabled { opacity: .65; }
.mcb-rules { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.mcb-rule { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 8px 10px; padding: 10px 12px; border-radius: 7px; background: var(--mcb-fill); }
.mcb-rule-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.mcb-rule-actions .mcb-button { min-inline-size: 30px; padding-inline: 6px; }
.mcb-savebar { display: grid; gap: 7px; min-inline-size: 0; padding-block: 10px 8px; border-block-start: 1px solid var(--mcb-divider); background: var(--dsw-alias-bg-base); }
.mcb-savebar-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 7px 12px; }
.mcb-savebar-row .mcb-actions { margin-inline-start: auto; }

@container mcb (max-width: 380px) {
  .mcb-toolbar { column-gap: 6px; }
  .mcb-tabs { column-gap: 2px; }
  .mcb-tab { padding-inline: 6px; }
  .mcb-refresh { padding-inline: 7px; }
}
@container mcb (min-width: 520px) {
  .mcb-overview, .mcb-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mcb-rule { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; }
  .mcb-rule-actions { padding-block-start: 23px; }
}
@container mcb (min-width: 700px) {
  .mcb-status-details, .mcb-compaction { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mcb-fields:is([data-fields='summary'], [data-fields='budget']) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  @media (min-height: 560px) {
    .mcb-surface[data-surface='panel'] .mcb-savebar[data-dirty] { position: sticky; inset-block-end: 0; z-index: 1; }
  }
}
@media (hover: hover) {
  .mcb-button:hover:not(:disabled), .mcb-tab:hover:not([aria-selected='true']), .mcb-mode-option:hover:not(:has(:disabled, :checked)) { background: var(--dsw-alias-interactive-bg-hover); }
  .mcb-button[data-primary]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
  .mcb-level-option:hover input:not(:checked, :disabled) + span { background: var(--dsw-alias-interactive-bg-hover); }
}
`
