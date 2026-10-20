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
// "-&-" is the stored default, and blank is a real, different choice (no joining word, just
// the gap between the two party stacks), never folded into it. "-V-" is the one supported alternative,
// researched against real UK court convention (see bundletoolCover.js): the
// formal BETWEEN heading is a civil and family convention, and "-&-" is its standard joiner,
// but "-V-" is a real substitute seen on civil and commercial bundle front sheets.
// `legacy` is the wording these two presets had before, so a setting saved then still lands on its preset.
export const PARTY_JOINERS = [
  { key: 'default', label: '-&-', legacy: '-and-' },
  { key: 'v',       label: '-V-', legacy: '-v-' },
];

/** Which entry of the Party Joiner select the text box corresponds to ('other' for anything else, including blank). */
export function partyJoinerPresetFor(joiner) {
  const v = String(joiner ?? '').trim();
  const hit = PARTY_JOINERS.find((p) => p.label === v)
    || PARTY_JOINERS.find((p) => p.legacy === v);
  return hit ? hit.key : 'other';
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

// There is no "Other": each of these four settings is one of its presets and nothing else. The text boxes are hidden
// and driven by the select; a value that is not a preset (a custom one from an earlier session, a settings file or a
// share code) is put back to the default here, so what the select shows is always what the coversheet prints.
export function refreshPartyPair() {
  const select = document.getElementById('config-partyPair');
  if (!select) return;
  const l1 = document.getElementById('config-partyLabel1');
  const l2 = document.getElementById('config-partyLabel2');
  let pair = partyPairFor(l1?.value, l2?.value);
  if (pair === 'other') {
    pair = 'default';
    if (l1) l1.value = PARTY_PAIRS[0].label1;
    if (l2) l2.value = PARTY_PAIRS[0].label2;
  }
  select.value = pair;
}

export function refreshCaseNumberLabel() {
  const select = document.getElementById('config-caseNumberLabelPreset');
  if (!select) return;
  const box = document.getElementById('config-caseNumberLabel');
  let preset = caseNumberLabelPresetFor(box?.value);
  if (preset === 'other') {
    preset = 'default';
    if (box) box.value = CASE_NUMBER_LABELS[0].label;
  }
  select.value = preset;
}

export function refreshPreparedByLabel() {
  const select = document.getElementById('config-preparedByLabelPreset');
  if (!select) return;
  const box = document.getElementById('config-preparedByLabel');
  let preset = preparedByLabelPresetFor(box?.value);
  if (preset === 'other') {
    preset = 'default';
    if (box) box.value = PREPARED_BY_LABELS[0].label;
  }
  select.value = preset;
}

export function refreshPartyJoiner() {
  const select = document.getElementById('config-partyJoinerPreset');
  if (!select) return;
  const box = document.getElementById('config-partyJoiner');
  let preset = partyJoinerPresetFor(box?.value);
  if (preset === 'other') {
    preset = 'default';
    if (box) box.value = PARTY_JOINERS[0].label;
  } else if (box) {
    box.value = PARTY_JOINERS.find((p) => p.key === preset).label;
  }
  select.value = preset;
}

/** Brings every derived control into step with the settings; call after any value is set from code. */
export function refreshAdvancedState() {
  refreshPartyPair();
  refreshCaseNumberLabel();
  refreshPreparedByLabel();
  refreshPartyJoiner();
  refreshGlyphNote();
}

export function setup() {
  window.refreshAdvancedState = refreshAdvancedState;

  const host = document.getElementById('advanced-settings');
  host?.addEventListener('input', refreshGlyphNote);
  host?.addEventListener('change', refreshGlyphNote);

  const select = document.getElementById('config-partyPair');
  select?.addEventListener('change', () => {
    const l1 = document.getElementById('config-partyLabel1');
    const l2 = document.getElementById('config-partyLabel2');
    const pair = PARTY_PAIRS.find((p) => p.key === select.value) || PARTY_PAIRS[0];
    if (l1) l1.value = pair.label1;
    if (l2) l2.value = pair.label2;
    // The change event that brought us here bubbles on to the form and the settings panel, which
    // persist it; nothing more to fire.
  });

  const caseNumberLabelSelect = document.getElementById('config-caseNumberLabelPreset');
  caseNumberLabelSelect?.addEventListener('change', () => {
    const box = document.getElementById('config-caseNumberLabel');
    const preset = CASE_NUMBER_LABELS.find((p) => p.key === caseNumberLabelSelect.value) || CASE_NUMBER_LABELS[0];
    if (box) box.value = preset.label;
    // The change event bubbles on to the form and the settings panel, which persist it.
  });

  const preparedByLabelSelect = document.getElementById('config-preparedByLabelPreset');
  preparedByLabelSelect?.addEventListener('change', () => {
    const box = document.getElementById('config-preparedByLabel');
    const preset = PREPARED_BY_LABELS.find((p) => p.key === preparedByLabelSelect.value) || PREPARED_BY_LABELS[0];
    if (box) box.value = preset.label;
    // The change event bubbles on to the form and the settings panel, which persist it.
  });

  const partyJoinerSelect = document.getElementById('config-partyJoinerPreset');
  partyJoinerSelect?.addEventListener('change', () => {
    const box = document.getElementById('config-partyJoiner');
    const preset = PARTY_JOINERS.find((p) => p.key === partyJoinerSelect.value) || PARTY_JOINERS[0];
    if (box) box.value = preset.label;
    // The change event bubbles on to the form and the settings panel, which persist it.
  });

  refreshAdvancedState();
}
