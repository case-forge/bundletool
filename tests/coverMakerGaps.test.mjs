/**
 * Three things the cover maker does: concrete placeholders, the Applicant pre-filled from
 * Parties, and a draft kept when the maker is closed unsaved. The actual behaviour needs a real
 * browser; these pin the source properties that make it hold, the same way
 * previewFailureContract.test.mjs does for the live previews.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const html = read('layouts', 'partials', 'bundletool.html');
const editor = read('public', 'js', 'frontend', 'coverEditor.js');

test('every placeholder is a concrete example, not generic wording', () => {
  for (const gone of ['IN THE COURT AT …', 'Bundle for Hearing on DD.MM.YYYY', 'Recorded as the document author']) {
    assert.doesNotMatch(html, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `no "${gone}" placeholder`);
  }
  assert.match(html, /placeholder="IN THE ABC COURT"/);
  assert.match(html, /placeholder="Bundle for Hearing on DD\.MM\.YY"/g);
  assert.match(html, /placeholder="A\. Solicitors"/g);
  assert.match(html, /placeholder="ABC012345"/); // Court Ref/Claim No., concrete too
});

test('Applicant is pre-filled from Parties only when both fields are blank, and never split into two names', () => {
  assert.match(editor, /function prefillPartiesFromBasicInformation/);
  assert.match(editor, /if \(applicant\.value\.trim\(\) \|\| respondent\.value\.trim\(\)\) return;/);
  assert.doesNotMatch(editor, /\.split\(.*(?:-and-|v|vs)/i, 'no attempt to parse Parties into two names');
  assert.match(editor, /respondent(?:\.value)? is left blank rather than guessed|Respondent\s*\n?\s*\* is left blank rather than guessed/);
});

test('the prefill is visibly a draft, not confirmed data: the text is selected and a hint shown, both cleared on edit', () => {
  assert.match(editor, /applicant\.select\(\);/);
  assert.match(editor, /ce-applicant-prefill-hint/);
  assert.match(html, /id="ce-applicant-prefill-hint"[^>]*hidden/);
});

test('an in-progress cover is saved as a draft and restored on reopen, but a draft never becomes the real cover on its own', () => {
  assert.match(editor, /import \{ saveDraft as saveCoverDraft, loadDraft as loadCoverDraft, applyDraftFields, clearDraft as clearCoverDraft \} from '\.\/coverDraft\.js';/);
  assert.match(editor, /function applyDraftIfAny/);
  assert.match(editor, /openEditor\(\) \{\s*populateFromBundle\(\);\s*applyDraftIfAny\(\);/);
  // The draft is only ever cleared once useCoversheet() has actually confirmed the design.
  const useCoversheet = editor.slice(editor.indexOf('async function useCoversheet'), editor.indexOf('export function setup'));
  assert.match(useCoversheet, /clearCoverDraft\(\);/);
  assert.doesNotMatch(/function closeEditor[\s\S]*?\n\}/.exec(editor)?.[0] ?? '', /clearCoverDraft/, 'closing without saving must not clear the draft');
});

test('a discard control clears the draft and puts the fields back to what Basic Information and the cover\'s own values would show', () => {
  assert.match(html, /id="ce-draft-discard"/);
  assert.match(editor, /function discardDraft\(\) \{\s*clearCoverDraft\(\);/);
  assert.match(editor, /ce-draft-discard'\)\?\.addEventListener\('click', discardDraft\)/);
});
