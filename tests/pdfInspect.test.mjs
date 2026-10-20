import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict } from '../public/js/bundletoolPdfLib.js';
import { readPdfFacts } from '../public/js/bundletoolPdfInspect.js';

async function doc(pages, size = [595, 842]) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage(size);
  return d;
}

test('page count and the longest page edge are read', async () => {
  const d = await doc(3);
  d.addPage([14400, 200]);
  const r = readPdfFacts(d);
  assert.equal(r.pages, 4);
  assert.equal(r.maxEdge, 14400);
});

test('a document with no pages reports zero pages', async () => {
  const r = readPdfFacts(await doc(0));
  assert.equal(r.pages, 0);
  assert.equal(r.maxEdge, 0);
});

test('attachments, portfolios and XFA forms are recognised', async () => {
  const d = await doc(1);
  const ctx = d.context;
  assert.deepEqual([readPdfFacts(d).attachments, readPdfFacts(d).isPortfolio, readPdfFacts(d).hasXfa], [false, false, false]);
  const names = ctx.obj({}); names.set(PDFName.of('EmbeddedFiles'), ctx.obj({}));
  d.catalog.set(PDFName.of('Names'), names);
  d.catalog.set(PDFName.of('Collection'), ctx.obj({}));
  const acro = ctx.obj({}); acro.set(PDFName.of('XFA'), ctx.obj([]));
  d.catalog.set(PDFName.of('AcroForm'), acro);
  const r = readPdfFacts(d);
  assert.deepEqual([r.attachments, r.isPortfolio, r.hasXfa], [true, true, true]);
  assert.ok(acro instanceof PDFDict);
});

test('a document whose structure cannot be read reports what it can and never throws', () => {
  const broken = { getPageCount() { throw new Error('no'); }, getPages() { throw new Error('no'); }, get catalog() { throw new Error('no'); } };
  assert.deepEqual(readPdfFacts(broken), { pages: 0, maxEdge: 0, hasXfa: false, attachments: false, isPortfolio: false });
});

import zlib from 'node:zlib';
import { PDFRawStream } from '../public/js/bundletoolPdfLib.js';
import { findExpandingStreams } from '../public/js/bundletoolPdfInspect.js';

function withStream(d, raw) {
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const dict = d.context.obj({ Filter: 'FlateDecode', Length: compressed.length });
  d.context.register(PDFRawStream.of(dict, compressed));
  return compressed.length;
}
const small = { minCompressed: 1024, perStream: 16 * 1024 * 1024, totalBudget: 64 * 1024 * 1024 };

test('a stream that unpacks to thousands of times its size is found, without being fully unpacked', async () => {
  const d = await doc(1);
  const size = withStream(d, Buffer.alloc(200 * 1024 * 1024, 0x71));   // 200 MB of one byte: about 200 KB compressed
  assert.ok(size < 300 * 1024, String(size));
  const t = Date.now();
  assert.equal(await findExpandingStreams(d, { ...small, minCompressed: 100 * 1024 }), true);
  assert.ok(Date.now() - t < 5000, 'found quickly');
});

test('ordinary compressed streams, even large ones, are not flagged', async () => {
  const d = await doc(1);
  let seed = 7; const noisy = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < noisy.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noisy[i] = (seed >> 16) & (i % 3 ? 0x0f : 0xff); }
  withStream(d, noisy);
  withStream(d, Buffer.from('BT /F1 12 Tf (ordinary text) Tj ET\n'.repeat(60000)));
  assert.equal(await findExpandingStreams(d, small), false);
});

test('a document with no large compressed streams reports nothing without doing any work', async () => {
  assert.equal(await findExpandingStreams(await doc(2)), false);
});

// ── findOversizedImagePages: the pre-scan that tells OCR a page's image is over the decode cap
import { findOversizedImagePages, findOverBudgetImagePages } from '../public/js/bundletoolPdfInspect.js';
import { OCR_MAX_IMAGE_PIXELS, OCR_MAX_PAGE_IMAGE_PIXELS } from '../public/js/bundletoolOcr.js';

