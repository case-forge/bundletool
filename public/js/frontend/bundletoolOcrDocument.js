/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolOcrDocument.js
 * Runs OCR over one whole document: which pages need it (or all of them,
 * for "Force OCR"), rendering each to an offscreen raster, recognising it,
 * and embedding the invisible text layer. This is the one place those three
 * pieces (pdf.js for the text check and rasterising, bundletoolOcrEngine.js
 * for recognition, bundletoolOcr.js for the geometry) are wired together.
 * Both the automatic per-file check on add (fileProcessing.js) and the manual
 * Force OCR button (ocrForce.js) call exactly this, so neither keeps its own
 * copy of the per-page loop.
 *
 * No dialog, no visible canvas: this runs in the background against an
 * OffscreenCanvas, the same way autosave and validation run without asking
 * to be watched.
 */
import { StandardFonts } from '../bundletoolPdfLib.js';
import { lazyImport } from '/js/shared/lazy-load.js';
import { loadPdf } from '../bundletoolPdfLoad.js';
import { needsOcr, replaceOcrLayer, OCR_RASTER_DPI, OCR_MAX_IMAGE_PIXELS, OCR_MIN_CHARS } from '../bundletoolOcr.js';
import { findOversizedImagePages } from '../bundletoolPdfInspect.js';
import { ocrSession } from '../bundletoolOcrEngine.js';
import { readUpright, displayTurn } from '../bundletoolDeskew.js';
import { visibleText, withoutPrintedText } from '../bundletoolOcrPrinted.js';
import { reorientPage, reorientSettings, reorientRecord, recordReorient } from '../bundletoolOcrReorient.js';

let _pdfjsLib = null;
async function loadPdfjs() {
  if (!_pdfjsLib) {
    _pdfjsLib = await lazyImport('/vendor/pdfjs.mjs');
    _pdfjsLib.GlobalWorkerOptions.workerSrc = '/bundletool/js/pdfjs.worker.mjs';
  }
  return _pdfjsLib;
}

/** Renders one pdf.js page to an OffscreenCanvas at OCR_RASTER_DPI, ignoring the page's own
 * rotation (see bundletoolOcr.js's embedOcrLayer comment for why: pixel space must map 1:1 onto
 * the page's own unrotated MediaBox space). */
async function rasterizePageForOcr(pdfjsPage) {
  const scale = OCR_RASTER_DPI / 72;
  const viewport = pdfjsPage.getViewport({ scale, rotation: 0 });
  const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  await pdfjsPage.render({ canvasContext: ctx, viewport, background: 'white' }).promise;
  return canvas.transferToImageBitmap();
}

/** The largest tilted canvas, in pixels: the largest canvas iOS Safari will draw (4096 x 4096). A page levelled into
 * a larger canvas than that is scaled down to fit (bundletoolDeskew.js's uprightGeometry); a page that is not
 * tilted is read at the size it was rasterised. */
const UPRIGHT_MAX_PIXELS = 16_777_216;

/**
 * The pixel work bundletoolDeskew.js's readUpright() needs, on canvases: the pixels to measure, an image
 * rotated into the tilted canvas, a quarter turn, and an image's pixels and regions for the second look at print the
 * engine passed over. Angles are counter-clockwise, as the module reports them; a
 * canvas turns clockwise, hence the signs. Every bitmap made here is closed by `close()`.
 */
function uprightCanvases() {
  const made = [];
  const keep = (canvas) => { const b = canvas.transferToImageBitmap(); made.push(b); return b; };
  return {
    // The full raster, so the estimate shrinks it by averaging, exactly as the command line does: a canvas scaled
    // down to a quarter samples rather than averages, and on the benchmark that puts some pages on the other side
    // of DESKEW.APPLY_MIN from the command line.
    async sample(image) {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { data: pixels.data, width: pixels.width, height: pixels.height };
    },
    async tilt(image, angle, g) {
      const canvas = new OffscreenCanvas(g.tiltWidth, g.tiltHeight);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((-angle * Math.PI) / 180);
      ctx.scale(g.scale, g.scale);
      ctx.drawImage(image, -image.width / 2, -image.height / 2);
      return keep(canvas);
    },
    async turn(image, turn, size) {
      const canvas = new OffscreenCanvas(size.width, size.height);
      const ctx = canvas.getContext('2d');
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((-turn * Math.PI) / 180);
      ctx.drawImage(image, -image.width / 2, -image.height / 2);
      return keep(canvas);
    },
    async pixels(image) {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    },
    async crop(image, box) {
      const canvas = new OffscreenCanvas(box.x1 - box.x0, box.y1 - box.y0);
      canvas.getContext('2d').drawImage(image, box.x0, box.y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      return keep(canvas);
    },
    close() { for (const b of made) b.close?.(); },
  };
}

/** The document opened by pdf.js for reading: the one place this file opens one, capped like every OCR open. */
async function openForOcr(bytes) {
  const pdfjsLib = await loadPdfjs();
  const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false, maxImageSize: OCR_MAX_IMAGE_PIXELS });
  return { pdfjsLib, loadingTask, pdfjsDoc: await loadingTask.promise };
}

