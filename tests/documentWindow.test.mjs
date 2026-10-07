/**
 * The document window (frontend/rotate.js), opened by a Review Table row's eye, driven through the ids the real
 * template gives it (tests/fakeDom.mjs) and a real pdf.js: paging by button, by arrow key and by a typed page number;
 * only the page shown held by pdf.js; a turn previewed, written by "Turn document" and dropped by Cancel, the close
 * cross and Escape; and Force OCR run through the window, after any turn waiting to be confirmed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeEvent } from './fakeDom.mjs';
import { makePdf } from './fixtures.mjs';
import { doc, modal, outside, log, state, openDocumentWindow, $, tick, until, anglesOf, shownPage, key, open } from './documentWindowHarness.mjs';

test('the window opens on page 1 of N, from the eye, and pages by button with the ends held', async () => {
  log.got.length = 0;
  const { opener } = await open('a.pdf', 3);
  assert.equal(modal.classList.contains('hidden'), false);
  assert.equal($('rotate-file').textContent, 'a.pdf');
  assert.equal(shownPage(), 1);
  assert.equal($('rotate-page-count').textContent, '3');
  assert.equal($('rotate-preview').getAttribute('aria-label'), 'Page 1 of 3');
  assert.equal($('rotate-prev').disabled, true);
  assert.equal($('rotate-next').disabled, false);

  $('rotate-next').click();
  assert.equal(shownPage(), 2);
  $('rotate-next').click();
  assert.equal(shownPage(), 3);
  assert.equal($('rotate-next').disabled, true);
  $('rotate-next').click();
  assert.equal(shownPage(), 3, 'no page after the last');
  $('rotate-prev').click();
  assert.equal(shownPage(), 2);
  assert.equal($('rotate-preview').getAttribute('aria-label'), 'Page 2 of 3');
  $('rotate-cancel').click();
  assert.equal(modal.classList.contains('hidden'), true);
  assert.equal(doc.activeElement, opener, 'focus goes back to the row\'s eye');
});

test('the Left and Right arrow keys page while focus is in the window, and only then', async () => {
  await open('b.pdf', 3);
  key('ArrowRight');
  assert.equal(shownPage(), 2);
  key('ArrowRight');
  key('ArrowRight');
  assert.equal(shownPage(), 3, 'held at the last page');
  key('ArrowLeft');
  assert.equal(shownPage(), 2);
  key('ArrowRight', outside);
  assert.equal(shownPage(), 2, 'a key pressed outside the window does nothing');
  key('ArrowLeft', $('rotate-page-input'));
  assert.equal(shownPage(), 2, 'in the page box the arrows move the caret');
  $('rotate-close').click();
});

test('a typed page number goes there, held to 1..N; anything else puts the box back', async () => {
  await open('c.pdf', 4);
  const input = $('rotate-page-input');
  const type = (value, how = 'change') => {
    input.value = value;
    if (how === 'Enter') input.dispatchEvent(fakeEvent('keydown', { key: 'Enter' }));
    else input.dispatchEvent(fakeEvent('change'));
  };
  type('3');
  assert.equal(shownPage(), 3);
  type('2', 'Enter');
  assert.equal(shownPage(), 2);
  type('99');
  assert.equal(shownPage(), 4, 'past the end goes to the last page');
  type('0');
  assert.equal(shownPage(), 1, 'before the start goes to the first page');
  type('3');
  for (const bad of ['', 'two', '2.5', '-1', ' ']) {
    type(bad);
    assert.equal(input.value, '3', `"${bad}" snaps back`);
    assert.equal(shownPage(), 3);
  }
  $('rotate-close').click();
});

test('only the page shown is held: each page is freed when another takes its place, and the document on close', async () => {
  log.got.length = 0;
  log.freed.length = 0;
  const destroyedBefore = log.destroyed;
  await open('d.pdf', 3);
  $('rotate-next').click();
  await until(() => log.got.includes(2), 'page 2');
  await until(() => log.freed.includes(1), 'page 1 freed');
  $('rotate-next').click();
  await until(() => log.got.includes(3), 'page 3');
  await until(() => log.freed.includes(2), 'page 2 freed');
  assert.equal(log.freed.includes(3), false, 'the page shown is kept');
  assert.deepEqual([...new Set(log.got)], [1, 2, 3], 'each page is asked for when it is shown, not before');
  $('rotate-cancel').click();
  assert.ok(log.freed.includes(3), 'closing frees the page shown');
  await until(() => log.destroyed > destroyedBefore, 'the document freed');
});

test('a turn is previewed, written by Turn document to every page, and only then', async () => {
  const { name, file } = await open('turn.pdf', 2);
  assert.equal($('rotate-apply').disabled, true, 'nothing to confirm yet');
  $('rotate-right').click();
  assert.equal($('rotate-apply').disabled, false);
  assert.equal($('rotate-status').textContent, 'Turned right, 90 degrees');
  assert.equal($('rotate-ocr-note').classList.contains('hidden'), false, 'Force OCR says it will write the turn first');
  assert.equal(state.filesMap.get(name), file, 'the stored file is untouched while the turn waits');
  $('rotate-right').click();
  $('rotate-left').click();
  $('rotate-left').click();
  assert.equal($('rotate-apply').disabled, true, 'turned back to where it started');
  $('rotate-left').click();
  assert.equal($('rotate-status').textContent, 'Turned left, 270 degrees');
  $('rotate-apply').click();
  assert.equal(modal.classList.contains('hidden'), true, 'the window closes on a confirmed turn');
  await until(() => state.filesMap.get(name) !== file, 'the turned file');
  assert.deepEqual(await anglesOf(state.filesMap.get(name)), [270, 270]);
  assert.equal(state.frontendInputData[name].pagesChanged, true, 'marked as a document BundleTool changed');
});

test('Cancel, the close cross and Escape leave the file untouched', async () => {
  const page = fs.readFileSync(new URL('../public/js/bundletoolPage.js', import.meta.url), 'utf8');
  const escapeTarget = /'rotate-modal':\s*'([a-z-]+)'/.exec(page)?.[1];
  assert.equal(escapeTarget, 'rotate-cancel', 'Escape presses Cancel (bundletoolPage.js MODAL_DISMISS)');
  for (const way of ['rotate-cancel', 'rotate-close', escapeTarget]) {
    const { name, file } = await open(`keep-${way}.pdf`, 2);
    $('rotate-right').click();
    $('rotate-next').click();
    $(way).click();
    await tick();
    assert.equal(modal.classList.contains('hidden'), true);
    assert.equal(state.filesMap.get(name), file, `${way} keeps the very same file`);
    assert.deepEqual(await anglesOf(state.filesMap.get(name)), [0, 0]);
    assert.equal(state.frontendInputData[name].pagesChanged, undefined, 'not marked as changed');
  }
});

test('Force OCR runs from the window: progress shown, buttons off while it runs, the file reloaded after', async () => {
  let release;
  const calls = [];
  const fakeForceOcr = async (filename, opener, { onProgress }) => {
    calls.push({ filename, opener, angles: await anglesOf(state.filesMap.get(filename)) });
    onProgress('Reading text… page 1 of 2');
    await new Promise((r) => { release = r; });
    state.filesMap.set(filename, new File([await makePdf(2, 'READ')], filename, { type: 'application/pdf' }));
    return true;
  };
  const { name } = await open('ocr.pdf', 2, { forceOcr: fakeForceOcr });
  $('rotate-ocr').click();
  await until(() => calls.length === 1, 'Force OCR to start');
  assert.equal(calls[0].filename, name);
  assert.equal(calls[0].opener, $('rotate-ocr'), 'focus comes back to the window\'s own button');
  assert.equal($('rotate-message').textContent, 'Reading text… page 1 of 2');
  for (const id of ['rotate-ocr', 'rotate-left', 'rotate-right', 'rotate-apply']) assert.equal($(id).disabled, true, `${id} is off while it runs`);
  $('rotate-ocr').click();
  assert.equal(calls.length, 1, 'a second press does not start a second run');
  release();
  await until(() => !$('rotate-ocr').disabled, 'Force OCR to finish');
  assert.equal($('rotate-message').textContent, 'Text read: it can now be selected and searched.');
  assert.equal($('rotate-left').disabled, false);
  $('rotate-cancel').click();
});

test('a turn waiting to be confirmed is written before Force OCR reads the document, and is then no longer pending', async () => {
  const seen = [];
  const fakeForceOcr = async (filename) => { seen.push(await anglesOf(state.filesMap.get(filename))); return false; };
  const { name } = await open('ocr-turn.pdf', 2, { forceOcr: fakeForceOcr });
  $('rotate-right').click();
  $('rotate-ocr').click();
  await until(() => seen.length === 1, 'Force OCR to start');
  assert.deepEqual(seen[0], [90, 90], 'Force OCR reads the turned pages');
  await until(() => !$('rotate-ocr').disabled, 'Force OCR to finish');
  assert.equal($('rotate-apply').disabled, true, 'the turn is written, so there is nothing left to confirm');
  assert.equal($('rotate-ocr-note').classList.contains('hidden'), true);
  $('rotate-cancel').click();
  assert.deepEqual(await anglesOf(state.filesMap.get(name)), [90, 90], 'Cancel afterwards does not undo what Force OCR wrote');
  assert.equal(state.frontendInputData[name].pagesChanged, true);
});

test('a document flagged as expanding is never drawn, but the window still opens and pages', async () => {
  const name = 'bomb.pdf';
  state.filesMap.set(name, new File([await makePdf(2)], name, { type: 'application/pdf' }));
  state.frontendInputData[name] = { title: name, date: '', pageCount: 2, expanding: true };
  log.got.length = 0;
  await openDocumentWindow(name, null);
  await until(() => !$('rotate-no-preview').classList.contains('hidden'), 'the no-preview line');
  assert.equal($('rotate-preview').classList.contains('hidden'), true);
  $('rotate-next').click();
  assert.equal(shownPage(), 2);
  await tick();
  assert.deepEqual(log.got, [], 'pdf.js is never asked for a page');
  $('rotate-cancel').click();
});
