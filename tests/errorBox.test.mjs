/**
 * The error code on the screen and in the report: showErrorModal, showUploadWarningModal and showPageNotice
 * (frontend/modals.js) put a registered code in the small line after the message and hide the line when there is
 * none, the error box's report opens with "Code: ..." (built by the shared reporter, static/js/shared/bug-report.js),
 * and anything that is not a registered code, a file name above all, is never shown or written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { FakeDocument, FakeElement, elementsFromTemplate, templateBlock } from './fakeDom.mjs';

const doc = new FakeDocument();
globalThis.document = doc;
const html = fs.readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
for (const id of ['error-modal', 'upload-warning-modal', 'restore-notice']) {
  const block = templateBlock(html, id);
  const host = doc.body.appendChild(new FakeElement(doc, 'div'));
  elementsFromTemplate(doc, host, block);
}

// The shared reporter, as the page loads it: a plain script that sets window.cfBugReport.
const reporter = fs.readFileSync(fileURLToPath(import.meta.resolve('/js/shared/bug-report.js')), 'utf8');
const pageWindow = { addEventListener() {} };
vm.runInNewContext(reporter, {
  window: pageWindow, document: doc, navigator: { userAgent: 'test' },
  location: { origin: 'https://example.test', pathname: '/bundletool/' }, localStorage: { setItem() {} },
});
globalThis.window = pageWindow;

const { showErrorModal, showUploadWarningModal, showPageNotice } = await import('../public/js/frontend/modals.js');
const $ = (id) => doc.getElementById(id);

test('the error box shows its code after the message, and the report opens with it', () => {
  showErrorModal({ code: 'BT-BUILD-06', title: 'Bundle generation failed', message: 'Something went wrong.', error: new Error('boom') });
  assert.equal($('error-modal-code').textContent, 'Error code BT-BUILD-06');
  assert.equal($('error-modal-code').classList.contains('hidden'), false);
  const report = $('error-modal-details').value;
  assert.match(report, /^Code: BT-BUILD-06\nBuild: /);
  assert.match(report, /\nError: boom/);
});

test('an error box without an error object still shows its code', () => {
  showErrorModal({ code: 'BT-BUILD-01', title: 'No documents added', message: 'Add one first.' });
  assert.equal($('error-modal-code').textContent, 'Error code BT-BUILD-01');
});

test('a value that is not a registered code is never shown or written: a file name least of all', () => {
  for (const bad of ['Client letter.pdf', 'BT-BUILD-99', undefined]) {
    showErrorModal({ code: bad, title: 'x', message: 'y', error: new Error('boom') });
    assert.equal($('error-modal-code').textContent, '', String(bad));
    assert.equal($('error-modal-code').classList.contains('hidden'), true, String(bad));
    assert.doesNotMatch($('error-modal-details').value, /Code:|letter/, String(bad));
  }
});

test('the warning shows a code when something was refused, and no line for a notice that only informs', () => {
  showUploadWarningModal({ code: 'BT-ADD-24', title: 'That file cannot be added', message: '"a.exe" is a program.' });
  assert.equal($('upload-warning-modal-code').textContent, 'Error code BT-ADD-24');
  showUploadWarningModal({ code: null, title: 'Very large bundle', message: 'Your documents total 1200 pages.' });
  assert.equal($('upload-warning-modal-code').textContent, '');
  assert.equal($('upload-warning-modal-code').classList.contains('hidden'), true);
});

test('the notice above the form shows a code the same way', () => {
  showPageNotice({ code: 'BT-SAVE-01', title: 'Your work could not be saved on this device', message: 'No room.' });
  assert.equal($('restore-notice-code').textContent, 'Error code BT-SAVE-01');
  assert.equal($('restore-notice').classList.contains('hidden'), false);
  showPageNotice({ code: null, title: 'Your last session is back', message: '3 documents.' });
  assert.equal($('restore-notice-code').classList.contains('hidden'), true);
});

test('the reporter writes a code of any product\'s shape and nothing else in that field', () => {
  const details = pageWindow.cfBugReport.details;
  assert.match(details(new Error('x'), 't', 'EG-PREVIEW-01'), /^Code: EG-PREVIEW-01\n/);
  assert.match(details(new Error('x'), 't', 'CF-DATA-01'), /^Code: CF-DATA-01\n/);
  assert.doesNotMatch(details(new Error('x'), 't', 'statement.pdf'), /Code:/);
  assert.doesNotMatch(details(new Error('x'), 't'), /Code:/);
});