/** The 1-based pages that need reading, decided from pdf.js's own text layer: every page when `force` is set. */
async function findTargets(pdfjsDoc, force) {
  const targets = [];
  for (let i = 1; i <= pdfjsDoc.numPages; i++) {
    const page = await pdfjsDoc.getPage(i);
    const content = await page.getTextContent();
    if (force || needsOcr(content.items)) targets.push(i);
    page.cleanup();
  }
  return targets;
}

/**
 * Which pages of a document need reading, without loading the OCR engine or reading anything: the same check
 * ocrDocument() starts with. The automatic check (ocrAuto.js) runs this as soon as a document is added, so the page
 * knows how many pages are waiting to be read before the reading starts, and passes the answer back in as `targets`.
 *
 * @param {Uint8Array} bytes
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<number[]>} 1-based page numbers, empty when nothing needs reading
 */
export async function pagesToRead(bytes, { force = false } = {}) {
  const { loadingTask, pdfjsDoc } = await openForOcr(bytes);
  try {
    return await findTargets(pdfjsDoc, force);
  } finally {
    await loadingTask.destroy();
  }
}

/** Raised when the reading of a document is stopped through its AbortSignal (Skip, or the document was removed). */
export class OcrStopped extends Error {
  constructor() { super('Reading was stopped'); this.name = 'OcrStopped'; }
}

/**
 * Rejects with OcrStopped as soon as `signal` aborts, so a page that is part way through being read is let go at once
 * instead of being waited for. The engine itself is stopped by the caller's finally block (the session's destroy()
 * ends its worker), which is what frees the CPU.
 */
