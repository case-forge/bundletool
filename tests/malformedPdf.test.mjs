import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from '../public/js/bundletoolPdfLib.js';
import { countPagesTolerantly, loadPdf } from '../public/js/bundletoolPdfLoad.js';
import { pageGeometry } from '../public/js/bundletoolFooter.js';

async function doc(pages) {
  const d = await PDFDocument.create();
  const font = await d.embedFont('Helvetica');
  // A page with some ink: an empty page is reported as 'missing content', which is a different kind of damage.
  for (let i = 0; i < pages; i++) d.addPage([595, 842]).drawText(`page ${i + 1}`, { x: 50, y: 700, size: 12, font });
  return d;
}

// Ways pdf-lib's page counting can fail on a malformed page tree, by breaking the method itself.
function breakCount(d) { d.getPageCount = () => { throw new Error('bad page tree'); }; return d; }
function breakBoth(d) { breakCount(d); d.getPages = () => { throw new Error('bad page list'); }; return d; }

test('an ordinary document is counted without a fallback', async () => {
  assert.deepEqual(countPagesTolerantly(await doc(3)), { count: 3, viaFallback: false });
});

test('a failed page count falls back to the page list and says so', async () => {
  const d = breakCount(await doc(4));
  assert.deepEqual(countPagesTolerantly(d), { count: 4, viaFallback: true });
});

test('a failed page list falls back to counting the page objects', async () => {
  const d = breakBoth(await doc(5));
  assert.deepEqual(countPagesTolerantly(d), { count: 5, viaFallback: true });
});

test('when nothing can be counted the answer is zero, flagged as a fallback', async () => {
  const d = breakBoth(await doc(2));
  d.context.enumerateIndirectObjects = () => { throw new Error('no objects'); };
  assert.deepEqual(countPagesTolerantly(d), { count: 0, viaFallback: true });
});

test('a document with no pages is zero without a fallback (an empty file is not a malformed one)', async () => {
  assert.deepEqual(countPagesTolerantly(await doc(0)), { count: 0, viaFallback: false });
});

test('a sound PDF still loads as undamaged', async () => {
  const bytes = await (await doc(2)).save();
  const r = await loadPdf(bytes);
  assert.equal(r.pageCount, 2);
  assert.equal(r.damaged, false);
});

test('a page whose size is readable keeps its own CropBox and rotation', async () => {
  const d = await doc(1);
  const page = d.getPage(0);
  page.setCropBox(10, 20, 300, 400);
  const g = pageGeometry(page);
  assert.deepEqual([g.x, g.y, g.width, g.height, g.rotation], [10, 20, 300, 400, 0]);
});

test('a page whose size cannot be read gets A4 with no rotation, not a thrown error', async () => {
  const page = (await doc(1)).getPage(0);
  page.getCropBox = () => { throw new Error('bad mediabox'); };
  assert.deepEqual(pageGeometry(page), { x: 0, y: 0, width: 595.28, height: 841.89, rotation: 0 });
});

test('a page box with a non-number is treated as unreadable', async () => {
  const page = (await doc(1)).getPage(0);
  page.getCropBox = () => ({ x: 0, y: 0, width: NaN, height: 842 });
  assert.equal(pageGeometry(page).width, 595.28);
});
