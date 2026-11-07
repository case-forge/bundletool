/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * cliOcrDocument.mjs
 * The Node equivalent of public/js/frontend/bundletoolOcrDocument.js: runs
 * OCR over one whole document for the command line, the same way the
 * browser does for the page: which pages need it (or all of them, for a
 * file's own "forceOcr"), rendering each to a raster, recognising it, and
 * embedding the invisible text layer. needsOcr(), embedOcrLayer() and
 * OCR_RASTER_DPI are the browser's own, imported unchanged: the geometry and
 * the threshold have exactly one definition, not a second copy that could
 * drift from it.
 *
 * Differences from the browser orchestrator, each forced by Node having no
 * DOM, or by running as a long-lived, unattended process over documents of
 * a size and shape nobody is watching page by page:
 *
 *   RASTERISING. The browser draws to an OffscreenCanvas; Node has none, so
 *   @napi-rs/canvas stands in. pdf.js's own bundle (static/vendor/pdfjs.mjs,
 *   the exact file the browser serves, loaded here the same way through
 *   node-compat-resolve.mjs's "/vendor/" mapping) carries a HARDCODED
 *   internal NodeCanvasFactory that expects the classic `canvas` package
 *   (node-canvas) and throws if left to its own auto-detection, even though
 *   the canvas actually handed to page.render() is supplied separately and
 *   correctly. A custom canvasFactory MUST be passed to getDocument() itself
 *   (not only used for the render() canvas), or pdf.js's own internal canvas
 *   need, unrelated to the one page being rendered, fails: without it pdf.js's
 *   NodeCanvasFactory throws "Cannot read properties of undefined (reading
 *   'createCanvas')", every time.
 *
 *   ONE pdf.js DOCUMENT, NOT TWO. getDocument() needs a canvasFactory
 *   available from the start (the point above), but the real one
 *   (@napi-rs/canvas's createCanvas) is only known once the OCR runtime has
 *   been loaded, which in turn only happens once the text-layer probe below
 *   has decided OCR is actually needed, which needs a document already
 *   open. Resolved with one mutable closure variable: the SAME canvasFactory
 *   object is handed to getDocument() up front, but its create() method
 *   reads realCreateCanvas, assigned only once the runtime has loaded and
 *   well before create() is ever actually called (pdf.js only calls it
 *   inside page.render(), which this module does not reach until after that
 *   assignment). One document, one parse of the PDF's structure, for both
 *   the probe and the render pass.
 *
 *   THE BUFFER IS NOT REUSABLE AFTER getDocument(). Node's pdf.js detaches
 *   the ArrayBuffer backing whatever Uint8Array is handed to getDocument()'s
 *   `data`: byteLength reads 0 afterwards. A bare `bytes` (not
 *   `bytes.slice()`) would therefore also detach the ORIGINAL buffer this
 *   function was handed, breaking the separate @cantoo/pdf-lib parse
 *   (loadPdf(bytes), below) that still needs it. So pdf.js gets one copy,
 *   made once for the single document above.
 *
 *   FEEDING THE OCR ENGINE. The browser passes an ImageBitmap; the Node
 *   engine (cliOcrEngine.mjs) takes a plain {data, width, height} object
 *   instead, because @napi-rs/canvas's own ImageData has width/height as
 *   PROTOTYPE GETTERS, not own enumerable properties, and tesseract-wasm's
 *   OCRClient crosses a real node:worker_threads/comlink boundary (a
 *   structured-clone-style marshal that only carries own properties) to
 *   reach the worker that actually does the recognising. Passing the
 *   ImageData object straight through silently loses width/height on the
 *   worker side, which surfaces as a WASM-level "Error in pixCreateHeader:
 *   width must be > 0" followed by a plain RangeError, not a clean, nameable
 *   JS error. Reshaping into { data: raw.data, width: raw.width, height:
 *   raw.height } here, once, covers every caller.
 *
 *   A VERY LARGE PAGE. OCR_MAX_PIXELS caps the raster area well under the
 *   100-million-pixel ceiling bundletoolImages.js's own photo-embedding path
 *   uses for a different reason: this runs unattended, possibly in a
 *   container with real, fixed memory headroom and nobody watching, so the
 *   bound is set for that container's sake, not just to avoid one browser
 *   tab running out of memory. A page past even the scaled-down floor fails
 *   that one page's OCR cleanly rather than rasterising it at all.
 *
 *   TWO PASSES. The browser keeps one pdf-lib document open while it reads
 *   the pages; here that would hold three whole-file copies through the
 *   whole page loop, beside the OCR engine's own memory: the caller's bytes,
 *   pdf.js's copy and pdf-lib's parse (it copies every stream), with the
 *   saved output a fourth at the end. So the work runs in two passes. Pass 1
 *   opens the file with pdf.js only, recognises every target page and keeps each page's words
 *   (a small array per page, never its raster). Then pdf.js and the OCR
 *   engine are closed, and pass 2 opens the file with pdf-lib, draws each
 *   page's text layer and saves. pdf.js's copy and pdf-lib's are never
 *   alive together, and pdf-lib's parse and output never sit beside the OCR
 *   engine. Pages are read in the same order, with the same per-page
 *   failures, and the same text lands on the same pages. A file pdf-lib
 *   cannot open is still reported as 'failed'; it is found after the pages
 *   have been read rather than before, which only matters for a file that
 *   pdf.js opens and pdf-lib does not (build-cli.mjs has already opened
 *   every file with pdf-lib before it gets here).
 *
 *   THE CALLER'S COPY. Once OCR has replaced a file's bytes, the original
 *   and pass 2's pdf-lib parse are garbage, but the garbage collector
 *   decides when they are freed, and it often has not freed them by the time
 *   the bundle build parses the OCR'd file again. That build would then be
 *   the peak, and the two passes would save nothing at large sizes.
 *   releaseBytes() (below) lets build-cli.mjs free the original at once
 *   instead; the two passes and the early release only pay off together.
 *
 *   ONE FAILED PAGE DOES NOT STOP THE REST OF THE FILE. A page that fails to
 *   rasterise or recognise is skipped: OCR continues independently on every
 *   other target page in the same file, each one's own success or failure
 *   unaffected by any other's. Pages that are good, too large, then good
 *   again still give the third page its own text layer.
 */
import { StandardFonts } from '../public/js/bundletoolPdfLib.js';
import { loadPdf } from '../public/js/bundletoolPdfLoad.js';
import { needsOcr, replaceOcrLayer, OCR_RASTER_DPI, OCR_MAX_IMAGE_PIXELS, OCR_MIN_CHARS } from '../public/js/bundletoolOcr.js';
import { readUpright, displayTurn, straightenRgba, turnRgba } from '../public/js/bundletoolDeskew.js';
import { visibleText, withoutPrintedText } from '../public/js/bundletoolOcrPrinted.js';
import { reorientPage, reorientSettings, reorientRecord, recordReorient } from '../public/js/bundletoolOcrReorient.js';
import { loadOcrRuntime, ocrSession } from './cliOcrEngine.mjs';

const POINTS_PER_INCH = 72;

// Below this DPI, recognisable text becomes too small or blurry for OCR to be worth attempting at
// all. 72 DPI is the PDF's own native point-to-pixel ratio (1:1), so a page that would need
// capping below even that is already far larger than anything a real scanned document reasonably
// is. Below this floor the page is reported ocr_failed ("too large") rather than rasterised.
const MIN_OCR_DPI = 72;

// A ceiling on the RASTER this module itself creates for OCR, separate from and well under
// bundletoolImages.js's MAX_PIXELS (100 million, for an uploaded photo's own embed-as-is path):
// this runs unattended, in whatever container is driving the CLI, and the bound here is sized for
// that container's real, fixed memory headroom, not a browser tab's. 25 million pixels (100MB raw
// RGBA) still comfortably covers A3 at 300 DPI (about 17 megapixels); past it the page is scaled
// down to fit rather than rasterised at the full, unclamped size (without the cap, a single blank
// 5000x5000pt page peaks at 2.59GB RSS).
const OCR_MAX_PIXELS = 25e6;

/** Builds a message safe for --json output and any warning that might reach a log or a screen:
 * fixed text plus, at most, the error's own class name, NEVER the error's message, which (a raw
 * filesystem ENOENT, a module-resolution failure, anything else) may carry this machine's own
 * absolute install path or other local detail that has no business leaving the process. */
function safeDetail(what, err) {
  const name = err?.name ?? err?.constructor?.name ?? 'Error';
  return `${what} (${name})`;
}

// Leptonica (tesseract's underlying image library) logs routine diagnostics ("Estimating
// resolution as NNN" on every recognised page) straight to the process's own stderr from inside
// the WASM module, not through a JS console call that cli-contract.mjs knows how to catch (its
// console.warn override only sees real JS console calls), and tesseract-wasm exposes no quiet or
// log-level option to turn it off at the source. It is routine chatter, not an error signal, so it
// is filtered here rather than left to print once per OCR'd page. The filter is scoped narrowly to
// this one known-benign message, so a genuinely new diagnostic line still gets through rather than
// being swallowed by too broad a pattern. A worker_threads worker's default-inherited stderr does
// reach this process's own stderr.write, so filtering it here (not inside the worker) is enough.
// The failure path's own stderr output (Leptonica and TESSDATA_PREFIX lines on a model-load
// failure) is deliberately left alone: that is a genuine failure signal on a rare path.
const BENIGN_OCR_STDERR = /^Estimating resolution as \d+\s*$/;
function suppressBenignOcrStderr() {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    if (BENIGN_OCR_STDERR.test(text.trim())) return true;
    return original(chunk, ...rest);
  };
  return () => { process.stderr.write = original; };
}