/** Adds an image XObject that DECLARES width x height; its stream is one byte, so nothing is decoded. */
function addImage(d, page, key, width, height) {
  const ref = d.context.register(d.context.stream(new Uint8Array([0]), { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
  const res = page.node.normalizedEntries().Resources;
  let xo = res.lookup(PDFName.of('XObject'));
  if (!xo) { xo = d.context.obj({}); res.set(PDFName.of('XObject'), xo); }
  xo.set(PDFName.of(key), ref);
  return ref;
}

test('a page with an image over the cap is found, one under it is not', async () => {
  const d = await doc(3);
  const [, p2, p3] = d.getPages();
  addImage(d, p2, 'Im1', 10000, 10000);          // 100 Mpx: over a 90 Mpx cap
  addImage(d, p3, 'Im1', 9000, 9000);            // 81 Mpx: a real large scan, under it
  assert.deepEqual(findOversizedImagePages(d, 90_000_000), [2]);
});

test('the cap is on one image, and exactly at the cap is allowed', async () => {
  const d = await doc(1);
  addImage(d, d.getPages()[0], 'Im1', 9000, 10000); // exactly 90,000,000
  assert.deepEqual(findOversizedImagePages(d, 90_000_000), []);
  assert.deepEqual(findOversizedImagePages(d, 89_999_999), [1]);
});

test('an image inside a Form XObject is found, and a form that contains itself does not loop', async () => {
  const d = await doc(2);
  const [p1, p2] = d.getPages();
  const make = (inner) => {
    const form = d.context.stream(new Uint8Array([0]), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: d.context.obj({ XObject: d.context.obj(inner) }) });
    return d.context.register(form);
  };
  const bigImage = d.context.register(d.context.stream(new Uint8Array([0]), { Type: 'XObject', Subtype: 'Image', Width: 20000, Height: 20000 }));
  const nested = make({ ImBig: bigImage });
  const outer = make({ Inner: nested });
  p1.node.normalizedEntries().Resources.set(PDFName.of('XObject'), d.context.obj({ Fm: outer }));

  // p2: a form whose own resources name the form itself, and nothing oversized
  const selfForm = d.context.register(d.context.stream(new Uint8Array([0]), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
  d.context.lookup(selfForm).dict.set(PDFName.of('Resources'), d.context.obj({ XObject: d.context.obj({ Self: selfForm }) }));
  p2.node.normalizedEntries().Resources.set(PDFName.of('XObject'), d.context.obj({ Fm: selfForm }));

  assert.deepEqual(findOversizedImagePages(d, 90_000_000), [1]);
});

test('a document with no images, or whose structure cannot be read, reports nothing and never throws', async () => {
  assert.deepEqual(findOversizedImagePages(await doc(2), 90_000_000), []);
  assert.deepEqual(findOversizedImagePages({ getPages() { throw new Error('broken'); } }, 90_000_000), []);
});

// ── findOverBudgetImagePages: the per-page total, which the per-image cap above does not bound
const A3_600_DPI = 7016 * 9921; // 69.6 Mpx: a legitimate scan that must still be read

test('the page budget sits above every legitimate scan measured and below the shapes that cost more memory', () => {
  // Measured peak RSS (fresh processes): 88 Mpx x1 1.29 GB, 36 Mpx x8 1.45 GB, 64 Mpx x4 1.62 GB, A3 at 600 DPI 1.06 GB.
  assert.ok(OCR_MAX_PAGE_IMAGE_PIXELS >= 88_000_000, 'an 88 Mpx single image must still be read');
  assert.ok(OCR_MAX_PAGE_IMAGE_PIXELS >= A3_600_DPI);
  assert.ok(OCR_MAX_PAGE_IMAGE_PIXELS < 4 * 8000 * 8000, 'four 8000 x 8000 images on one page must be over budget');
  assert.ok(OCR_MAX_PAGE_IMAGE_PIXELS < 8 * 6000 * 6000, 'eight 6000 x 6000 images on one page must be over budget');
});

test('several images each under the per-image cap are over budget together', async () => {
  const d = await doc(3);
  const [p1, p2, p3] = d.getPages();
  for (let i = 0; i < 4; i++) addImage(d, p1, `Im${i}`, 8000, 8000);   // 4 x 64 Mpx
  for (let i = 0; i < 8; i++) addImage(d, p2, `Im${i}`, 6000, 6000);   // 8 x 36 Mpx
  addImage(d, p3, 'Im1', 9400, 9400);                                    // 88 Mpx: one image, within budget
  assert.deepEqual(findOversizedImagePages(d, OCR_MAX_IMAGE_PIXELS), [], 'none is over the per-image cap');
  assert.deepEqual(findOverBudgetImagePages(d, OCR_MAX_PAGE_IMAGE_PIXELS), [1, 2]);
});

test('A3 at 600 DPI and an 88 Mpx single image are within budget', async () => {
  const d = await doc(2);
  const [p1, p2] = d.getPages();
  addImage(d, p1, 'Im1', 7016, 9921);
  addImage(d, p2, 'Im1', 9400, 9400);
  assert.deepEqual(findOverBudgetImagePages(d, OCR_MAX_PAGE_IMAGE_PIXELS), []);
});

test('the budget is on the total, and exactly at it is allowed', async () => {
  const d = await doc(1);
  const p = d.getPages()[0];
  addImage(d, p, 'A', 5000, 6000);   // 30,000,000
  addImage(d, p, 'B', 6000, 10000);  // 60,000,000
  assert.deepEqual(findOverBudgetImagePages(d, 90_000_000), []);
  assert.deepEqual(findOverBudgetImagePages(d, 89_999_999), [1]);
});

test('images are counted whatever their filter, inside Form XObjects, with their soft masks, and a shared image once', async () => {
  const d = await doc(3);
  const [p1, p2, p3] = d.getPages();
  // JBIG2, CCITT and JPX declare /Width and /Height like any other image
  for (const [i, filter] of ['JBIG2Decode', 'CCITTFaxDecode', 'JPXDecode', 'DCTDecode'].entries()) {
    const ref = d.context.register(d.context.stream(new Uint8Array([0]), { Type: 'XObject', Subtype: 'Image', Width: 8000, Height: 8000, Filter: filter }));
    const xo = p1.node.normalizedEntries().Resources.lookup(PDFName.of('XObject')) ?? (() => { const o = d.context.obj({}); p1.node.normalizedEntries().Resources.set(PDFName.of('XObject'), o); return o; })();
    xo.set(PDFName.of(`Im${i}`), ref);
  }
  // p2: one 50 Mpx image plus a 50 Mpx soft mask
  const mask = d.context.register(d.context.stream(new Uint8Array([0]), { Type: 'XObject', Subtype: 'Image', Width: 5000, Height: 10000 }));
  const masked = d.context.register(d.context.stream(new Uint8Array([0]), { Type: 'XObject', Subtype: 'Image', Width: 5000, Height: 10000, SMask: mask }));
  p2.node.normalizedEntries().Resources.set(PDFName.of('XObject'), d.context.obj({ Im1: masked }));
  // p3: four forms that all draw the same 60 Mpx image: decoded once, so within budget
  const shared = d.context.register(d.context.stream(new Uint8Array([0]), { Type: 'XObject', Subtype: 'Image', Width: 6000, Height: 10000 }));
  const forms = {};
  for (let i = 0; i < 4; i++) {
    forms[`F${i}`] = d.context.register(d.context.stream(new Uint8Array([0]), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: d.context.obj({ XObject: d.context.obj({ Im: shared }) }) }));
  }
  p3.node.normalizedEntries().Resources.set(PDFName.of('XObject'), d.context.obj(forms));
  assert.deepEqual(findOverBudgetImagePages(d, OCR_MAX_PAGE_IMAGE_PIXELS), [1, 2]);
});

test('findOverBudgetImagePages never throws on a document it cannot read', async () => {
  assert.deepEqual(findOverBudgetImagePages({ getPages() { throw new Error('broken'); } }, 1), []);
});
