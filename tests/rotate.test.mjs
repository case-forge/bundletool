import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { rotatePdfBytes } from '../public/js/bundletoolPages.js';
import { makePdf } from './fixtures.mjs';

const anglesOf = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getRotation().angle);

test('turning right adds 90 to every page and keeps the page count', async () => {
  const out = await rotatePdfBytes(await makePdf(3, 'ROT'), 90);
  assert.deepEqual(await anglesOf(out), [90, 90, 90]);
});

test('turns add up modulo 360, and right then left returns to the start', async () => {
  const start = await makePdf(2, 'ROT');
  const twice = await rotatePdfBytes(await rotatePdfBytes(start, 90), 90);
  assert.deepEqual(await anglesOf(twice), [180, 180]);
  const round = await rotatePdfBytes(await rotatePdfBytes(start, 90), -90);
  assert.deepEqual(await anglesOf(round), [0, 0]);
  const full = await rotatePdfBytes(start, 360);
  assert.deepEqual(await anglesOf(full), [0, 0]);
  const left = await rotatePdfBytes(start, -90);
  assert.deepEqual(await anglesOf(left), [270, 270]);
});

test('a page that already has a rotation is turned from it, page by page', async () => {
  const start = await makePdf(3, 'ROT', { rotations: [0, 90, 270] });
  const out = await rotatePdfBytes(start, 90);
  assert.deepEqual(await anglesOf(out), [90, 180, 0]);
});

test('page content and size are untouched', async () => {
  const start = await makePdf(2, 'KEEP');
  const before = await PDFDocument.load(start);
  const out = await PDFDocument.load(await rotatePdfBytes(start, 90));
  assert.equal(out.getPageCount(), 2);
  assert.deepEqual(out.getPage(0).getSize(), before.getPage(0).getSize());
  // The text is still in the page's content stream, only /Rotate changed.
  const contents = out.getPage(0).node.Contents();
  assert.ok(contents, 'page still has its content stream');
});

test('anything but a multiple of 90 is refused', async () => {
  await assert.rejects(rotatePdfBytes(await makePdf(1), 45), /multiple of 90/);
  await assert.rejects(rotatePdfBytes(await makePdf(1), 90.5), /multiple of 90/);
});

// ── One page, not the whole document ────────────────────────────────────────────

/** Each page's own /Rotate entry as written in the file ('' when the page has none), and its content stream. */
async function pageEntries(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => ({
    rotate: p.node.get(PDFName.of('Rotate'))?.toString() ?? '',
    contents: Buffer.from(p.node.Contents()?.getContents?.() ?? []).toString('latin1'),
  }));
}

test('given a list of pages, only those pages turn; every other page keeps its /Rotate entry exactly', async () => {
  const start = await makePdf(4, 'ONE', { rotations: [0, 90, 270, 180] });
  const out = await rotatePdfBytes(start, 90, [1]);
  assert.deepEqual(await anglesOf(out), [0, 180, 270, 180]);
  const before = await pageEntries(start);
  const after = await pageEntries(out);
  for (const i of [0, 2, 3]) assert.equal(after[i].rotate, before[i].rotate, `page ${i + 1}'s /Rotate is untouched`);
  for (const i of [0, 1, 2, 3]) assert.equal(after[i].contents, before[i].contents, `page ${i + 1}'s content is untouched`);
  const plain = await makePdf(2, 'ONE');
  const turned = await pageEntries(await rotatePdfBytes(plain, 270, [0]));
  assert.equal(turned[1].rotate, (await pageEntries(plain))[1].rotate, 'a page with no /Rotate of its own is left without one, or as it was');
});

test('the list may come in any order and repeat a page; each page turns once; a page the document lacks is refused', async () => {
  const start = await makePdf(3, 'ORD');
  assert.deepEqual(await anglesOf(await rotatePdfBytes(start, 90, [2, 0, 2])), [90, 0, 90]);
  assert.deepEqual(await anglesOf(await rotatePdfBytes(start, 90, [])), [0, 0, 0], 'an empty list turns nothing');
  assert.deepEqual(await anglesOf(await rotatePdfBytes(start, 90)), [90, 90, 90], 'no list is every page, as before');
  await assert.rejects(rotatePdfBytes(start, 90, [3]), /no page 4/);
  await assert.rejects(rotatePdfBytes(start, 90, [-1]), /no page 0/);
  await assert.rejects(rotatePdfBytes(start, 90, [1.5]), /no page/);
});

test('the OCR text layer on a turned page turns with it: the invisible words stay over the printed ones', async () => {
  const { embedOcrLayer, OCR_RASTER_DPI } = await import('../public/js/bundletoolOcr.js');
  // The layer is drawn with the app's own copy of the PDF library, so the page is made with it too.
  const lib = await import('../public/js/bundletoolPdfLib.js');
  const doc = await lib.PDFDocument.create();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  const size = [595.28, 841.89];
  const px = (pt) => (pt * OCR_RASTER_DPI) / 72;
  for (let n = 0; n < 2; n++) {
    const page = doc.addPage(size);
    // The printed word, and the OCR layer's copy of it in the raster's pixels (top-left origin), over the same box.
    page.drawText('HEARING', { x: 100, y: 600, size: 20, font });
    const w = font.widthOfTextAtSize('HEARING', 20);
    const top = size[1] - (600 + 20 * 0.72);
    embedOcrLayer(page, font, [{ text: 'HEARING', x0: px(100), y0: px(top), x1: px(100 + w), y1: px(size[1] - 600) }], OCR_RASTER_DPI);
  }
  const before = await doc.save();
  const after = await rotatePdfBytes(before, 90, [1]);

  const pdfjs = await import('/vendor/pdfjs.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  /** Where each "HEARING" starts on the page as it is shown: the printed word, then the layer's. */
  async function shown(bytes, pageNumber) {
    const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const items = (await page.getTextContent()).items.filter((i) => i.str.includes('HEARING'));
    const at = items.map((i) => { const m = pdfjs.Util.transform(viewport.transform, i.transform); return { x: m[4], y: m[5] }; });
    await pdf.destroy();
    return { rotate: viewport.rotation, width: viewport.width, at };
  }
  const turned = await shown(after, 2);
  const still = await shown(after, 1);
  assert.equal(turned.rotate, 90);
  assert.equal(still.rotate, 0);
  assert.ok(turned.width > 800, 'page 2 is shown on its side');
  for (const view of [turned, still]) {
    assert.equal(view.at.length, 2, 'the printed word and its OCR copy');
    const [printed, layer] = view.at;
    const gap = Math.hypot(printed.x - layer.x, printed.y - layer.y);
    assert.ok(gap < 12, `the layer's word starts within ${gap.toFixed(1)}pt of the printed one`);
  }
  // On the turned page the word now runs down the page: it moved, and the layer moved with it.
  const unturned = await shown(before, 2);
  assert.ok(Math.hypot(turned.at[0].x - unturned.at[0].x, turned.at[0].y - unturned.at[0].y) > 100, 'the printed word moved with the turn');
});
