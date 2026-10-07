/**
 * The browser OCR module, on a page whose embedded image is over OCR_MAX_IMAGE_PIXELS.
 * pdf.js drops such an image with no signal the page can observe, which would leave the page
 * without a text layer and nothing to say so. The module finds the image from its declared size
 * before any rendering, leaves the page alone, and reports it in `skippedPages`. Runs without a canvas or an OCR
 * engine: a document whose every target page is skipped returns before either is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from '../public/js/bundletoolPdfLib.js';
import { ocrDocument } from '../public/js/frontend/bundletoolOcrDocument.js';

// The module points pdf.js at the browser's worker URL, which Node cannot import; pdf.js uses an
// already-loaded worker when one is on globalThis, so supply the same file that way.
globalThis.pdfjsWorker = await import('/vendor/pdfjs.worker.mjs');

/** One ordinary-sized page whose only content is an image DECLARED width x height (a 1-byte stream). */
async function pdfWithImage(width, height) {
  const d = await PDFDocument.create();
  const page = d.addPage([612, 792]);
  const ref = d.context.register(d.context.stream(new Uint8Array([0]), { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
  page.node.normalizedEntries().Resources.set(
    PDFName.of('XObject'), d.context.obj({ Im1: ref }),
  );
  return d.save();
}

test('a page with an over-cap image is skipped and reported, not silently left', async () => {
  const result = await ocrDocument(await pdfWithImage(10000, 10000), { force: true });
  assert.deepEqual(result, { bytes: null, ocredPages: 0, skippedPages: [1] });
});
