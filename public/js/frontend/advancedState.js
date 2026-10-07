/**
 * Advanced Settings state that is derived from other settings.
 *
 * Two things live here, and neither ever hides or moves a control:
 *
 *  - Settings that mean nothing in the current state are dimmed and disabled,
 *    not removed: settings are revealed, never hidden as you
 *    change others. The page-number settings are off while Numbering Style is
 *    None; Watermark Colour and Strength is off while the watermark text is
 *    blank. A disabled control keeps its value, so it is saved, shared and
 *    restored as usual and comes back the moment it is enabled again.
 *
 *  - Party Labels is a choice of common pairs shown over the two real text
 *    boxes (config-partyLabel1 and config-partyLabel2, where empty means
 *    Applicant and Respondent). The select is only a view of the boxes:
 *    partyPairFor() reads them, and choosing a pair writes them.
 *
 * The functions above `setup` are pure so they can be tested without a page.
 */
import { unlikelyToPrint } from '../bundletoolGlyphs.js';
import { isWatermarkText } from './utils.js';

export const PARTY_PAIRS = [
  { key: 'default',    label1: '',           label2: '' },
  { key: 'claimant',   label1: 'Claimant',   label2: 'Defendant' },
  { key: 'petitioner', label1: 'Petitioner', label2: 'Respondent' },
  { key: 'appellant',  label1: 'Appellant',  label2: 'Respondent' },
];

/** Which entry of the Party Labels select the two boxes correspond to ('other' when none). */
export function partyPairFor(label1, label2) {
  const a = String(label1 ?? '').trim();
  const b = String(label2 ?? '').trim();
  // Empty means the built-in pair, and typing the built-in pair out is the same thing.
  if ((!a && !b) || (a === 'Applicant' && b === 'Respondent')) return 'default';
  const hit = PARTY_PAIRS.find((p) => p.label1 === a && p.label2 === b);
  return hit ? hit.key : 'other';
}

// Unlike Party Labels, blank is not the same thing as the default here: "CASE NO:" is the
// stored default, and a blank box is a real, different choice (no prefix at all), so blank
// is never folded into 'default' the way it is above.
export const CASE_NUMBER_LABELS = [
  { key: 'default',  label: 'CASE NO:' },
  { key: 'claim',    label: 'CLAIM NO:' },
  { key: 'order',    label: 'ORDER NO:' },
  { key: 'courtref', label: 'COURT REF:' },
];

/** Which entry of the Case Number Label select the text box corresponds to ('other' for anything else, including blank). */
export function caseNumberLabelPresetFor(label) {
  const v = String(label ?? '').trim();
  const hit = CASE_NUMBER_LABELS.find((p) => p.label === v);
  return hit ? hit.key : 'other';
}

// Same shape as CASE_NUMBER_LABELS just above: "Prepared by:"
// is the stored default, and blank is a real, different choice (no label), never folded into it.
export const PREPARED_BY_LABELS = [
  { key: 'default',  label: 'Prepared by:' },
  { key: 'compiled', label: 'Compiled by:' },
  { key: 'onbehalf', label: 'On behalf of:' },
];

/** Which entry of the Prepared By Label select the text box corresponds to ('other' for anything else, including blank). */
export function preparedByLabelPresetFor(label) {
  const v = String(label ?? '').trim();
  const hit = PREPARED_BY_LABELS.find((p) => p.label === v);
  return hit ? hit.key : 'other';
}

// Same shape as CASE_NUMBER_LABELS/PREPARED_BY_LABELS above:
// "-and-" is the stored default, and blank is a real, different choice (no joining word, just
// the gap between the two party stacks), never folded into it. "-v-" is the one supported alternative,
// researched against real UK court convention (see bundletoolCover.js): the
// formal BETWEEN heading is a civil and family convention, and "-and-" is its standard joiner,
// but "-v-" is a real substitute seen on civil and commercial bundle front sheets.
export const PARTY_JOINERS = [
  { key: 'default', label: '-and-' },
  { key: 'v',       label: '-v-' },
];

