/**
 * The document window's "This page" and "Whole document" (frontend/rotate.js): a turn on one page shows on that page
 * only and writes only that page's rotation; several pages can each be turned; switching the choice carries the turn
 * the page in view shows; closing the window writes what was turned, and the choice starts on This page every time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modal, state, $, tick, until, anglesOf, createCanvas, open } from './documentWindowHarness.mjs';

const choose = (scope) => {
  const radio = $(scope === 'page' ? 'rotate-scope-page' : 'rotate-scope-document');
  $('rotate-scope-page').checked = scope === 'page';
  $('rotate-scope-document').checked = scope !== 'page';
  radio.dispatchEvent({ type: 'change', target: radio, preventDefault() {}, stopPropagation() {} });
};
/** Whether the picture drawn is on its side (wider than tall): an A4 page turned a quarter. */
async function drawnSideways(t) {
  if (!createCanvas) { t.skip('@napi-rs/canvas is not installed: nothing is drawn'); return null; }
  await tick();
  await until(() => $('rotate-preview').width > 0, 'a picture');
  await new Promise((r) => setTimeout(r, 30));
  return $('rotate-preview').width > $('rotate-preview').height;
}

test('the window opens on This page, every time, whatever it was left on', async () => {
  await open('scope.pdf', 3);
  assert.equal($('rotate-scope-page').checked, true);
  assert.equal(Boolean($('rotate-scope-document').checked), false);
  $('rotate-right').click();
  assert.equal($('rotate-status').textContent, 'This page turned right, 90 degrees');
  choose('document');
  $('rotate-close').click();
  await open('scope-again.pdf', 3);
  assert.equal($('rotate-scope-page').checked, true, 'not what the last window was left on');
  $('rotate-close').click();
});

test('This page: the turn shows on the page shown only, and closing writes only that page', async (t) => {
  const { name, file } = await open('one-page.pdf', 3);
  $('rotate-next').click();
  choose('page');
  $('rotate-right').click();
  assert.equal($('rotate-status').textContent, 'This page turned right, 90 degrees');
  const sideways2 = await drawnSideways(t);
  if (sideways2 !== null) {
    assert.equal(sideways2, true, 'page 2 is drawn turned');
    $('rotate-prev').click();
    assert.equal(await drawnSideways(t), false, 'page 1 is drawn as it was');
  }
  assert.equal(state.filesMap.get(name), file, 'nothing written yet');
  $('rotate-close').click();
  assert.equal(modal.classList.contains('hidden'), true);
  await until(() => state.filesMap.get(name) !== file, 'the turned file');
  assert.deepEqual(await anglesOf(state.filesMap.get(name)), [0, 90, 0]);
  assert.equal(state.frontendInputData[name].pagesChanged, true);
});

test('several pages can each be turned their own way, written together', async () => {
  const { name, file } = await open('several.pdf', 4);
  choose('page');
  $('rotate-right').click();                     // page 1 right
  $('rotate-next').click();
  $('rotate-next').click();
  $('rotate-left').click();                      // page 3 left
  $('rotate-close').click();
  await until(() => state.filesMap.get(name) !== file, 'the turned file');
  assert.deepEqual(await anglesOf(state.filesMap.get(name)), [90, 0, 270, 0]);
});

test('switching to Whole document gives every page the turn the page in view shows, and back to This page keeps it to that page', async () => {
  const { name, file } = await open('switch.pdf', 3);
  $('rotate-next').click();
  choose('page');
  $('rotate-right').click();
  choose('document');
  assert.equal($('rotate-status').textContent, 'Turned right, 90 degrees');
  choose('page');
  assert.equal($('rotate-status').textContent, 'This page turned right, 90 degrees', 'only the page in view keeps the turn');
  $('rotate-prev').click();
  choose('document');
  assert.equal($('rotate-ocr-note').classList.contains('hidden'), true, 'page 1 shows no turn, so the whole document takes none');
  $('rotate-right').click();
  $('rotate-close').click();
  await until(() => state.filesMap.get(name) !== file, 'the turned file');
  assert.deepEqual(await anglesOf(state.filesMap.get(name)), [90, 90, 90]);
});

test('closing after turning single pages writes those pages, and no others', async () => {
  const { name, file } = await open('close-pages.pdf', 3);
  choose('page');
  $('rotate-right').click();
  $('rotate-next').click();
  $('rotate-right').click();
  $('rotate-close').click();
  await until(() => state.filesMap.get(name) !== file, 'the turned file');
  assert.deepEqual(await anglesOf(state.filesMap.get(name)), [90, 90, 0]);
});

test('Redo OCR writes a single page\'s turn first, and only that page\'s', async () => {
  const seen = [];
  const { name } = await open('ocr-page.pdf', 3, { forceOcr: async (f) => { seen.push(await anglesOf(state.filesMap.get(f))); return false; } });
  $('rotate-next').click();
  choose('page');
  $('rotate-left').click();
  $('rotate-ocr').click();
  await until(() => seen.length === 1, 'Redo OCR to start');
  assert.deepEqual(seen[0], [0, 270, 0]);
  await until(() => $('rotate-ocr-label').textContent === 'OCR', 'Redo OCR to finish');
  assert.equal($('rotate-ocr-note').classList.contains('hidden'), true);
  $('rotate-close').click();
  assert.deepEqual(await anglesOf(state.filesMap.get(name)), [0, 270, 0]);
});