// pdf.js's own `warn()` (static/vendor/pdfjs.worker.mjs) calls `console.log` (STDOUT, not
// stderr), gated by `verbosity: 1` on getDocument() below (VerbosityLevel.WARNINGS), so it is a
// signal JavaScript can catch. This is what fires when OCR_MAX_IMAGE_PIXELS
// drops a single oversized image: "Warning: Image exceeded maximum allowed size and was
// removed." Scoped to one page's own render call at a time (pages are processed one at a time in
// the loop below, never concurrently), so attributing a caught line to the page being rendered
// at that moment is safe.
const OVERSIZED_IMAGE_LOG = /Image exceeded maximum allowed size and was removed\./;
async function withOversizedImageLogCapture(fn) {
  const original = console.log;
  let sawOversizedImage = false;
  console.log = (...args) => {
    if (OVERSIZED_IMAGE_LOG.test(args.join(' '))) { sawOversizedImage = true; return; }
    return original(...args);
  };
  try {
    const result = await fn();
    return { result, sawOversizedImage };
  } finally {
    console.log = original;
  }
}

let _pdfjsLib = null;
async function loadPdfjs() {
  if (!_pdfjsLib) {
    _pdfjsLib = await import('/vendor/pdfjs.mjs');
    _pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  }
  return _pdfjsLib;
}

