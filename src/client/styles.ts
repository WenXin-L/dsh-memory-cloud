/** Page-local styles, rendered as a `<style>` element so unmounting removes them. Only `--dsw-alias-*` tokens. */
export const STYLES = `
.mcb-page { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.mcb-section { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.mcb-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mcb-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.mcb-text { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.mcb-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.mcb-facts { margin: 0; }
.mcb-fact { display: flex; gap: 16px; padding: 10px 2px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.mcb-fact:last-child { border-bottom: 0; }
.mcb-fact dt { flex: none; width: 128px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.mcb-fact dd { display: flex; flex-direction: column; gap: 2px; min-width: 0; margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.mcb-line[data-muted] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.mcb-line[data-tone='warn'], .mcb-notice[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.mcb-line[data-tone='error'], .mcb-notice[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.mcb-line[data-tone='success'], .mcb-notice[data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
.mcb-notice { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.mcb-tag { align-self: flex-start; display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.mcb-tag[data-tone='success'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }
.mcb-tag[data-tone='info'] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); color: var(--dsw-alias-state-business-primary); }
.mcb-options { display: flex; flex-direction: column; gap: 6px; }
.mcb-option { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }
.mcb-option[aria-checked='true'] { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent); }
.mcb-option:disabled { cursor: not-allowed; opacity: 0.6; }
.mcb-option:focus-visible, .mcb-button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.mcb-option-head { display: flex; align-items: baseline; gap: 8px; font-size: 13px; line-height: 20px; font-weight: 500; }
.mcb-option-current { font-size: 11px; line-height: 17px; font-weight: 500; color: var(--dsw-alias-state-business-primary); }
.mcb-option-detail { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.mcb-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.mcb-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 12px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3); }
.mcb-button[data-primary] { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); box-shadow: none; }
.mcb-button:disabled { cursor: not-allowed; opacity: 0.4; }
.mcb-advanced { min-width: 0; }
.mcb-advanced > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; }
.mcb-advanced > summary::-webkit-details-marker { display: none; }
.mcb-advanced > summary::before { content: ''; flex: none; width: 6px; height: 6px; border-right: 1.5px solid var(--dsw-alias-label-secondary); border-bottom: 1.5px solid var(--dsw-alias-label-secondary); transform: rotate(-45deg); transition: transform 0.15s; }
.mcb-advanced[open] > summary::before { transform: rotate(45deg); }
.mcb-advanced > summary:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; border-radius: 4px; }
.mcb-advanced-body { display: flex; flex-direction: column; gap: 20px; margin-top: 12px; }
.mcb-group { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; border: 0; min-width: 0; }
.mcb-group-title { margin: 0; padding: 0; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.mcb-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px 16px; }
.mcb-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.mcb-field-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.mcb-check { display: flex; align-items: center; gap: 8px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.mcb-input { box-sizing: border-box; width: 100%; height: 28px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3); }
.mcb-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.mcb-input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 0; }
.mcb-input[aria-invalid='true'] { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-error-primary); }
.mcb-input:disabled { opacity: 0.6; }
.mcb-rules { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.mcb-rule { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: start; gap: 8px; }
.mcb-rule-actions { display: flex; gap: 4px; padding-top: 22px; }
.mcb-rule-actions .mcb-button { padding: 0 8px; }
@media (hover: hover) {
  .mcb-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
  .mcb-button[data-primary]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
  .mcb-option:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}
`
