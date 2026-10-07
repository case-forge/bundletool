/**
 * "This page looks blank": pageInk() in bundletoolDeskew.js, and the note line under the document window's picture
 * that shows it (PAGE_NOTE_CHECKS in frontend/rotate.js). Information only: the window never removes a page itself.
 * The threshold's calibration (the OCR benchmark corpus and blank scans) is in the comment on BLANK.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageInk, BLANK } from '../public/js/bundletoolDeskew.js';
import { createCanvas, state, $, until, open, textPdf } from './documentWindowHarness.mjs';

const { addPageNoteCheck } = await import('../public/js/frontend/rotate.js');

/** A white page, `w` x `h`, as RGBA, with `paint(set)` drawing grey levels (0 black .. 255 white) onto it. */
function page(w, h, paint = () => {}) {
  const px = new Uint8ClampedArray(w * h * 4).fill(255);
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < w && y < h) { const i = (y * w + x) * 4; px[i] = px[i + 1] = px[i + 2] = v; } };
  paint(set);
  return px;
}
const lines = (n, v, set) => {
  for (let l = 0; l < n; l++) for (let y = 120 + l * 28; y < 124 + l * 28; y++) for (let x = 90; x < 470; x += (x % 7 === 0 ? 3 : 1)) set(x, y, v);
};
let seed = 1;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

test('a white page, and one with specks scattered over it, look blank', () => {
  assert.equal(pageInk(page(560, 792), 560, 792).blank, true);
  const specks = page(560, 792, (set) => { for (let i = 0; i < 300; i++) set(Math.floor(rand() * 560), Math.floor(rand() * 792), 0); });
  const r = pageInk(specks, 560, 792);
  assert.equal(r.blank, true, `300 lone specks are not ink (${r.inkFraction})`);
});

test('a scanner edge, punch holes or a page number in the margin leave a page blank', () => {
  const edges = page(560, 792, (set) => {
    for (let y = 0; y < 792; y++) for (let x = 0; x < 30; x++) set(x, y, 40);            // a dark lid edge
    for (const cy of [250, 540]) for (let y = cy - 8; y <= cy + 8; y++) for (let x = 32; x < 48; x++) set(x, y, 30);
    for (let y = 760; y < 770; y++) for (let x = 270; x < 290; x++) set(x, y, 0);         // "12"
  });
  assert.equal(pageInk(edges, 560, 792).blank, true);
});

test('lines of text are not blank, faint (faded fax) text included; show-through as faint as paper grain is', () => {
  assert.equal(pageInk(page(560, 792, (set) => lines(12, 0, set)), 560, 792).blank, false);
  assert.equal(pageInk(page(560, 792, (set) => lines(1, 0, set)), 560, 792).blank, false, 'one line is not blank');
  assert.equal(pageInk(page(560, 792, (set) => lines(12, 190, set)), 560, 792).blank, false, 'grey text on a fax');
  assert.equal(pageInk(page(560, 792, (set) => lines(12, 245, set)), 560, 792).blank, true, 'darkness under the floor is paper');
  assert.ok(BLANK.MAX_INK > 0 && BLANK.MAX_INK < 0.001);
});

test('the window says "This page looks blank" for a blank page, and nothing for a page with text', async (t) => {
  if (!createCanvas) { t.skip('@napi-rs/canvas is not installed: nothing is drawn'); return; }
  const bytes = await textPdf([
    ['The applicant applies for an order that the respondent', 'shall return the child to the applicant forthwith.', 'Dated this day.'],
    [],
  ]);
  const { name, file } = await open('blank.pdf', bytes);
  await until(() => !$('rotate-preview').classList.contains('hidden'), 'page 1 drawn');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal($('rotate-page-note').classList.contains('hidden'), true, 'no note for a page of text');
  $('rotate-next').click();
  await until(() => $('rotate-page-note').textContent !== '', 'the note for page 2');
  assert.equal($('rotate-page-note').textContent, 'This page looks blank.');
  assert.equal($('rotate-page-note').classList.contains('hidden'), false);
  $('rotate-prev').click();
  await until(() => $('rotate-page-note').textContent === '', 'the note cleared on page 1');
  assert.equal(state.filesMap.get(name), file, 'nothing is removed or changed: the file is the very same');
  assert.equal(state.frontendInputData[name].pageCount, 2);
  $('rotate-cancel').click();
});

test('another check can add its own note to the same line, after the blank note, and one that fails says nothing', async (t) => {
  if (!createCanvas) { t.skip('@napi-rs/canvas is not installed: nothing is drawn'); return; }
  const seen = [];
  addPageNoteCheck(({ pageNum, page: pdfPage, canvas, pixels }) => {
    seen.push({ pageNum, rotate: pdfPage.rotate, width: canvas.width, pixels: pixels().data.length });
    return pageNum === 2 ? 'This page looks sideways.' : null;
  });
  addPageNoteCheck(() => { throw new Error('a check that breaks'); });
  await open('hook.pdf', await textPdf([['Some words on the first page'], []]));
  await until(() => seen.length === 1, 'the check on page 1');
  assert.equal(seen[0].pageNum, 1);
  assert.ok(seen[0].pixels > 0 && seen[0].width > 0, 'the check is given the drawn picture');
  $('rotate-next').click();
  await until(() => $('rotate-page-note').textContent.includes('sideways'), 'both notes on page 2');
  assert.equal($('rotate-page-note').textContent, 'This page looks blank. This page looks sideways.');
  $('rotate-cancel').click();
});
