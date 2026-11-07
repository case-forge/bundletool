/**
 * The document window (frontend/rotate.js), opened by a Review Table row's eye, driven through the ids the real
 * template gives it (tests/fakeDom.mjs) and a real pdf.js: paging by button, by arrow key and by a typed page number;
 * only the page shown held by pdf.js; a turn previewed, written by "Turn document" and dropped by Cancel, the close
 * cross and Escape; and Redo OCR run through the window, after any turn waiting to be confirmed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeEvent } from './fakeDom.mjs';
import { makePdf } from './fixtures.mjs';
import { doc, modal, outside, log, state, openDocumentWindow, $, tick, until, anglesOf, shownPage, key, open } from './documentWindowHarness.mjs';

/** The window opens turning one page at a time; this is the choice of "Turn all pages". */
function chooseAllPages() {
  const radio = $('rotate-scope-document');
  $('rotate-scope-page').checked = false;
  radio.checked = true;
  radio.dispatchEvent({ type: 'change', target: radio, preventDefault() {}, stopPropagation() {} });
}

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
  $('rotate-close').click();
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
  $('rotate-close').click();
  assert.ok(log.freed.includes(3), 'closing frees the page shown');
  await until(() => log.destroyed > destroyedBefore, 'the document freed');
});

test('a turn is previewed, and written once, when the window closes', async () => {
  const { name, file } = await open('turn.pdf', 2);
  assert.equal($('rotate-ocr-note').classList.contains('hidden'), true, 'nothing waits yet');
  chooseAllPages();
  $('rotate-right').click();
  assert.equal($('rotate-status').textContent, 'Turned right, 90 degrees');
  assert.equal($('rotate-ocr-note').classList.contains('hidden'), false, 'Redo OCR says it will write the turn first');
  assert.equal(state.filesMap.get(name), file, 'the stored file is untouched while the turn waits');
  $('rotate-right').click();
  $('rotate-left').click();
  $('rotate-left').click();
  assert.equal($('rotate-ocr-note').classList.contains('hidden'), true, 'turned back to where it started');
  assert.equal(state.filesMap.get(name), file);
  $('rotate-left').click();
  assert.equal($('rotate-status').textContent, 'Turned left, 270 degrees');
  $('rotate-close').click();
  assert.equal(modal.classList.contains('hidden'), true, 'the window closes at once');
  await until(() => state.filesMap.get(name) !== file, 'the turned file');
  assert.deepEqual(await anglesOf(state.filesMap.get(name)), [270, 270]);
  assert.equal(state.frontendInputData[name].pagesChanged, true, 'marked as a document BundleTool changed');
});

test('the close cross and Escape both write a waiting turn, and a turn turned back writes nothing', async () => {
  const page = fs.readFileSync(new URL('../public/js/bundletoolPage.js', import.meta.url), 'utf8');
  const escapeTarget = /'rotate-modal':\s*'([a-z-]+)'/.exec(page)?.[1];
  assert.equal(escapeTarget, 'rotate-close', 'Escape presses the close cross (bundletoolPage.js MODAL_DISMISS)');
  const html = fs.readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="rotate-(apply|cancel)"/, 'no confirm or cancel button: closing is the confirmation');
  for (const way of ['rotate-close', escapeTarget]) {
    const { name, file } = await open(`close-${way}.pdf`, 2);
    $('rotate-right').click();
    $('rotate-next').click();
    $(way).click();
    assert.equal(modal.classList.contains('hidden'), true);
    await until(() => state.filesMap.get(name) !== file, `${way} writes the turn`);
    assert.deepEqual(await anglesOf(state.filesMap.get(name)), [90, 0], 'the page shown was the one turned');
  }
  const { name, file } = await open('turn-back.pdf', 2);
  $('rotate-right').click();
  $('rotate-left').click();
  $('rotate-close').click();
  await tick();
  assert.equal(state.filesMap.get(name), file, 'a turn undone before closing writes nothing');
  assert.equal(state.frontendInputData[name].pagesChanged, undefined, 'not marked as changed');
});

test('Redo OCR runs from the window: progress shown, buttons off while it runs, the file reloaded after', async () => {
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
  await until(() => calls.length === 1, 'Redo OCR to start');
  assert.equal(calls[0].filename, name);
  assert.equal(calls[0].opener, $('rotate-ocr'), 'focus comes back to the window\'s own button');
  assert.equal($('rotate-message').textContent, 'Reading text… page 1 of 2');
  for (const id of ['rotate-left', 'rotate-right', 'rotate-remove', 'rotate-split', 'rotate-merge']) assert.equal($(id).disabled, true, `${id} is off while it runs`);
  assert.equal($('rotate-ocr').disabled, false, 'the OCR button stays on, as Stop');
  assert.equal($('rotate-ocr-label').textContent, 'Stop');
  release();
  await until(() => $('rotate-ocr-label').textContent === 'OCR', 'Redo OCR to finish');
  assert.equal($('rotate-message').textContent, 'Text read: it can now be selected and searched.');
  assert.equal($('rotate-left').disabled, false);
  $('rotate-close').click();
});

test('while Redo OCR reads, its button is Stop: pressing it stops the reading and leaves the document as it was', async () => {
  const { trackReading, finishReading } = await import('../public/js/frontend/ocrReading.js');
  const controller = new AbortController();
  const fakeForceOcr = async (filename) => {
    trackReading(filename, { status: 'reading', source: 'force', controller, pagesToRead: 2 });
    await new Promise((resolve) => controller.signal.addEventListener('abort', resolve));
    finishReading(filename);
    return false;
  };
  const { name, file } = await open('stop.pdf', 2, { forceOcr: fakeForceOcr });
  assert.equal($('rotate-ocr-label').textContent, 'OCR');
  $('rotate-ocr').click();
  await until(() => $('rotate-ocr-label').textContent === 'Stop', 'the button to say Stop');
  assert.equal($('rotate-ocr').getAttribute('aria-label'), 'Stop reading');
  $('rotate-ocr').click();
  await until(() => $('rotate-ocr-label').textContent === 'OCR', 'the reading to stop');
  assert.equal(controller.signal.aborted, true, 'the reading was told to stop');
  assert.equal($('rotate-message').textContent, 'Stopped. The document was left as it was.');
  assert.equal(state.filesMap.get(name), file);
  assert.equal($('rotate-remove').disabled, false, 'the other buttons are back');
  assert.equal($('rotate-ocr').getAttribute('aria-label'), 'Redo OCR');
  $('rotate-close').click();
});

test('a turn waiting to be confirmed is written before Redo OCR reads the document, and is then no longer pending', async () => {
  const seen = [];
  const fakeForceOcr = async (filename) => { seen.push(await anglesOf(state.filesMap.get(filename))); return false; };
  const { name } = await open('ocr-turn.pdf', 2, { forceOcr: fakeForceOcr });
  chooseAllPages();
  $('rotate-right').click();
  $('rotate-ocr').click();
  await until(() => seen.length === 1, 'Redo OCR to start');
  assert.deepEqual(seen[0], [90, 90], 'Redo OCR reads the turned pages');
  await until(() => $('rotate-ocr-label').textContent === 'OCR', 'Redo OCR to finish');
  assert.equal($('rotate-ocr-note').classList.contains('hidden'), true, 'the turn is written, so nothing waits');
  $('rotate-close').click();
  assert.deepEqual(await anglesOf(state.filesMap.get(name)), [90, 90], 'closing afterwards does not undo what Redo OCR wrote');
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
  $('rotate-close').click();
});
