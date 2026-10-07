/**
 * The derived Advanced Settings state: which settings are switched off by others, and which
 * Party Labels choice the two label boxes correspond to. Both are pure functions so a wrong
 * rule cannot hide behind the page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partyPairFor, settingsAvailability, PARTY_PAIRS, caseNumberLabelPresetFor, CASE_NUMBER_LABELS, preparedByLabelPresetFor, PREPARED_BY_LABELS, partyJoinerPresetFor, PARTY_JOINERS } from '../public/js/frontend/advancedState.js';

test('page-number settings are off only while Numbering Style is None', () => {
  for (const style of ['PageX', 'PageXofY', 'X', 'XslashY', 'XofY']) {
    assert.equal(settingsAvailability({ numberingStyle: style, watermarkText: '' }).pageNumbers, true, style);
  }
  assert.equal(settingsAvailability({ numberingStyle: 'None', watermarkText: '' }).pageNumbers, false);
  // Nothing chosen yet is not "None": the settings must not start out dimmed.
  assert.equal(settingsAvailability({}).pageNumbers, true);
});

test('watermark colour and strength are off only while the watermark text is blank', () => {
  assert.equal(settingsAvailability({ watermarkText: '' }).watermarkStrength, false);
  assert.equal(settingsAvailability({ watermarkText: '   ' }).watermarkStrength, false);
  assert.equal(settingsAvailability({ watermarkText: 'CONFIDENTIAL' }).watermarkStrength, true);
});

test('empty or built-in labels are the default pair, and each preset maps back to itself', () => {
  assert.equal(partyPairFor('', ''), 'default');
  assert.equal(partyPairFor(undefined, undefined), 'default');
  assert.equal(partyPairFor('Applicant', 'Respondent'), 'default');
  for (const p of PARTY_PAIRS) {
    assert.equal(partyPairFor(p.label1, p.label2), p.key, p.key);
  }
  assert.equal(partyPairFor(' Claimant ', ' Defendant '), 'claimant');
});

test('any other labels show as Other, so an existing custom pair is never lost', () => {
  assert.equal(partyPairFor('Mother', 'Father'), 'other');
  assert.equal(partyPairFor('Claimant', 'Respondent'), 'other');
  assert.equal(partyPairFor('Applicant', ''), 'other');
});

test('Party Position is off under the two-column cover and on otherwise', () => {
  assert.equal(settingsAvailability({ coverLayout: 'grid' }).coverPartyAlign, false);
  assert.equal(settingsAvailability({ coverLayout: 'classic' }).coverPartyAlign, true);
  assert.equal(settingsAvailability({}).coverPartyAlign, true);
});

test('Case Number Position is off while the case number shares the court line', () => {
  assert.equal(settingsAvailability({ coverCaseLine: 'court' }).coverCaseAlign, false);
  assert.equal(settingsAvailability({ coverCaseLine: 'own' }).coverCaseAlign, true);
});

test('each preset maps back to itself, and the stored default "CASE NO:" is itself a preset, not a special case', () => {
  for (const p of CASE_NUMBER_LABELS) {
    assert.equal(caseNumberLabelPresetFor(p.label), p.key, p.key);
  }
  assert.equal(caseNumberLabelPresetFor(' CLAIM NO: '), 'claim', 'surrounding whitespace is trimmed');
});

test('blank is Other, not folded into the default the way it is for Party Labels: blank means no prefix, a real and different choice from "CASE NO:"', () => {
  assert.equal(caseNumberLabelPresetFor(''), 'other');
  assert.equal(caseNumberLabelPresetFor('   '), 'other');
  assert.equal(caseNumberLabelPresetFor(undefined), 'other');
});

test('any other wording shows as Other, so an existing custom label is never lost', () => {
  assert.equal(caseNumberLabelPresetFor('REF:'), 'other');
  assert.equal(caseNumberLabelPresetFor('Case no:'), 'other', 'case sensitive, not the same preset with different capitalisation');
});

test('Prepared By Label: each preset maps back to itself, and the stored default "Prepared by:" is itself a preset, not a special case', () => {
  for (const p of PREPARED_BY_LABELS) {
    assert.equal(preparedByLabelPresetFor(p.label), p.key, p.key);
  }
  assert.equal(preparedByLabelPresetFor(' Compiled by: '), 'compiled', 'surrounding whitespace is trimmed');
});

test('Prepared By Label: blank is Other, not folded into the default: blank means no label, a real and different choice from "Prepared by:"', () => {
  assert.equal(preparedByLabelPresetFor(''), 'other');
  assert.equal(preparedByLabelPresetFor('   '), 'other');
  assert.equal(preparedByLabelPresetFor(undefined), 'other');
});

test('Prepared By Label: any other wording shows as Other, so an existing custom label is never lost', () => {
  assert.equal(preparedByLabelPresetFor('Compiled for:'), 'other');
  assert.equal(preparedByLabelPresetFor('prepared by:'), 'other', 'case sensitive, not the same preset with different capitalisation');
});

test('Party Joiner: each preset maps back to itself, and the stored default "-and-" is itself a preset, not a special case', () => {
  for (const p of PARTY_JOINERS) {
    assert.equal(partyJoinerPresetFor(p.label), p.key, p.key);
  }
  assert.equal(partyJoinerPresetFor(' -v- '), 'v', 'surrounding whitespace is trimmed');
});

test('Party Joiner: blank is Other, not folded into the default: blank means no joining word, a real and different choice from "-and-"', () => {
  assert.equal(partyJoinerPresetFor(''), 'other');
  assert.equal(partyJoinerPresetFor('   '), 'other');
  assert.equal(partyJoinerPresetFor(undefined), 'other');
});

test('Party Joiner: any other wording shows as Other, so an existing custom joiner is never lost', () => {
  assert.equal(partyJoinerPresetFor('AND'), 'other');
  assert.equal(partyJoinerPresetFor('-V-'), 'other', 'case sensitive, not the same preset with different capitalisation');
});
