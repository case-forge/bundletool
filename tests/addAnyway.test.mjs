/**
 * "Add anyway" on the repeat-file warning: the warning offers the action beside its dismissal (which then reads "Leave
 * it out"), the action runs and closes the warning, every other warning keeps its single "Got it", and the action is
 * carried from processFiles through reportAdded to the warning, but only when a file was left out as a repeat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeDocument, FakeElement } from './fakeDom.mjs';

const doc = new FakeDocument();
globalThis.document = doc;
const el = (tag, id, cls = '') => { const e = doc.body.appendChild(new FakeElement(doc, tag, id)); e.className = cls; return e; };
const warning = el('div', 'upload-warning-modal', 'hidden');
for (const id of ['upload-warning-modal-title', 'upload-warning-modal-msg', 'upload-warning-modal-hint', 'upload-warning-modal-code']) el('p', id);
el('ul', 'upload-warning-modal-list');
el('p', 'upload-warning-modal-guide');
const action = el('button', 'upload-warning-modal-action', 'hidden');
const close = el('button', 'upload-warning-modal-close');
close.textContent = 'Got it';

const { showUploadWarningModal } = await import('../public/js/frontend/modals.js');
const { reportAdded, maybeWarnLargeBundleOnAdd } = await import('../public/js/frontend/fileProcessing.js');

test('a warning with an action shows the button, and pressing it runs the action and closes the warning', () => {
  let ran = 0;
  showUploadWarningModal({ code: 'BT-ADD-04', title: 'Already added', message: '"a.pdf" is already in the bundle, so it was not added again.', action: { label: 'Add anyway', run: () => { ran++; } } });
  assert.equal(warning.classList.contains('hidden'), false);
  assert.equal(action.classList.contains('hidden'), false);
  assert.equal(action.textContent, 'Add anyway');
  assert.equal(close.textContent, 'Leave it out');
  action.onclick();
  assert.equal(ran, 1);
  assert.equal(warning.classList.contains('hidden'), true);
  action.onclick?.();
  assert.equal(ran, 1, 'once only');
});

test('the next warning without an action goes back to a single "Got it"', () => {
  showUploadWarningModal({ code: null, title: 'Very large bundle', message: 'big' });
  assert.equal(action.classList.contains('hidden'), true);
  assert.equal(close.textContent, 'Got it');
  assert.equal(action.onclick ?? null, null);
});

test('reportAdded hands the action to the warning for a repeat, in every shape the message takes', () => {
  const act = { label: 'Add anyway', run() {} };
  const seen = [];
  const warn = (m) => seen.push(m);
  reportAdded([], 10, 1, 'x was already in the bundle.', warn, [], act);
  reportAdded([], 5000, 10, 'x was already in the bundle.', warn, [], act);
  reportAdded([{ name: 'a.png', reason: 'too large', replay() {} }, { name: 'b.png', reason: 'damaged', replay() {} }], 10, 1, 'x was already in the bundle.', warn, [], act);
  assert.equal(seen.length, 3);
  for (const m of seen) assert.equal(m.action, act);
});

test('with no repeat there is no action', () => {
  const seen = [];
  maybeWarnLargeBundleOnAdd(5000, 10, '', (m) => seen.push(m));
  assert.equal(seen[0].action, undefined);
});

test('the repeat-file warning highlights Leave it out and keeps Add anyway plain', () => {
  const html = fs.readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
  const tag = (id) => html.match(new RegExp(`<button id="${id}"[^>]*>`))[0];
  const addAnyway = tag('upload-warning-modal-action');
  const leaveItOut = tag('upload-warning-modal-close');
  assert.match(addAnyway, /bt-btn-flush/);
  assert.doesNotMatch(addAnyway, /bt-btn--(primary|secondary)/);
  assert.match(leaveItOut, /bt-btn--primary/);
});