/** A pdf.js canvasFactory backed by @napi-rs/canvas, standing in for the browser's OffscreenCanvas
 * and for pdf.js's own internal NodeCanvasFactory (see this file's header comment, "RASTERISING").
 * `getRealCreateCanvas` is read lazily, each time create() is actually called, so this one factory
 * object can be constructed and handed to getDocument() before the real @napi-rs/canvas function
 * is known (see this file's header comment, "ONE pdf.js DOCUMENT, NOT TWO"). */
function makeCanvasFactory(getRealCreateCanvas) {
  return {
    create(width, height) {
      const canvas = getRealCreateCanvas()(width, height);
      return { canvas, context: canvas.getContext('2d') };
    },
    reset(canvasAndContext, width, height) {
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    },
    destroy(canvasAndContext) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
    },
  };
}

/** The largest DPI, at most OCR_RASTER_DPI, that keeps this page's pixel area at or under
 * OCR_MAX_PIXELS. Returns a DPI below MIN_OCR_DPI when even that floor would not fit, which the
 * caller treats as "do not attempt this page at all" rather than rasterising something too small
 * to usefully recognise. */
function cappedDpiFor(widthPt, heightPt) {
  const pixelsAtDefault = (widthPt * OCR_RASTER_DPI / POINTS_PER_INCH) * (heightPt * OCR_RASTER_DPI / POINTS_PER_INCH);
  if (pixelsAtDefault <= OCR_MAX_PIXELS) return OCR_RASTER_DPI;
  return POINTS_PER_INCH * Math.sqrt(OCR_MAX_PIXELS / (widthPt * heightPt));
}

