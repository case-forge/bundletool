/**
 * "Remove this page" in the document window (frontend/rotate.js): asked first, and Keep it, Cancel, Escape and the
 * close cross leave the file untouched; never the last page; once confirmed the page goes, the window says so and
 * shows the page that took its place, and the row's page count, the bundle total and the autosave follow the stored
 * bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument } from '@cantoo/pdf-lib';
import { FakeElement } from './fakeDom.mjs';
import { doc, modal, state, $, tick, until, anglesOf, shownPage, open } from './documentWindowHarness.mjs';

const { init: initAutosave } = await import('../public/js/bundletoolAutosave.js');
const saves = [];
initAutosave(async () => { saves.push(Date.now()); return null; });

const pagesOf = async (name) => (await PDFDocument.load(await state.filesMap.get(name).arrayBuffer())).getPageCount();

/** The document's row in the Review Table, with its page count cell, and the bundle's running total. */
function row(name, pages) {
  const tr = doc.body.appendChild(new FakeElement(doc, 'tr'));
  tr.className = 'file-row';
  tr.dataset.filename = name;
  const cell = tr.appendChild(new FakeElement(doc, 'td'));
  cell.className = 'pages-cell';
  cell.textContent = String(pages);
  if (!doc.getElementById('bundle-totals')) doc.body.appendChild(new FakeElement(doc, 'p', 'bundle-totals'));
  return cell;
}

test('the button is there, and off for a one-page document', async () => {
  await open('single.pdf', 1);
  assert.equal($('rotate-remove').disabled, true, 'a document keeps its last page');
  $('rotate-remove').click();
  assert.equal($('rotate-remove-confirm').classList.contains('hidden'), true, 'nothing is asked');
  $('rotate-cancel').click();
  await open('three.pdf', 3);
  assert.equal($('rotate-remove').disabled, false);
  $('rotate-cancel').click();
});

test('it asks first; Keep it, Cancel, the close cross and Escape all leave the file untouched', async () => {
  const page = fs.readFileSync(new URL('../public/js/bundletoolPage.js', import.meta.url), 'utf8');
  const escapeTarget = /'rotate-modal':\s*'([a-z-]+)'/.exec(page)?.[1];
  for (const way of ['rotate-remove-keep', 'rotate-cancel', 'rotate-close', escapeTarget]) {
    const { name, file } = await open(`ask-${way}.pdf`, 3);
    $('rotate-next').click();
    $('rotate-remove').click();
    assert.equal($('rotate-remove-confirm').classList.contains('hidden'), false);
    assert.equal($('rotate-remove-question').textContent, 'Remove page 2 of 3 from this document?');
    $(way).click();
    await tick();
    assert.equal($('rotate-remove-confirm').classList.contains('hidden'), true);
    assert.equal(state.filesMap.get(name), file, `${way} keeps the very same file`);
    assert.equal(state.frontendInputData[name].pagesChanged, undefined);
    if (way !== 'rotate-remove-keep') assert.equal(modal.classList.contains('hidden'), true);
    else $('rotate-cancel').click();
  }
});