/** Which entry of the Party Joiner select the text box corresponds to ('other' for anything else, including blank). */
export function partyJoinerPresetFor(joiner) {
  const v = String(joiner ?? '').trim();
  const hit = PARTY_JOINERS.find((p) => p.label === v);
  return hit ? hit.key : 'other';
}

/** What the current settings leave usable. */
export function settingsAvailability({ numberingStyle, watermarkText, coverLayout, coverCaseLine } = {}) {
  return {
    // The case number's own alignment only applies when it has a line of its own.
    coverCaseAlign: coverCaseLine === 'own',
    // The two-column cover keeps applicants left and respondents right, so party alignment means nothing there.
    coverPartyAlign: coverLayout !== 'grid',
    pageNumbers: numberingStyle !== 'None',
    watermarkStrength: isWatermarkText(watermarkText),
  };
}

const CONTROLS = 'input:not([type="hidden"]), select, button';

function setCellsEnabled(selector, enabled, noteId) {
  document.querySelectorAll(selector).forEach((cell) => {
    cell.classList.toggle('bt-setting-off', !enabled);
    cell.querySelectorAll(CONTROLS).forEach((el) => {
      el.disabled = !enabled;
      if (!noteId) return;
      // Point a screen reader at the note while the control is off; keep whatever it pointed at before.
      const base = (el.dataset.describedbyBase ?? el.getAttribute('aria-describedby') ?? '');
      el.dataset.describedbyBase = base;
      const ids = [base, enabled ? '' : noteId].filter(Boolean).join(' ');
      if (ids) el.setAttribute('aria-describedby', ids);
      else el.removeAttribute('aria-describedby');
    });
  });
}

/** Says, under the watermark field, which typed characters a PDF font here cannot draw. */
export function refreshGlyphNote() {
  const note = document.getElementById('watermark-glyph-note');
  if (!note) return;
  const bad = unlikelyToPrint(document.getElementById('config-watermarkText')?.value ?? '');
  note.classList.toggle('hidden', bad.length === 0);
  note.textContent = bad.length
    ? `These characters cannot be printed and will show as "?": ${bad.join(' ')}. Latin, Greek and Cyrillic letters are fine.`
    : '';
}

export function refreshAvailability() {
  const a = settingsAvailability({
    numberingStyle: document.getElementById('config-numberingStyle')?.value,
    watermarkText: document.getElementById('config-watermarkText')?.value,
    coverLayout: document.getElementById('config-coverLayout')?.value,
    coverCaseLine: document.getElementById('config-coverCaseLine')?.value,
  });
  setCellsEnabled('[data-needs-numbering]', a.pageNumbers, 'page-numbering-off-note');
  const note = document.getElementById('page-numbering-off-note');
  // Hidden by visibility, not removed, so the line keeps its room and nothing below it shifts.
  if (note) note.classList.toggle('bt-panel-note--idle', a.pageNumbers);
  setCellsEnabled('[data-needs-watermark]', a.watermarkStrength, null);
  setCellsEnabled('[data-needs-stacked-cover]', a.coverPartyAlign, null);
  setCellsEnabled('[data-needs-own-case-line]', a.coverCaseAlign, null);
  refreshGlyphNote();
}

export function refreshPartyPair() {
  const select = document.getElementById('config-partyPair');
  const custom = document.getElementById('party-labels-custom');
  if (!select) return;
  const pair = partyPairFor(
    document.getElementById('config-partyLabel1')?.value,
    document.getElementById('config-partyLabel2')?.value,
  );
  select.value = pair;
  custom?.classList.toggle('hidden', pair !== 'other');
}

export function refreshCaseNumberLabel() {
  const select = document.getElementById('config-caseNumberLabelPreset');
  const custom = document.getElementById('case-number-label-custom');
  if (!select) return;
  const preset = caseNumberLabelPresetFor(document.getElementById('config-caseNumberLabel')?.value);
  select.value = preset;
  custom?.classList.toggle('hidden', preset !== 'other');
}

export function refreshPreparedByLabel() {
  const select = document.getElementById('config-preparedByLabelPreset');
  const custom = document.getElementById('prepared-by-label-custom');
  if (!select) return;
  const preset = preparedByLabelPresetFor(document.getElementById('config-preparedByLabel')?.value);
  select.value = preset;
  custom?.classList.toggle('hidden', preset !== 'other');
}