/** Renders one pdf.js page to a raster, ignoring the page's own rotation, for the same reason as the
 * browser's rasterizePageForOcr(): pixel space must map 1:1 onto the page's own unrotated MediaBox
 * space, so embedOcrLayer() needs no un-rotation of its own. Returns a PLAIN {data, width, height,
 * dpi, rotate, printed, ownText} object (printed: the page's visible text boxes; ownText: it has text of its own), not @napi-rs/canvas's own ImageData (see this file's header comment, "FEEDING THE
 * OCR ENGINE"); dpi is the actual DPI used, which may be less than OCR_RASTER_DPI (see
 * cappedDpiFor), and the caller must pass it on to embedOcrLayer() rather than assume the default.
 * Returns { tooLarge: true } instead of rendering at all when even MIN_OCR_DPI would not fit. */
async function rasterizePageForOcr(pdfjsPage, canvasFactory) {
  const unrotated = pdfjsPage.getViewport({ scale: 1, rotation: 0 });
  const dpi = cappedDpiFor(unrotated.width, unrotated.height);
  if (dpi < MIN_OCR_DPI) return { tooLarge: true };

  const viewport = pdfjsPage.getViewport({ scale: dpi / POINTS_PER_INCH, rotation: 0 });
  const canvasAndContext = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const { canvas, context } = canvasAndContext;
  await pdfjsPage.render({ canvasContext: context, viewport, canvas, background: 'white' }).promise;
  const raw = context.getImageData(0, 0, canvas.width, canvas.height);
  // getImageData() returns its own independent copy of the pixels (standard Canvas 2D semantics,
  // which @napi-rs/canvas follows: the returned Uint8ClampedArray is not a live view into the
  // canvas), so the canvas itself can be released immediately rather than waiting for GC to
  // notice it is unreachable. Each call here creates a BRAND NEW canvas (unlike the browser, which
  // reuses one OffscreenCanvas across every page of a document); without releasing it, a native
  // pixel buffer the size of one page's raster would accumulate per page for the life of the
  // process.
  canvasFactory.destroy(canvasAndContext);
  // Where the page already has visible text, in this raster's pixels: the words read there are left out
  // (bundletoolOcrPrinted.js). Read before the page is cleaned up, while pdf.js still holds what it drew.
  const printed = await visibleText(pdfjsPage, viewport, (await loadPdfjs()).OPS);
  return { data: raw.data, width: raw.width, height: raw.height, dpi, rotate: pdfjsPage.rotate, printed: printed.boxes, ownText: printed.chars >= OCR_MIN_CHARS };
}

/** The pixel work readUpright() needs, on plain RGBA (the browser does the same on canvases). The tilted canvas is
 * held to OCR_MAX_PIXELS like the raster itself: past that it is scaled down (bundletoolDeskew.js's uprightGeometry),
 * so levelling a page never needs more memory than reading the largest page allowed. Every image is a PLAIN
 * {data, width, height} object, the shape the engine needs (see this file's header comment). */
const uprightPixels = {
  sample: async (image) => image,
  tilt: async (image, angle, g) => ({
    data: straightenRgba(image.data, image.width, image.height, angle, { width: g.tiltWidth, height: g.tiltHeight, scale: g.scale }),
    width: g.tiltWidth,
    height: g.tiltHeight,
  }),
  turn: async (image, turn) => {
    const t = turnRgba(image.data, image.width, image.height, turn);
    return { data: t.data, width: t.width, height: t.height };
  },
  pixels: async (image) => image,
  crop: async (image, box) => {
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const from = ((box.y0 + y) * image.width + box.x0) * 4;
      data.set(image.data.subarray(from, from + width * 4), y * width * 4);
    }
    return { data, width, height };
  },
};

