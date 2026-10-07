/**
 * Create Bundle while text is still being read (frontend/ocrWait.js): one question at a time, about the document
 * being read now, naming it. Wait waits for it (with its progress and Cancel) and then moves on; Skip this document
 * stops its reading and asks about the next; Cancel builds nothing, whether pressed on the question or while
 * waiting; a document that finishes while the question is open is answered for; the build starts when nothing is
 * left. Driven against the real dialog's ids from the template, in the fake DOM.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeDocument, elementsFromTemplate, templateBlock } from './fakeDom.mjs';

const doc = new FakeDocument();
globalThis.document = doc;
const html = fs.readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
elementsFromTemplate(doc, doc.body, templateBlock(html, 'ocr-wait-modal'));
elementsFromTemplate(doc, doc.body, templateBlock(html, 'processing-overlay'));

const { state } = await import('../public/js/frontend/state.js');
const { settleReadingBeforeBuild } = await import('../public/js/frontend/ocrWait.js');
const R = await import('../public/js/frontend/ocrReading.js');

R.setReadingClock(() => 0);
const $ = (id) => doc.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 0));
const open = (id) => !$(id).classList.contains('hidden');

function reading(name, { status = 'reading', pages = 3 } = {}) {
  R.trackReading(name, { status: 'checking', controller: new AbortController() });
  R.readingQueued(name, pages);
  if (status === 'reading') { R.readingBegun(name); R.readingStarted(name, pages); }
}

beforeEach(() => {
  R.stopAllReading();
  R.resetReadingTimes();
  for (const k of Object.keys(state.frontendInputData)) delete state.frontendInputData[k];
  $('ocr-wait-modal').classList.add('hidden');
  $('processing-overlay').classList.add('hidden');
});

test('the dialog is in the template: titled, with Wait, Skip this document and Cancel, and Escape is Cancel', () => {
  const block = templateBlock(html, 'ocr-wait-modal');
  assert.match(block, /role="dialog"/);
  assert.match(block, /aria-labelledby="ocr-wait-modal-title"/);
  assert.match(block, /id="ocr-wait-wait"[^>]*>\s*Wait\s*</);
  assert.match(block, /id="ocr-wait-skip"[^>]*>\s*Skip this document\s*</);
  assert.match(block, /id="ocr-wait-cancel"[^>]*>\s*Cancel\s*</);
  assert.doesNotMatch(block, /[Bb]uild now/, 'no build-now-without-all-of-them answer');
  const page = fs.readFileSync(new URL('../public/js/bundletoolPage.js', import.meta.url), 'utf8');
  assert.match(page, /'ocr-wait-modal': 'ocr-wait-cancel'/);
});

test('nothing being read: the build goes ahead with no question', async () => {
  assert.equal(await settleReadingBeforeBuild(), true);
  assert.equal(open('ocr-wait-modal'), false);
});

test('Wait: the question names the document being read now; waiting shows its progress, then the build goes ahead', async () => {
  reading('scan.pdf', { pages: 3 });
  const settled = settleReadingBeforeBuild();
  await tick();
  assert.equal(open('ocr-wait-modal'), true);
  assert.match($('ocr-wait-msg').textContent, /^The text of "scan\.pdf" is still being read\. Wait for it, or skip this document/);
  $('ocr-wait-wait').click();
  await tick();
  assert.equal(open('ocr-wait-modal'), false);
  assert.equal(open('processing-overlay'), true, 'the wait shows its progress');
  assert.equal($('processing-overlay-msg').textContent, 'Reading the text of "scan.pdf", page 1 of 3…');
  assert.equal($('processing-cancel-btn').classList.contains('hidden'), false, 'with Cancel');
  R.pageRead('scan.pdf', 1, 3);
  assert.equal($('processing-overlay-msg').textContent, 'Reading the text of "scan.pdf", page 2 of 3…', 'kept up to date');
  R.finishReading('scan.pdf');
  assert.equal(await settled, true, 'read: the build goes ahead');
  assert.equal(open('processing-overlay'), false);
  assert.equal(state._cancelReject, null);
});

test('Skip this document stops its reading and asks about the next; Cancel there builds nothing', async () => {
  reading('first.pdf');
  reading('second.pdf', { status: 'waiting' });
  const controller = state.ocrReading.get('first.pdf').controller;
  const settled = settleReadingBeforeBuild();
  await tick();
  assert.match($('ocr-wait-msg').textContent, /"first\.pdf"/);
  assert.match($('ocr-wait-msg').textContent, /1 more document waits after it\.$/);
  $('ocr-wait-skip').click();
  await tick();
  assert.equal(controller.signal.aborted, true, 'its reading stopped');
  assert.equal(state.ocrReading.has('first.pdf'), false);
  assert.equal(open('ocr-wait-modal'), true, 'asked again');
  assert.match($('ocr-wait-msg').textContent, /^The text of "second\.pdf" has not been read yet\./);
  $('ocr-wait-cancel').click();
  assert.equal(await settled, false, 'Cancel: no build');
  assert.equal(state.ocrReading.has('second.pdf'), true, 'and the reading carries on');
});

test('Skip this document on the last one: nothing is left, so the build goes ahead', async () => {
  reading('only.pdf');
  const settled = settleReadingBeforeBuild();
  await tick();
  $('ocr-wait-skip').click();
  assert.equal(await settled, true);
});

test('Cancel while waiting builds nothing and leaves the reading going', async () => {
  reading('slow.pdf');
  const settled = settleReadingBeforeBuild();
  await tick();
  $('ocr-wait-wait').click();
  await tick();
  state._cancelReject(new Error('__cancelled__'));   // the overlay's own Cancel (bundleGeneration.js setup)
  assert.equal(await settled, false);
  assert.equal(open('processing-overlay'), false);
  assert.equal(state.ocrReading.get('slow.pdf').controller.signal.aborted, false);
});

test('Wait on one document, then the next still to read is asked about in its turn', async () => {
  reading('a.pdf');
  reading('b.pdf', { status: 'waiting' });
  const settled = settleReadingBeforeBuild();
  await tick();
  $('ocr-wait-wait').click();
  await tick();
  R.finishReading('a.pdf');
  R.readingBegun('b.pdf');
  await tick();
  assert.equal(open('ocr-wait-modal'), true);
  assert.match($('ocr-wait-msg').textContent, /"b\.pdf" is still being read/);
  $('ocr-wait-wait').click();
  await tick();
  R.finishReading('b.pdf');
  assert.equal(await settled, true);
});

test('a document read while the question is open is answered for: the question closes and the build goes ahead', async () => {
  reading('quick.pdf');
  const settled = settleReadingBeforeBuild();
  await tick();
  assert.equal(open('ocr-wait-modal'), true);
  R.finishReading('quick.pdf');
  assert.equal(await settled, true);
  assert.equal(open('ocr-wait-modal'), false);
});

test('documents only being checked are waited for quietly; one that turns out to need reading is then asked about', async () => {
  R.trackReading('checking.pdf', { status: 'checking' });
  const settled = settleReadingBeforeBuild();
  await tick();
  assert.equal(open('ocr-wait-modal'), false);
  assert.equal($('processing-overlay-msg').textContent, 'Checking the documents for pages to read…');
  R.readingQueued('checking.pdf', 2);
  await tick();
  await tick();
  assert.equal(open('ocr-wait-modal'), true);
  $('ocr-wait-skip').click();
  assert.equal(await settled, true);
});

test('Create Bundle asks after its other questions and before anything is built or marked as started', () => {
  const code = fs.readFileSync(new URL('../public/js/frontend/bundleGeneration.js', import.meta.url), 'utf8');
  const submit = code.slice(code.indexOf('export async function handleFormSubmit'), code.indexOf('export async function runPreviewIndex'));
  const at = (s) => { const i = submit.indexOf(s); assert.ok(i > -1, s); return i; };
  assert.ok(at('confirmLargeBundle()') < at('await settleReadingBeforeBuild()'));
  assert.ok(at('if (!await settleReadingBeforeBuild()) return;') < at('markBuildStarted('));
  assert.ok(at('await settleReadingBeforeBuild()') < at('state.processTheBundle('));
});
