/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolOcrEngine.js
 * The one place tesseract-wasm is loaded and driven. Everything here is
 * about running the engine; the geometry and the page-needs-it decision
 * live in bundletoolOcr.js, a pure module with no engine of its own.
 *
 * tesseract-wasm over tesseract.js: the same underlying Tesseract engine
 * (so materially the same accuracy), but a build trimmed of browser-irrelevant
 * code (image-format parsing the browser's own Canvas already does): library
 * plus English data together are roughly a third of the download of the
 * alternative, which matters directly for a feature that must cost nothing to
 * anyone who never triggers it. BSD-2-Clause.
 *
 * NOT wrapped in a bespoke Worker the way the TIFF/merge/build workers are.
 * Those wrap CPU-heavy logic with no async delegation of its own; OCRClient
 * already spawns and owns its own dedicated Worker the moment it is
 * constructed, so an outer Worker around it would nest one Worker inside
 * another for no benefit. Calling it directly is the library's own supported
 * shape (see its README).
 *
 * SELF-HOSTED. lib.js resolves its own worker script, and that worker script
 * resolves its own two WASM files (the SIMD build and a non-SIMD fallback,
 * feature-detected between), all relative to wherever lib.js itself is
 * served from, which is why static/vendor/tesseract-wasm/ keeps all four
 * files together (scripts/build-vendor.mjs's own comment has the detail).
 * Nothing here points at a CDN; left to its own defaults this library
 * already does not.
 *
 * ONE CLIENT, REUSED. Model loading (fetching and parsing eng.traineddata)
 * is the expensive part; ocrSession() hands back one OCRClient with the
 * model already loaded, reused across every page of one "OCR this document"
 * operation. The caller destroys it when done.
 */

const LANG_DATA_URL = '/bundletool/ocr/eng.traineddata';

import { lazyImport, startWorker, memoizeLoad, watchForLazyLoadFailures } from '/js/shared/lazy-load.js';

// lazyImport retries once and raises the reload notice on a real failure; memoizeLoad drops the cached
// promise if it rejects, so one transient failure does not disable OCR until the page is reloaded.
const loadOcrClient = memoizeLoad(() => lazyImport('/vendor/tesseract-wasm/lib.js').then((m) => m.OCRClient));

/**
 * Starts one tesseract-wasm client with the English model already loaded.
 * Call .destroy() on the returned session when the whole operation (all
 * pages of one document, or several documents in one "Force OCR" run) is
 * done.
 *
 * @returns {Promise<{recognizeWords: (image: ImageBitmap, opts?: {dpi?: number}) => Promise<import('./bundletoolOcr.js').OcrWord[]>,
 *   load: (image: ImageBitmap, opts?: {dpi?: number, sparse?: boolean}) => Promise<void>, orientation: () => Promise<{rotation: number, confidence: number}>,
 *   words: () => Promise<import('./bundletoolOcr.js').OcrWord[]>, destroy: () => Promise<void>}>}
 */
export async function ocrSession() {
  const OCRClient = await loadOcrClient();
  // A worker script that fails to load fires `error` on the Worker and nothing else: the library attaches
  // no listener, so loadModel() would wait forever. startWorker() raises the reload notice; this also
  // turns the same event into a rejection, so the caller reports a failed OCR instead of hanging.
  let workerFailed;
  const failed = new Promise((_, reject) => { workerFailed = reject; });
  failed.catch(() => {});   // not an unhandled rejection once nothing is racing it
  const client = new OCRClient({
    createWorker: (url) => {
      const worker = startWorker(url);
      watchForLazyLoadFailures(worker);
      worker.addEventListener('error', () => workerFailed(new Error('The text-reading engine could not start.')));
      return worker;
    },
  });
  try {
    await Promise.race([client.loadModel(LANG_DATA_URL), failed]);
  } catch (err) {
    try { await client.destroy(); } catch { /* it never started */ }
    throw err;
  }

  /**
   * Tells the engine the resolution of the image it is about to read. An image handed over as pixels carries none,
   * and Tesseract then assumes 70 dpi (its lowest credible resolution) for thresholding and for finding and removing
   * ruled lines before it looks for text, re-estimating only later, which can lose whole columns of text from
   * a ruled table. OCRmyPDF always passes the resolution through; Tesseract's own setting for it is user_defined_dpi.
   * tesseract-wasm's OCRClient has no setVariable of its own, but the engine it drives in its worker does, behind
   * the client's _ocrEngine handle (tests/cliOcr.test.mjs fails if a new build drops it). An engine without it reads
   * at its assumed resolution. The same handle sets the page segmentation mode for a `sparse` read.
   */
  const setVariable = async (name, value) => {
    try {
      const engine = await client._ocrEngine;
      await engine?.setVariable(name, value);
    } catch { /* read without it */ }
  };
  // `sparse` reads the image in Tesseract's sparse-text mode (page segmentation mode 11), for a small region of print
  // the page's own layout step passed over (bundletoolOcrGaps.js). Loading an image puts the engine back in its
  // automatic mode, so this lasts for the one image.
  const load = async (image, { dpi, sparse = false } = {}) => {
    if (dpi > 0) await setVariable('user_defined_dpi', String(Math.round(dpi)));
    await client.loadImage(image);
    if (sparse) await setVariable('tessedit_pageseg_mode', '11');
  };

  /** Reads the words of the image last loaded, in its own pixels, and lets the image go. */
  const words = async () => {
    const items = await client.getTextBoxes('word');
    const found = [];
    for (const item of items) {
      if (!item?.text?.trim()) continue;
      const { left, top, right, bottom } = item.rect;
      found.push({ text: item.text, confidence: item.confidence, x0: left, y0: top, x1: right, y1: bottom });
    }
    await client.clearImage();
    return found;
  };

  return {
    /**
     * @param {ImageBitmap} image - a raster of one page
     * @returns {Promise<import('./bundletoolOcr.js').OcrWord[]>}
     */
    async recognizeWords(image, { dpi } = {}) {
      await load(image, { dpi });
      return words();
    },
    /** One page in steps, for a page that is turned upright first (bundletoolDeskew.js's readUpright): load an
     * image (with its resolution), ask which way up it is, read the words of the image loaded last. */
    load,
    orientation: () => client.getOrientation(),
    words,
    destroy: () => client.destroy(),
  };
}
