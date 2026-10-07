/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * cliOcrEngine.mjs
 * The Node equivalent of public/js/bundletoolOcrEngine.js: the one place
 * tesseract-wasm is loaded and driven for the command line. Everything here
 * is about running the engine; the geometry and the page-needs-it decision
 * stay in public/js/bundletoolOcr.js, reused unchanged by both sides.
 *
 * tesseract-wasm ships its own documented Node entry point (package.json's
 * "./node" export, src/node-worker.js): createOCRClient() runs the engine in
 * a real node:worker_threads Worker via comlink, the same OCRClient class the
 * browser uses, just constructed with a worker factory that understands
 * worker_threads instead of a Web Worker. Nothing here talks to the network;
 * eng.traineddata is read straight off disk (loadModel accepts a Buffer).
 *
 * @napi-rs/canvas and tesseract-wasm are both optionalDependencies (see
 * package.json and README: "needs Node 22 or later... and the repository's
 * npm install", nothing extra for the core CLI). Both are dynamically
 * imported here, and only when a caller actually asks for a session: a
 * manifest with ocr.mode "off" and no forceOcr file never pays for either.
 * `importCanvas`/`importTesseract` are parameters, not closed-over imports,
 * so a test can inject a failing loader without needing either package
 * absent from node_modules for real.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ENG_TRAINEDDATA = fileURLToPath(new URL('../public/ocr/eng.traineddata', import.meta.url));

/**
 * Attempts to load this machine's OCR runtime. Never throws: a missing
 * package, and a present package with no prebuilt native binary for this
 * platform, both surface the same way: the dynamic import itself rejects
 * either way, so the caller (ocr_unavailable) does not need to tell them apart.
 *
 * @returns {Promise<{available: true, createOCRClient: Function} | {available: false, reason: string}>}
 */
export async function loadOcrRuntime({
  importCanvas = () => import('@napi-rs/canvas'),
  importTesseract = () => import('tesseract-wasm/node'),
} = {}) {
  // Each import is caught on its own, and the reason string built from just the known package name
  // and a short, generic phrase, NOT the real error's own message. A real module-resolution error
  // (Node's "Cannot find package 'x' imported from <path>") or a native-binding load failure both
  // carry this machine's own absolute install path, which has no business in a warning that reaches
  // --json output and, from there, potentially a log or a screen somewhere.
  const [canvasResult, tesseractResult] = await Promise.allSettled([importCanvas(), importTesseract()]);
  if (canvasResult.status === 'rejected') return { available: false, reason: '@napi-rs/canvas could not be loaded (missing, or no prebuilt binary for this platform)' };
  if (tesseractResult.status === 'rejected') return { available: false, reason: 'tesseract-wasm could not be loaded (missing, or no prebuilt binary for this platform)' };
  return { available: true, createCanvas: canvasResult.value.createCanvas, createOCRClient: tesseractResult.value.createOCRClient };
}

/**
 * Starts one tesseract-wasm client with the English model already loaded, on
 * a real node:worker_threads Worker. Call .destroy() on the returned session
 * when the whole operation (every page of one document) is done: this both
 * frees the WASM memory and, critically for a CLI process, terminates the
 * worker thread so the process can exit on its own rather than hanging on an
 * open handle.
 *
 * @param {Function} createOCRClient - from loadOcrRuntime()'s successful result
 * @returns {Promise<{recognizeWords: (image: {data: Uint8ClampedArray|Uint8Array, width: number, height: number}, opts?: {dpi?: number}) => Promise<import('../public/js/bundletoolOcr.js').OcrWord[]>,
 *   load: (image: {data: Uint8ClampedArray|Uint8Array, width: number, height: number}, opts?: {dpi?: number, sparse?: boolean}) => Promise<void>, orientation: () => Promise<{rotation: number, confidence: number}>,
 *   words: () => Promise<import('../public/js/bundletoolOcr.js').OcrWord[]>, destroy: () => Promise<void>}>}
 */
export async function ocrSession(createOCRClient) {
  const client = createOCRClient();
  // createOCRClient() already spawned a real worker_threads Worker before this line runs. If
  // reading or loading the model fails, that worker is destroyed here before rethrowing. Left
  // alive, it would be an orphaned thread with nothing referencing it to call destroy() later (the
  // caller's own `session` variable is never assigned, since this function never returns), which
  // would keep the whole CLI process alive instead of exiting once its real work is done: a
  // missing or truncated eng.traineddata would give a correct ocr_failed warning in the JSON
  // output and then hang.
  try {
    let modelBytes;
    try {
      modelBytes = await readFile(ENG_TRAINEDDATA);
    } catch (err) {
      // fs errors carry this machine's own absolute path (ENOENT ... open '/.../eng.traineddata'),
      // so the message is rebuilt from just the file's own name, never the raw error, for the same
      // reason as loadOcrRuntime()'s import-failure messages above.
      throw new Error(`could not read the trained model file (eng.traineddata): ${err.code ?? 'error'}`);
    }
    await client.loadModel(modelBytes);
  } catch (err) {
    await client.destroy();
    throw err;
  }

  /**
   * Tells the engine the resolution of the image it is about to read. An image handed over as pixels carries none,
   * and Tesseract then assumes 70 dpi (its lowest credible resolution) for thresholding and for finding and removing
   * ruled lines before it looks for text, re-estimating only later, which can lose whole columns of text from a
   * ruled table. OCRmyPDF always passes the resolution through; Tesseract's own setting for it is user_defined_dpi.
   * tesseract-wasm's OCRClient has no setVariable of its own, but the engine it drives in its worker does, behind
   * the client's _ocrEngine handle (tests/cliOcr.test.mjs fails if a new build drops it). An engine without it reads
   * the image without the setting. The same handle sets the page segmentation mode for a `sparse` read.
   */
  const setVariable = async (name, value) => {
    try {
      const engine = await client._ocrEngine;
      await engine?.setVariable(name, value);
    } catch { /* read without the setting */ }
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
     * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} image - a raster
     *   of one page, as a PLAIN object with its own enumerable data/width/height. @napi-rs/canvas's
     *   own ImageData has width/height as prototype getters, not own properties, and comlink's
     *   structured-clone-style marshalling across the worker_threads boundary only carries own
     *   properties, so passing that object straight through silently loses width/height on the
     *   other side (symptom: a WASM-level "pixCreateHeader: width must be > 0", not a clean JS
     *   error). The caller must reshape into a plain object first; this function trusts that it did.
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