/**
 * Frees a document's bytes now rather than whenever the garbage collector next runs (see this file's header
 * comment, "THE CALLER'S COPY"). For bytes nothing will read again: afterwards `bytes` is empty. Only a view
 * over the whole of its own ArrayBuffer, sharing nothing with `keep`, is released; anything else (a view into
 * a larger buffer, such as a pooled Buffer, or a Node without ArrayBuffer.prototype.transfer) is left as it
 * is, for the garbage collector.
 * @param {Uint8Array} bytes - the bytes to free
 * @param {Uint8Array} [keep] - bytes that must survive (never freed, even if they share a buffer with `bytes`)
 * @returns {boolean} whether the memory was released
 */
export function releaseBytes(bytes, keep) {
  const buffer = bytes?.buffer;
  if (!(buffer instanceof ArrayBuffer) || typeof buffer.transfer !== 'function' || buffer === keep?.buffer) return false;
  if (bytes.byteOffset !== 0 || bytes.byteLength !== buffer.byteLength) return false;
  try {
    buffer.transfer(0);
    return true;
  } catch {
    return false; // not detachable here: left to the garbage collector
  }
}

/**
 * @param {Uint8Array} bytes - the document's current bytes
 * @param {{force?: boolean, onPage?: (index: number, total: number) => void,
 *   reorient?: {turnUpright?: boolean, straighten?: boolean, keepAsScanned?: number[]}, _loadOcrRuntime?: Function}} [opts]
 *   force: OCR every page, ignoring needsOcr()'s own check (the manifest's per-file "forceOcr").
 *   reorient: ocr.turnUpright and ocr.straighten (bundletoolOcrReorient.js); both off unless given. keepAsScanned:
 *   pages never to straighten (the browser's pages put back as scanned).
 *   _loadOcrRuntime: test-only override of cliOcrEngine.mjs's loadOcrRuntime(), to exercise the
 *   'unavailable' and 'failed' return shapes deterministically without needing the real native
 *   dependency absent or broken.
 * @returns {Promise<
 *   | {ok: true, bytes: Uint8Array | null, ocredPages: number, failures: Array<{page: number, detail: string}>,
 *      reoriented?: ReturnType<typeof reorientRecord>}
 *   | {ok: false, reason: 'unavailable', detail: string}
 *   | {ok: false, reason: 'failed', detail: string}
 * >} bytes: null when no page was OCR'd (the caller should leave the file exactly as it was).
 *   ok: false is a document-level failure: the whole file, not any one page (opening it with
 *   pdf.js, loading the model, opening it for pdf-lib, drawing or saving the layer): 'unavailable'
 *   for the engine simply not loading on this machine (the ocr_unavailable warning), 'failed' for
 *   anything else (ocr_failed, naming the file but not a page). ok: true with a non-empty
 *   `failures` array is a PARTIAL result: every page in `failures` was skipped independently (one
 *   page's trouble never stops OCR on the others in the same file), and `bytes`/`ocredPages`
 *   reflect everything that DID succeed. `reoriented`, present once pages have been read, says which pages were
 *   turned upright or straightened, which were left tilted because of their annotations, and which were read on
 *   their side with turning off.
 */
/** Destroys each given task or session, best-effort and independent of the others; skips any that is unset. */
async function closeAll(...closeables) {
  for (const closeable of closeables) {
    if (!closeable) continue;
    try { await closeable.destroy(); } catch { /* best-effort cleanup; the real failure is already captured by the caller */ }
  }
}