function whenStopped(signal) {
  if (!signal) return { promise: new Promise(() => {}), release: () => {} };
  let onAbort;
  const promise = new Promise((_, reject) => {
    onAbort = () => reject(new OcrStopped());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  promise.catch(() => {});
  return { promise, release: () => signal.removeEventListener('abort', onAbort) };
}

/**
 * @param {Uint8Array} bytes - the document's current bytes
 * @param {{force?: boolean, targets?: number[], signal?: AbortSignal, onStart?: (total: number) => void,
 *   onPage?: (index: number, total: number) => void,
 *   reorient?: {turnUpright?: boolean, straighten?: boolean, keepAsScanned?: number[]}}} [opts]
 *   force: OCR every page, ignoring needsOcr()'s own check. targets: the pages to read, from an earlier
 *   pagesToRead() on these same bytes, so the check is not run twice. signal: stops the reading (rejects with
 *   OcrStopped, and nothing is written). onStart: told how many pages will be read, once the engine is ready and
 *   before the first page; onPage after each one. reorient: the two settings that turn a sideways scanned
 *   page upright and straighten a tilted one (bundletoolOcrReorient.js); both off unless given. keepAsScanned: pages
 *   the person put back as scanned, never straightened again.
 * @returns {Promise<{bytes: Uint8Array|null, ocredPages: number, skippedPages: number[],
 *   reoriented?: ReturnType<import('../bundletoolOcrReorient.js').reorientRecord>}|null>} null if
 *   nothing needed OCR. `bytes` is null when pages needed it but none could be done (the caller leaves
 *   the file exactly as it was rather than resave an unchanged document). `skippedPages` are the 1-based
 *   pages left unread because an embedded image is over OCR_MAX_IMAGE_PIXELS: pdf.js drops such an image
 *   with no signal the page can observe, so they are found up front from the images' declared sizes.
 *   `reoriented`, present once pages have been read, says which pages were turned or straightened, which were left
 *   tilted for their annotations, and which were read on their side with turning off.
 */
export async function ocrDocument(bytes, { force = false, targets: given, signal, onStart, onPage, reorient } = {}) {
  if (signal?.aborted) throw new OcrStopped();
  const settings = reorientSettings(reorient);
  const reoriented = reorientRecord();
  const { pdfjsLib, loadingTask, pdfjsDoc } = await openForOcr(bytes);

  // Which pages actually need work, decided from pdf.js's own text layer before any OCR engine
  // is even loaded: a document that is already fully text costs nothing beyond this check. Pages
  // given by an earlier check of these bytes are taken as they are, within the document's length.
  const targets = Array.isArray(given)
    ? given.filter((n) => Number.isInteger(n) && n >= 1 && n <= pdfjsDoc.numPages)
    : await findTargets(pdfjsDoc, force);
  if (targets.length === 0) {
    await loadingTask.destroy();
    return null;
  }

  const { doc: pdfLibDoc } = await loadPdf(bytes);
  const font = await pdfLibDoc.embedFont(StandardFonts.Helvetica);
  const pdfLibPages = pdfLibDoc.getPages();

  const tooLarge = new Set(findOversizedImagePages(pdfLibDoc, OCR_MAX_IMAGE_PIXELS));
  const skippedPages = targets.filter((n) => tooLarge.has(n));
  const toRead = targets.filter((n) => !tooLarge.has(n));
  if (toRead.length === 0) {
    await loadingTask.destroy();
    return { bytes: null, ocredPages: 0, skippedPages };
  }

  const stopped = whenStopped(signal);
  let session;
  try {
    session = await Promise.race([ocrSession(), stopped.promise]);
  } catch (err) {
    stopped.release();
    await loadingTask.destroy();
    throw err;
  }
  try {
    onStart?.(toRead.length);
    let done = 0;
    for (const pageNumber of toRead) {
      if (signal?.aborted) throw new OcrStopped();
      await Promise.race([readOnePage(pageNumber), stopped.promise]);
      done++;
      onPage?.(done, toRead.length);
    }
  } finally {
    stopped.release();
    await session.destroy();
    await loadingTask.destroy();
  }

  return { bytes: await pdfLibDoc.save(), ocredPages: toRead.length, skippedPages, reoriented };

  async function readOnePage(pageNumber) {
    const pdfjsPage = await pdfjsDoc.getPage(pageNumber);
    const raster = await rasterizePageForOcr(pdfjsPage);
    // Where the page already has visible text, in the raster's pixels: the words read there are left out
    // (bundletoolOcrPrinted.js). Read before the page is cleaned up, while pdf.js still holds what it drew.
    const printed = await visibleText(pdfjsPage, pdfjsPage.getViewport({ scale: OCR_RASTER_DPI / 72, rotation: 0 }), pdfjsLib.OPS);
    const pageTurn = displayTurn(pdfjsPage.rotate);
    pdfjsPage.cleanup();
    // The page is turned upright before it is read: first by its own /Rotate, then as its pixels say
    // (bundletoolDeskew.js says why and when). The words come back in the upright image's pixels, and toRaw takes
    // the text layer back onto the page in its own unrotated space.
    const pixels = uprightCanvases();
    const size = { width: raster.width, height: raster.height };
    let read;
    try {
      read = await readUpright(raster, { ...size, dpi: OCR_RASTER_DPI }, session, pixels, { maxPixels: UPRIGHT_MAX_PIXELS, pageTurn });
    } finally {
      pixels.close();
      raster.close?.();
    }
    const pdfLibPage = pdfLibPages[pageNumber - 1];
    // Only what is not already text: the page's own visible text is not read a second time.
    const words = withoutPrintedText(read.words, printed.boxes, read.toRaw);
    if (pdfLibPage && words.length) {
      // Turned upright or straightened only when a setting asks for it, and only a scanned page: one with visible
      // text of its own is left as it is (bundletoolOcrReorient.js).
      const { plan, layer } = reorientPage(pdfLibPage, read, settings, { ownText: printed.chars >= OCR_MIN_CHARS, raster: size, dpi: OCR_RASTER_DPI, pageNumber });
      replaceOcrLayer(pdfLibPage, font, words, OCR_RASTER_DPI, layer);
      recordReorient(reoriented, pageNumber, plan);
    }
  }
}