export function refreshPartyJoiner() {
  const select = document.getElementById('config-partyJoinerPreset');
  const custom = document.getElementById('party-joiner-custom');
  if (!select) return;
  const preset = partyJoinerPresetFor(document.getElementById('config-partyJoiner')?.value);
  select.value = preset;
  custom?.classList.toggle('hidden', preset !== 'other');
}

/** Brings every derived control into step with the settings; call after any value is set from code. */
export function refreshAdvancedState() {
  refreshPartyPair();
  refreshCaseNumberLabel();
  refreshPreparedByLabel();
  refreshPartyJoiner();
  refreshAvailability();
}

export function setup() {
  window.refreshAdvancedState = refreshAdvancedState;

  const host = document.getElementById('advanced-settings');
  host?.addEventListener('input', refreshAvailability);
  host?.addEventListener('change', refreshAvailability);

  const select = document.getElementById('config-partyPair');
  select?.addEventListener('change', () => {
    const custom = document.getElementById('party-labels-custom');
    const l1 = document.getElementById('config-partyLabel1');
    const l2 = document.getElementById('config-partyLabel2');
    const chosen = select.value;
    if (chosen === 'other') {
      // The boxes start from the pair that was showing, so it is an edit, not a blank slate.
      custom?.classList.remove('hidden');
      l1?.focus({ preventScroll: true });
      return;
    }
    const pair = PARTY_PAIRS.find((p) => p.key === chosen) || PARTY_PAIRS[0];
    if (l1) l1.value = pair.label1;
    if (l2) l2.value = pair.label2;
    custom?.classList.add('hidden');
    // The change event that brought us here bubbles on to the form and the settings panel, which
    // persist it; nothing more to fire.
  });

  const caseNumberLabelSelect = document.getElementById('config-caseNumberLabelPreset');
  caseNumberLabelSelect?.addEventListener('change', () => {
    const custom = document.getElementById('case-number-label-custom');
    const box = document.getElementById('config-caseNumberLabel');
    const chosen = caseNumberLabelSelect.value;
    if (chosen === 'other') {
      // Starts from whatever was showing, so it is an edit, not a blank slate, as with Party Labels.
      custom?.classList.remove('hidden');
      box?.focus({ preventScroll: true });
      return;
    }
    const preset = CASE_NUMBER_LABELS.find((p) => p.key === chosen) || CASE_NUMBER_LABELS[0];
    if (box) box.value = preset.label;
    custom?.classList.add('hidden');
    // The change event bubbles on to the form and the settings panel, which persist it.
  });

  const preparedByLabelSelect = document.getElementById('config-preparedByLabelPreset');
  preparedByLabelSelect?.addEventListener('change', () => {
    const custom = document.getElementById('prepared-by-label-custom');
    const box = document.getElementById('config-preparedByLabel');
    const chosen = preparedByLabelSelect.value;
    if (chosen === 'other') {
      custom?.classList.remove('hidden');
      box?.focus({ preventScroll: true });
      return;
    }
    const preset = PREPARED_BY_LABELS.find((p) => p.key === chosen) || PREPARED_BY_LABELS[0];
    if (box) box.value = preset.label;
    custom?.classList.add('hidden');
    // The change event bubbles on to the form and the settings panel, which persist it.
  });

  const partyJoinerSelect = document.getElementById('config-partyJoinerPreset');
  partyJoinerSelect?.addEventListener('change', () => {
    const custom = document.getElementById('party-joiner-custom');
    const box = document.getElementById('config-partyJoiner');
    const chosen = partyJoinerSelect.value;
    if (chosen === 'other') {
      custom?.classList.remove('hidden');
      box?.focus({ preventScroll: true });
      return;
    }
    const preset = PARTY_JOINERS.find((p) => p.key === chosen) || PARTY_JOINERS[0];
    if (box) box.value = preset.label;
    custom?.classList.add('hidden');
    // The change event bubbles on to the form and the settings panel, which persist it.
  });

  refreshAdvancedState();
}