export async function ocrDocument(bytes, { force = false, onPage, reorient, _loadOcrRuntime = loadOcrRuntime } = {}) {
  // build-cli.mjs's bytes are read with node:fs's readFile, which returns a Buffer: a real
  // Uint8Array subclass (`instanceof Uint8Array` is true), but @cantoo/pdf-lib's own PDFDocument.load
  // checks `constructor === Uint8Array` specifically and refuses a Buffer with "Please provide
  // binary data as Uint8Array, rather than Buffer." A view over the same bytes (no copy) satisfies it.
  if (bytes.constructor !== Uint8Array) bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pdfjsLib = await loadPdfjs();

  // Nothing from here on may escape as a thrown exception: build-cli.mjs has no try/catch of its
  // own around this call, and an uncaught throw would surface as a fatal internal_error instead of
  // the required ocr_failed WARNING, breaking the "OCR trouble never fails the build" contract. The
  // outer try/finally also guarantees every task/session opened along the way is cleaned up on
  // every exit path, including a throw from ITS OWN construction (ocrSession() spawns a real
  // worker thread before loadModel() can fail on it): a half-constructed session that is never
  // destroyed would leave that worker thread open, a real hang risk for a CLI process, not just an
  // untidy warning. `open` holds whatever is open at the moment, so the finally can close it even
  // when the pass that opened it has thrown.
  const open = { pdfjsTask: undefined, session: undefined };
  const restoreStderr = suppressBenignOcrStderr();
  try {
    const read = await recognisePages(pdfjsLib, bytes, { force, onPage, loadRuntime: _loadOcrRuntime }, open);
    if (read.result) return read.result;
    // Pass 1 is over: release pdf.js's copy of the file and the OCR engine before pdf-lib makes its own copy and
    // writes the output, so the three are never alive together (see this file's header comment, "TWO PASSES").
    await closeAll(open.pdfjsTask, open.session);
    open.pdfjsTask = undefined;
    open.session = undefined;
    return await embedRecognisedText(bytes, read, reorientSettings(reorient));
  } catch (err) {
    return { ok: false, reason: 'failed', detail: safeDetail('could not prepare the document for OCR', err) };
  } finally {
    restoreStderr();
    // Each destroy is independent and best-effort: a task/session that never finished constructing
    // (the exact failure this cleanup exists for) may itself throw on destroy, and that must not
    // replace or hide the real error already being returned above, nor skip cleaning up the others.
    await closeAll(open.pdfjsTask, open.session);
  }
}

/**
 * Pass 1: finds the pages that need OCR and recognises each one with pdf.js and the OCR engine. pdf-lib is not
 * loaded here. Keeps only each page's recognised words (a small array), never its raster.
 *
 * @returns {Promise<
 *   | {result: object}
 *   | {recognised: Array<{pageNumber: number, words: object[], dpi: number, read: object, raster: {width: number, height: number},
 *       ownText: boolean}>, failures: Array<{page: number, detail: string}>, done: number}
 * >} `result` is ocrDocument()'s own final answer when there is nothing more to do (no page needs OCR, the
 *   engine is unavailable, the model failed to load); otherwise what pass 2 needs.
 */
