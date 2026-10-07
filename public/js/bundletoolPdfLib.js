/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolPdfLib.js
 * The one place the PDF engine is pinned.
 *
 * Every other module imports the engine from here rather than naming an
 * address of its own. Two reasons:
 *
 *   1. One import site means one build of pdf-lib. Two builds loaded at once
 *      (@cantoo/pdf-lib in one path and stock pdf-lib in another, say) would
 *      mean two parsers, two object models and two sets of bugs for one job.
 *      One import site makes that mistake structurally impossible.
 *   2. The page imports the library by its root-absolute address
 *      (/vendor/cantoo-pdf-lib.js), which Node cannot resolve on its own.
 *      scripts/node-compat-resolve.mjs maps it onto the same file for the tests
 *      and the command line, so every source file under test is byte-identical
 *      to what ships.
 *
 * @cantoo/pdf-lib is the maintained MIT fork of Hopding/pdf-lib, and the only
 * PDF engine the application loads.
 *
 * pdf-lib itself is eager: opening, validating and merging a bundle all go through it before a
 * person has made a single choice, so deferring it would only delay work this page is about to do
 * anyway. fontkit (346 KB) is not: it is needed only once a document asks to embed a font outside
 * pdf-lib's own standard 14, which on this app's pages happens after the person has already chosen
 * to draw a cover, a watermark or page numbers, so it is loaded lazily, through getFontkit() below.
 */

// Self-hosted, so no visitor's browser depends on a third party being up and
// still carrying the pinned version. The bundles under vendor/ are built by
// scripts/build-vendor.mjs from the exact versions pinned in package.json.
import * as _pdflib from '/vendor/cantoo-pdf-lib.js';
import { lazyImport, signalLazyLoadFailure } from '/js/shared/lazy-load.js';

/** The whole @cantoo/pdf-lib namespace. */
export const pdflib = _pdflib;

// Memoised: every caller after the first gets the same promise, not a second fetch-and-parse. Cleared
// on rejection so a later, separate call (the person pressing "Create Bundle" again) gets a fresh
// attempt rather than the same cached failure: lazyImport() itself retries once per call with a
// cache-busted URL, but that is one call's own retry budget, not a standing circuit breaker for the
// rest of the page's life.
let _fontkitPromise = null;
// True while _fontkitPromise's own underlying lazyImport() call was made with {silent: true} (a
// prewarm); getFontkit() reads it to decide whether a real caller joining it needs its own signal.
let _fontkitStartedSilently = false;

function startFontkit(opts) {
  const p = lazyImport('/vendor/pdf-lib-fontkit.js', opts).then((ns) => ns.default ?? ns);
  p.catch(() => { if (_fontkitPromise === p) _fontkitPromise = null; });
  _fontkitPromise = p;
  _fontkitStartedSilently = !!opts?.silent;
  return p;
}

/** fontkit, normalised past its bundle's default-export versus namespace ambiguity. Fetched on first call. */
export function getFontkit() {
  if (!_fontkitPromise) return startFontkit();
  if (_fontkitStartedSilently) {
    // A real, awaited call joining a fetch that was started silently (prewarmFontkit(), below), most
    // likely still in flight, since a prewarm starts well before any real job could reach this call.
    // lazyImport()'s own toast was suppressed for that attempt, but a real caller IS now waiting on it,
    // so failure is signalled on a DERIVED promise: the shared _fontkitPromise itself, and anyone else
    // just awaiting it directly (including the prewarm's own caller), stays untouched and silent.
    // Returning _fontkitPromise as it is here would let a real job's awaited call ride the silent
    // promise with no reload toast on failure (the "Connection error" modal would still appear, since
    // the rejection itself still propagates).
    return _fontkitPromise.catch((e) => { signalLazyLoadFailure(); throw e; });
  }
  return _fontkitPromise;
}

/**
 * Same fetch, same memo as getFontkit(), but silent on failure: a worker warming its own fontkit
 * fetch at startup, before any real job has asked for it, is not a failure anyone is waiting on yet.
 * An idle build or footer worker with fontkit blocked would otherwise raise the reload toast a few
 * milliseconds after announcing ready, for a job that in the default configuration (no page
 * numbering, no cover) does not even need fontkit. A failure here still clears the memo, as
 * getFontkit()'s own does, so a later real getFontkit() call (the only one a person is actually
 * waiting on) starts fresh, and signals normally, if nothing joined this attempt in time; see
 * getFontkit() above for the case where one did.
 */
export function prewarmFontkit() {
  return _fontkitPromise || startFontkit({ silent: true });
}

// Named re-exports for the handful of members used often enough that
// `pdflib.` in front of them is just noise.
export const {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  PDFHexString,
  PDFArray,
  PDFDict,
  PDFRef,
  PDFRawStream,
  PDFStream,
  PDFNull,
  PDFBool,
  decodePDFRawStream,
  EncryptedPDFError,
  StandardFonts,
  TextRenderingMode,
  pushGraphicsState,
  popGraphicsState,
  setCharacterSqueeze,
  concatTransformationMatrix,
  rgb,
  degrees,
} = _pdflib;
