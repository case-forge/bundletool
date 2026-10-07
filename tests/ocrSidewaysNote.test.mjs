/**
 * What the Review Table shows about pages OCR found sideways or changed (frontend/ocrReorient.js): the document
 * window's "This page looks sideways." note (one of PAGE_NOTE_CHECKS in frontend/rotate.js) for a page read on its
 * side with Turn sideways scanned pages upright off, the record following a page the window removes, the changed flag
 * the Download button reads, and the OCR badge's tooltip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement } from './fakeDom.mjs';
import { doc, state, $, until, createCanvas, textPdf, openDocumentWindow } from './documentWindowHarness.mjs';
import { scanCanvas, scanPdf } from './ocrScans.mjs';
import { loadOcrRuntime } from '../scripts/cliOcrEngine.mjs';
import { ocrDocument } from '../scripts/cliOcrDocument.mjs';
import { PDFDocument } from '../public/js/bundletoolPdfLib.js';

const { sidewaysPageNote, forgetRemovedPage, noteReoriented, ocrBadgeTitle, OCR_BADGE_TITLE } = await import('../public/js/frontend/ocrReorient.js');
const { setOcrBadge } = await import('../public/js/frontend/fileRows.js');
const { changedByBundleTool } = await import('../public/js/frontend/documentDownload.js');

const record = (sideways = [], more = {}) => ({ turned: [], straightened: [], notStraightened: [], sideways, ...more });

test('the note says sideways or upside down as the page is shown, and nothing once it is turned the right way', () => {
  state.frontendInputData['n.pdf'] = { title: 'N', ocrPages: record([[2, 90, 0], [3, 180, 0], [4, 270, 90]]) };
  const note = (pageNum, rotation) => sidewaysPageNote({ filename: 'n.pdf', pageNum, rotation });
  assert.equal(note(1, 0), null, 'a page reading found upright');
  assert.equal(note(2, 0), 'This page looks sideways.');
  assert.equal(note(2, 270), null, 'turned left a quarter: upright');
  assert.equal(note(2, 90), 'This page looks upside down.', 'turned the wrong way');
  assert.equal(note(3, 0), 'This page looks upside down.');
  assert.equal(note(3, 180), null);
  // Stored at /Rotate 90 and needing a further three quarters anticlockwise: upright at 180.
  assert.equal(note(4, 90), 'This page looks sideways.', 'shown at the /Rotate it was read at');
  assert.equal(note(4, 180), null, 'turned a further quarter clockwise: upright');
  assert.equal(note(4, 0), 'This page looks upside down.');
  assert.equal(sidewaysPageNote({ filename: 'other.pdf', pageNum: 2, rotation: 0 }), null, 'no record, no note');
  delete state.frontendInputData['n.pdf'];
});

test('removing a page drops its entries and moves the pages after it up one', () => {
  state.frontendInputData['r.pdf'] = { title: 'R', ocrPages: record([[2, 90, 0], [5, 270, 0]], { turned: [[3, 90]], straightened: [[1, 2.5, 306, 396], [4, -1, 306, 396]], notStraightened: [2, 6], putBack: [2, 7] }) };
  forgetRemovedPage('r.pdf', 2);
  assert.deepEqual(state.frontendInputData['r.pdf'].ocrPages, {
    turned: [[2, 90]], straightened: [[1, 2.5, 306, 396], [3, -1, 306, 396]], notStraightened: [5], sideways: [[4, 270, 0]], putBack: [6],
  });
  forgetRemovedPage('missing.pdf', 1);
  delete state.frontendInputData['r.pdf'];
});

test('a page turned or straightened marks the document changed with the window\'s own flag, which the Download button reads', () => {
  state.frontendInputData['c.pdf'] = { title: 'C' };
  noteReoriented('c.pdf', record([[1, 90, 0]]));
  assert.equal(changedByBundleTool({ title: 'C', ocrPages: state.frontendInputData['c.pdf'].ocrPages, pagesChanged: state.frontendInputData['c.pdf'].pagesChanged }), false, 'a note changes nothing');
  noteReoriented('c.pdf', record([], { straightened: [[1, 3]] }));
  assert.equal(state.frontendInputData['c.pdf'].pagesChanged, true);
  assert.equal(changedByBundleTool({ title: 'C', pagesChanged: true }), true);
  delete state.frontendInputData['c.pdf'];
});

test('the OCR badge keeps its wording when reading changed nothing, and names the pages it turned or straightened', () => {
  assert.equal(OCR_BADGE_TITLE, 'This document\'s text is selectable and searchable (OCR applied).');
  assert.equal(ocrBadgeTitle({}), OCR_BADGE_TITLE);
  assert.equal(ocrBadgeTitle({ ocrPages: record([[2, 90, 0]]) }), OCR_BADGE_TITLE, 'a sideways note changes nothing');
  assert.equal(ocrBadgeTitle({ ocrPages: record([], { turned: [[2, 90]] }) }),
    `${OCR_BADGE_TITLE} Reading it also changed how it looks: page 2 turned upright.`);
  assert.equal(ocrBadgeTitle({ ocrPages: record([], { turned: [[1, 90], [4, 270]], straightened: [[2, 1.5], [3, -2], [5, 1], [6, 1], [7, 1], [8, 1]] }) }),
    `${OCR_BADGE_TITLE} Reading it also changed how it looks: pages 1 and 4 turned upright; 6 pages straightened.`);
});

test('a row\'s OCR badge carries that tooltip, and a later reading brings it up to date without a second badge', () => {
  const name = 'badge.pdf';
  const tr = doc.body.appendChild(new FakeElement(doc, 'tr'));
  tr.className = 'file-row';
  tr.dataset.filename = name;
  const cell = tr.appendChild(new FakeElement(doc, 'td'));
  cell.className = 'filename-cell';
  state.frontendInputData[name] = { title: 'Badge', ocrApplied: true };
  setOcrBadge(name);
  assert.equal(cell.querySelectorAll('.bt-badge-ocr').length, 1);
  assert.equal(cell.querySelector('.bt-badge-ocr').title, OCR_BADGE_TITLE);
  noteReoriented(name, record([], { turned: [[1, 270]] }));
  setOcrBadge(name);
  assert.equal(cell.querySelectorAll('.bt-badge-ocr').length, 1, 'one badge');
  assert.match(cell.querySelector('.bt-badge-ocr').title, /page 1 turned upright\.$/);
  delete state.frontendInputData[name];
});

/** Holds `bytes` as `name` with `ocrPages`, and opens the window on it. */
async function openWith(name, bytes, ocrPages, pageCount) {
  state.filesMap.set(name, new File([bytes], name, { type: 'application/pdf' }));
  state.frontendInputData[name] = { title: name, date: '', pageCount, ocrPages };
  await openDocumentWindow(name, doc.body.appendChild(new FakeElement(doc, 'button')));
  await until(() => !$('rotate-preview').classList.contains('hidden'), 'page 1 drawn');
}
const noteSettles = () => new Promise((r) => setTimeout(r, 60));