test('while it asks, the question is the only thing on offer: one remove button, paging off; Keep it gives it all back', async () => {
  await open('asking.pdf', 3);
  $('rotate-next').click();
  $('rotate-remove').click();
  assert.equal(modal.classList.contains('bt-rotate-asking'), true, 'the window hides its own buttons while it asks');
  for (const id of ['rotate-prev', 'rotate-next', 'rotate-page-input']) assert.equal($(id).disabled, true, `${id} is off while it asks`);
  $('rotate-remove-keep').click();
  await tick();
  assert.equal(modal.classList.contains('bt-rotate-asking'), false);
  assert.equal($('rotate-prev').disabled, false, 'page 2 of 3 can go back');
  assert.equal($('rotate-next').disabled, false, 'page 2 of 3 can go on');
  assert.equal($('rotate-page-input').disabled, false);
  $('rotate-cancel').click();

  const css = fs.readFileSync(new URL('../assets/css/bundletool.css', import.meta.url), 'utf8');
  const hidden = /([^{}]+)\{\s*display:\s*none;\s*\}/g;
  const hiddenWhileAsking = [...css.matchAll(hidden)].map((m) => m[1]).filter((s) => s.includes('.bt-rotate-asking')).join(',');
  for (const part of ['.bt-rotate-controls', '.bt-rotate-scope', '.bt-rotate-footer', '#rotate-ocr-note']) {
    assert.ok(hiddenWhileAsking.includes(`.bt-rotate-asking ${part}`), `${part} is hidden while the window asks`);
  }
  const html = fs.readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
  assert.match(html, /class="bt-rotate-footer[^"]*"[^>]*>\s*<button id="rotate-cancel"/, 'the window footer carries the class the rule hides');
});

test('confirmed, the page goes: the window says so, shows the page that took its place, and the row, total and autosave follow', async () => {
  const { name, file } = await open('remove.pdf', 4);
  const cell = row(name, 4);
  $('rotate-next').click();
  $('rotate-next').click();
  $('rotate-remove').click();
  const savesBefore = saves.length;
  $('rotate-remove-yes').click();
  await until(() => $('rotate-message').textContent === 'Page 3 removed.', 'the status line');
  await until(() => !$('rotate-remove').disabled, 'the window to settle');
  assert.notEqual(state.filesMap.get(name), file);
  assert.equal(await pagesOf(name), 3);
  assert.equal(shownPage(), 3, 'the page that followed it is shown');
  assert.equal($('rotate-page-count').textContent, '3');
  assert.equal(state.frontendInputData[name].pageCount, 3, 'read back from the stored bytes');
  assert.equal(cell.textContent, '3', 'the row\'s page count');
  assert.match(doc.getElementById('bundle-totals').textContent, /\b\d+ pages?\b/);
  assert.equal(state.frontendInputData[name].pagesChanged, true, 'one of the documents BundleTool changed');
  await until(() => saves.length > savesBefore, 'an autosave');
  $('rotate-cancel').click();
  assert.equal(await pagesOf(name), 3, 'Cancel afterwards does not bring the page back');
});

test('removing the last page shows the new last page, and the button goes off at one page left', async () => {
  const { name } = await open('last.pdf', 2);
  row(name, 2);
  $('rotate-next').click();
  $('rotate-remove').click();
  $('rotate-remove-yes').click();
  await until(() => $('rotate-message').textContent === 'Page 2 removed.', 'the status line');
  await until(() => shownPage() === 1 && $('rotate-page-count').textContent === '1', 'page 1 of 1');
  await tick();
  assert.equal($('rotate-remove').disabled, true);
  assert.equal(await pagesOf(name), 1);
  $('rotate-cancel').click();
});

test('a turn waiting to be confirmed is written before the page is removed, and the question says so', async () => {
  const { name } = await open('turn-then-remove.pdf', 3);
  $('rotate-right').click();
  $('rotate-remove').click();
  assert.match($('rotate-remove-question').textContent, /The turn is written into the document first\./);
  $('rotate-remove-yes').click();
  await until(() => $('rotate-message').textContent === 'Page 1 removed.', 'the status line');
  assert.deepEqual(await anglesOf(state.filesMap.get(name)), [90, 90]);
  $('rotate-cancel').click();
});

test('the Guide and the tour describe it', () => {
  const guide = fs.readFileSync(new URL('../layouts/_default/guide.html', import.meta.url), 'utf8');
  assert.match(guide, /<strong>Remove this page<\/strong>/);
  const tour = fs.readFileSync(new URL('../public/js/bundletoolTutorial.js', import.meta.url), 'utf8');
  assert.match(tour, /Remove this page takes out the page shown, once you confirm it\./);
});
