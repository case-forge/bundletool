/**
 * removePdfPages (bundletoolPages.js): the page goes from the file, not only from its page list; a document keeps at
 * least one page; the pages kept are untouched, and an OCR text layer on them stays over the printed words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removePdfPages } from '../public/js/bundletoolPages.js';
import { copyDocumentPages } from '../public/js/bundletoolPdfSafety.js';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFStream, StandardFonts, decodePDFRawStream, PDFRawStream } from '../public/js/bundletoolPdfLib.js';
import { embedOcrLayer, OCR_RASTER_DPI } from '../public/js/bundletoolOcr.js';
import { makePdf } from './fixtures.mjs';

const A4 = [595.28, 841.89];

/** A stream's bytes as text, decoded when it is filtered. */
function streamText(obj) {
  if (!(obj instanceof PDFStream)) return '';
  const filtered = obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Filter'));
  return Buffer.from(filtered ? decodePDFRawStream(obj).decode() : obj.getContents()).toString('latin1');
}

/** Every stream's decoded text in the file, and every object's tag, with which of them are reachable. */
async function inside(bytes) {
  const doc = await PDFDocument.load(bytes);
  const texts = [];
  const all = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    // The object stream and cross-reference stream the file is stored in are how it is written, not what it says.
    const type = obj instanceof PDFStream ? obj.dict.get(PDFName.of('Type')) : null;
    if (type === PDFName.of('ObjStm') || type === PDFName.of('XRef')) continue;
    all.push(ref.tag);
    texts.push(streamText(obj));
  }
  const seen = new Set();
  const stack = [];
  const take = (v) => {
    if (v instanceof PDFRef) { if (!seen.has(v.tag)) { seen.add(v.tag); stack.push(v); } }
    else if (v instanceof PDFStream) take(v.dict);
    else if (v instanceof PDFDict) for (const [, x] of v.entries()) take(x);
    else if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) take(v.get(i));
  };
  take(doc.context.trailerInfo.Root);
  take(doc.context.trailerInfo.Info);
  while (stack.length) take(doc.context.lookup(stack.pop()));
  const pageObjects = all.filter((tag) => doc.context.lookup(PDFRef.of(...tag.split(' ').slice(0, 2).map(Number)))?.get?.(PDFName.of('Type')) === PDFName.of('Page'));
  return { doc, text: texts.join('\n'), orphans: all.filter((t) => !seen.has(t)), pageObjects };
}
const hex = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
const hasText = (blob, s) => blob.includes(s) || blob.toUpperCase().includes(hex(s));

test('the chosen page is removed and the others keep their content and rotation', async () => {
  const start = await makePdf(4, 'KEEP', { rotations: [0, 90, 0, 270] });
  const out = await removePdfPages(start, [1]);
  const before = await PDFDocument.load(start);
  const after = await PDFDocument.load(out);
  assert.equal(after.getPageCount(), 3);
  assert.deepEqual(after.getPages().map((p) => p.getRotation().angle), [0, 0, 270]);
  const stream = (doc, i) => streamText(doc.context.lookup(doc.getPage(i).node.get(PDFName.of('Contents'))));
  assert.equal(stream(after, 0), stream(before, 0));
  assert.equal(stream(after, 1), stream(before, 2));
  assert.equal(stream(after, 2), stream(before, 3));
});

test('what was on a removed page cannot be read back out of the file: no page object, content or other object is left behind', async () => {
  const start = await makePdf(3, 'SECRET');
  assert.ok(hasText((await inside(start)).text, 'SECRET page 2'), 'the search finds the words while the page is there');
  const out = await removePdfPages(start, [1]);
  const { doc, text, orphans, pageObjects } = await inside(out);
  assert.equal(doc.getPageCount(), 2);
  assert.ok(hasText(text, 'SECRET page 1') && hasText(text, 'SECRET page 3'), 'the kept pages are there');
  assert.equal(hasText(text, 'SECRET page 2'), false, 'the removed page\'s words are nowhere in the file');
  assert.equal(pageObjects.length, 2, 'only the kept pages are page objects');
  assert.deepEqual(orphans, [], 'every object left is reachable');
});

test('a link or bookmark that pointed at a removed page points at nothing, and the document still goes into a bundle', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const n of [1, 2, 3]) doc.addPage(A4).drawText(`LINKED page ${n}`, { x: 60, y: 700, size: 20, font });
  const target = doc.getPage(1).ref;
  const link = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 690, 300, 720], Border: [0, 0, 0], Dest: [target, PDFName.of('Fit')] });
  doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]));
  const item = doc.context.register(doc.context.obj({ Title: PDFName.of('X'), Dest: [target, PDFName.of('Fit')] }));
  doc.catalog.set(PDFName.of('Outlines'), doc.context.register(doc.context.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 })));
  const out = await removePdfPages(await doc.save(), [1]);
  const { text, orphans, pageObjects } = await inside(out);
  assert.equal(hasText(text, 'LINKED page 2'), false);
  assert.equal(pageObjects.length, 2);
  assert.deepEqual(orphans, []);
  const bundle = await PDFDocument.create();
  assert.equal(await copyDocumentPages(bundle, await PDFDocument.load(out)), 2, 'the merge takes both kept pages');
  const saved = await PDFDocument.load(await bundle.save());
  assert.equal(saved.getPageCount(), 2);
});

test('a document keeps at least one page, and only pages it has can be removed', async () => {
  const two = await makePdf(2);
  await assert.rejects(removePdfPages(two, [0, 1]), /at least one page/);
  await assert.rejects(removePdfPages(await makePdf(1), [0]), /at least one page/);
  await assert.rejects(removePdfPages(two, [2]), /no page 3/);
  await assert.rejects(removePdfPages(two, [-1]), /no page 0/);
  await assert.rejects(removePdfPages(two, []), /No page was chosen/);
  assert.equal((await PDFDocument.load(await removePdfPages(await makePdf(4), [3, 0, 3]))).getPageCount(), 2, 'a repeated page is removed once');
});

test('the OCR layer on the pages kept stays over their printed words', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const px = (pt) => (pt * OCR_RASTER_DPI) / 72;
  for (const word of ['FIRST', 'SECOND', 'THIRD']) {
    const page = doc.addPage(A4);
    page.drawText(word, { x: 100, y: 600, size: 20, font });
    const w = font.widthOfTextAtSize(word, 20);
    embedOcrLayer(page, font, [{ text: word, x0: px(100), y0: px(A4[1] - (600 + 20 * 0.72)), x1: px(100 + w), y1: px(A4[1] - 600) }], OCR_RASTER_DPI);
  }
  const before = await doc.save();
  const after = await removePdfPages(before, [1]);

  const pdfjs = await import('/vendor/pdfjs.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  async function words(bytes) {
    const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
    const out = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      out.push((await page.getTextContent()).items.filter((i) => i.str.trim()).map((i) => {
        const m = pdfjs.Util.transform(viewport.transform, i.transform);
        return { str: i.str, x: m[4], y: m[5] };
      }));
    }
    await pdf.destroy();
    return out;
  }
  const kept = await words(after);
  const original = await words(before);
  assert.deepEqual(kept.map((p) => p.map((w) => w.str)), [['FIRST', 'FIRST'], ['THIRD', 'THIRD']], 'each kept page holds its printed word and its OCR copy');
  assert.deepEqual(kept, [original[0], original[2]], 'in exactly the places they had');
  for (const [printed, layer] of kept) assert.ok(Math.hypot(printed.x - layer.x, printed.y - layer.y) < 12);
});