test('the window shows the note on the page found sideways, drops it once the page is turned, and follows a removed page', async (t) => {
  if (!createCanvas) { t.skip('@napi-rs/canvas is not installed: nothing is drawn'); return; }
  const bytes = await textPdf([['First page of the statement'], ['Second page of the statement'], ['Third page']]);
  await openWith('side.pdf', bytes, record([[2, 90, 0]]), 3);
  await noteSettles();
  assert.equal($('rotate-page-note').textContent, '', 'page 1: no note');
  $('rotate-next').click();
  await until(() => $('rotate-page-note').textContent === 'This page looks sideways.', 'the note on page 2');
  assert.equal($('rotate-page-note').classList.contains('hidden'), false);
  // A quarter turn left (the turn reading found) shows it upright: the note goes.
  $('rotate-left').click();
  await until(() => $('rotate-page-note').textContent === '', 'no note once turned upright');
  $('rotate-right').click();
  $('rotate-right').click();
  await until(() => $('rotate-page-note').textContent === 'This page looks upside down.', 'turned the wrong way');
  $('rotate-cancel').click();

  // Removing page 1 moves the sideways page to page 1, and its note with it.
  await openWith('side2.pdf', bytes, record([[2, 90, 0]]), 3);
  $('rotate-remove').click();
  $('rotate-remove-yes').click();
  await until(() => $('rotate-message').textContent === 'Page 1 removed.', 'page 1 removed');
  assert.deepEqual(state.frontendInputData['side2.pdf'].ocrPages.sideways, [[1, 90, 0]]);
  await until(() => $('rotate-page-note').textContent === 'This page looks sideways.', 'the note now on page 1');
  $('rotate-cancel').click();
});

test('from a real reading: a page read on its side gets the note with turning off, and none once turning on has turned it', async (t) => {
  if (!(await loadOcrRuntime()).available) { t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine'); return; }
  const scan = await scanPdf(scanCanvas({ turn: 90 }));
  // The window draws a page at its own /Rotate (plus any turn waiting); that is what the note is given.
  const shownAt = async (bytes) => (await PDFDocument.load(bytes)).getPage(0).getRotation().angle;

  const off = await ocrDocument(scan.slice(), { force: true });
  assert.deepEqual(off.reoriented.sideways, [[1, 270, 0]], 'reading found it on its side');
  state.frontendInputData['read-off.pdf'] = { title: 'Off' };
  noteReoriented('read-off.pdf', off.reoriented);
  assert.equal(sidewaysPageNote({ filename: 'read-off.pdf', pageNum: 1, rotation: await shownAt(off.bytes) }), 'This page looks sideways.');
  assert.equal(state.frontendInputData['read-off.pdf'].pagesChanged, undefined, 'nothing about the page changed');

  const on = await ocrDocument(scan.slice(), { force: true, reorient: { turnUpright: true } });
  assert.deepEqual(on.reoriented.sideways, []);
  assert.deepEqual(on.reoriented.turned, [[1, 270]]);
  state.frontendInputData['read-on.pdf'] = { title: 'On' };
  noteReoriented('read-on.pdf', on.reoriented);
  assert.equal(await shownAt(on.bytes), 90, 'shown upright by its /Rotate');
  assert.equal(sidewaysPageNote({ filename: 'read-on.pdf', pageNum: 1, rotation: await shownAt(on.bytes) }), null);
  assert.equal(state.frontendInputData['read-on.pdf'].pagesChanged, true);
  // Had turning been off, the same page shown at the new /Rotate would also say nothing: the note follows the page.
  assert.equal(sidewaysPageNote({ filename: 'read-off.pdf', pageNum: 1, rotation: await shownAt(on.bytes) }), null);
  delete state.frontendInputData['read-off.pdf'];
  delete state.frontendInputData['read-on.pdf'];
});