async function recognisePages(pdfjsLib, bytes, { force, onPage, loadRuntime }, open) {
  // One canvasFactory, constructed before the OCR runtime is known to be needed, and before it has
  // loaded: its create() only reads realCreateCanvas when actually CALLED, which never happens
  // during the text-layer probe below (pdf.js's own internal canvas need aside, see this file's
  // header comment, "RASTERISING": getTextContent() alone does not reach it). This is what lets
  // one document serve both the probe and, if needed, the render pass: see "ONE pdf.js DOCUMENT,
  // NOT TWO" above.
  let realCreateCanvas = null;
  const canvasFactory = makeCanvasFactory(() => realCreateCanvas);

  open.pdfjsTask = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false, canvasFactory, maxImageSize: OCR_MAX_IMAGE_PIXELS, verbosity: 1 });
  const pdfjsDoc = await open.pdfjsTask.promise;
  const targets = [];
  for (let i = 1; i <= pdfjsDoc.numPages; i++) {
    const page = await pdfjsDoc.getPage(i);
    const content = await page.getTextContent();
    if (force || needsOcr(content.items)) targets.push(i);
    page.cleanup();
  }
  if (targets.length === 0) return { result: { ok: true, bytes: null, ocredPages: 0, failures: [] } };

  const runtime = await loadRuntime();
  if (!runtime.available) return { result: { ok: false, reason: 'unavailable', detail: runtime.reason } };
  realCreateCanvas = runtime.createCanvas; // canvasFactory.create() is only ever called from here on

  try {
    open.session = await ocrSession(runtime.createOCRClient);
  } catch (err) {
    // Named specifically, not folded into the generic phrase pass 2 uses: a model-load failure says so
    // distinctly from "the PDF could not be parsed", so a caller (or a person) can tell the two
    // apart without needing the raw exception text either way.
    return { result: { ok: false, reason: 'failed', detail: 'the OCR model failed to load' } };
  }
  const session = open.session;

  const recognised = [];
  const failures = [];
  let done = 0;
  for (const pageNumber of targets) {
    let image;
    let sawOversizedImage;
    try {
      ({ result: image, sawOversizedImage } = await withOversizedImageLogCapture(async () => {
        const pdfjsPage = await pdfjsDoc.getPage(pageNumber);
        const img = await rasterizePageForOcr(pdfjsPage, canvasFactory);
        pdfjsPage.cleanup();
        return img;
      }));
    } catch (err) {
      failures.push({ page: pageNumber, detail: safeDetail('could not rasterise the page', err) });
      continue;
    }
    // Checked before `tooLarge`: an oversized embedded image is caught here even on a
    // page whose own size is otherwise fine, which is exactly the case `tooLarge` (the
    // page-rasterisation cap) does not cover. Never counted as OCR'd: an embedded image
    // dropped mid-page is real content lost, not a legitimately blank page, so this must not
    // silently succeed with an empty text layer.
    if (sawOversizedImage) {
      failures.push({ page: pageNumber, detail: 'an image on this page is too large to read safely' });
      continue;
    }
    if (image.tooLarge) {
      failures.push({ page: pageNumber, detail: 'the page is too large to rasterise safely for OCR' });
      continue;
    }
    let words;
    let read;
    try {
      // The page is turned upright before it is read, first by its own /Rotate, then as its pixels say
      // (bundletoolDeskew.js says why and when); a level, upright page, a page with no text to measure and one whose
      // lie cannot be told are read as they are. Only the words and the map back to the page (six numbers) are kept
      // for pass 2, never a raster.
      const raster = { data: image.data, width: image.width, height: image.height };
      ({ words, ...read } = await readUpright(raster, image, session, uprightPixels, { maxPixels: OCR_MAX_PIXELS, pageTurn: displayTurn(image.rotate) }));
      // Only what is not already text: the page's own visible text is not read a second time.
      words = withoutPrintedText(words, image.printed, read.toRaw);
    } catch (err) {
      failures.push({ page: pageNumber, detail: safeDetail('the OCR engine failed to recognise the page', err) });
      continue;
    }
    // What pass 2 needs to turn or straighten the page: a few numbers (the maps, the tilt, the quarter turn and the
    // raster's size), never the raster.
    recognised.push({ pageNumber, words, dpi: image.dpi, read, raster: { width: image.width, height: image.height }, ownText: image.ownText });
    done++;
    onPage?.(done, targets.length);
  }
  return { recognised, failures, done };
}

/**
 * Pass 2: opens the original bytes with pdf-lib and draws each recognised page's text layer onto it. Runs only
 * once pdf.js and the OCR engine are closed. pdf-lib is loaded even when no page was recognised, so a file
 * pdf-lib cannot open still reports 'failed' exactly as it would have with the layer to add.
 */
async function embedRecognisedText(bytes, { recognised, failures, done }, settings) {
  let pdfLibDoc;
  let font;
  let pdfLibPages;
  try {
    ({ doc: pdfLibDoc } = await loadPdf(bytes));
    font = await pdfLibDoc.embedFont(StandardFonts.Helvetica);
    pdfLibPages = pdfLibDoc.getPages();
  } catch (err) {
    return { ok: false, reason: 'failed', detail: safeDetail('the PDF could not be prepared for OCR', err) };
  }
  const reoriented = reorientRecord();
  for (const { pageNumber, words, dpi, read, raster, ownText } of recognised) {
    const pdfLibPage = pdfLibPages[pageNumber - 1];
    // The words are in the upright image's pixels; toRaw takes the text layer back onto the page as it was scanned
    // (toLevel onto the page once it is straightened). A scanned page is turned or straightened only when a setting
    // asks for it (bundletoolOcrReorient.js).
    if (pdfLibPage && words.length) {
      const { plan, layer } = reorientPage(pdfLibPage, read, settings, { ownText, raster, dpi, pageNumber });
      replaceOcrLayer(pdfLibPage, font, words, dpi, layer);
      recordReorient(reoriented, pageNumber, plan);
    }
  }
  return { ok: true, bytes: done > 0 ? await pdfLibDoc.save() : null, ocredPages: done, failures, reoriented };
}
