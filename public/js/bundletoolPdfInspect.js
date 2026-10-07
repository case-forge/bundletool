/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolPdfInspect.js
 * What is inside a PDF that the person adding it ought to know about, read from a document that has
 * already been loaded (bundletoolPdfLoad.js): how many pages, how big the pages are, and the things a
 * PDF can carry that would not survive being merged into a bundle, or should not.
 *
 *   - PAGE COUNT AND SIZE: a PDF can hold thousands of pages, or a page a metre across, and nothing in
 *     the file stops it. They are counted here so the intake can refuse what a browser tab cannot build.
 *   - SCRIPTS AND PROGRAMS: a PDF can carry JavaScript and actions that launch programs. They are NOT
 *     carried into a bundle: the build writes its own pages and links, and a bundle built from a file
 *     with page, annotation and document-level scripts and Launch actions contains none of them
 *     (tests/activeContent.test.mjs checks the finished bundle).
 *   - ATTACHMENTS AND PORTFOLIOS: files attached inside a PDF are not pages, so merging the PDF leaves
 *     them out. A portfolio (a PDF that is really a folder of other files) merges as a near-empty page.
 *   - STREAMS THAT EXPAND ENORMOUSLY: a few hundred kilobytes of compressed data can unpack to gigabytes
 *     (a "decompression bomb"). Adding such a file is harmless, but drawing its page in a reader, this
 *     tool's preview included, can use all the memory a browser tab has and crash it. They are found by
 *     inflating the largest streams under a budget (findExpandingStreams).
 *   - XFA FORMS: a dynamic form that many readers show as a page saying "please wait" or nothing at all.
 *
 * Nothing here throws: a document whose structure cannot be read reports nothing rather than blocking.
 */
import { PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, PDFNumber } from './bundletoolPdfLib.js';

const name = (n) => PDFName.of(n);

function lookup(doc, obj) {
  try { return doc.context.lookup(obj); } catch { return undefined; }
}

function dictOf(doc, obj) {
  const v = lookup(doc, obj);
  return v instanceof PDFDict ? v : null;
}

/**
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @returns {{pages: number, maxEdge: number, hasXfa: boolean, attachments: boolean, isPortfolio: boolean}}
 */
export function readPdfFacts(doc) {
  const out = { pages: 0, maxEdge: 0, hasXfa: false, attachments: false, isPortfolio: false };
  try {
    out.pages = doc.getPageCount();
    for (const page of doc.getPages()) {
      const { width, height } = page.getMediaBox();
      out.maxEdge = Math.max(out.maxEdge, Math.abs(width), Math.abs(height));
    }
  } catch { /* leave what was read */ }
  try {
    const catalog = doc.catalog;
    const acro = dictOf(doc, catalog.get(name('AcroForm')));
    out.hasXfa = !!(acro && acro.get(name('XFA')));
    const names = dictOf(doc, catalog.get(name('Names')));
    out.attachments = !!(names && names.get(name('EmbeddedFiles')));
    out.isPortfolio = !!catalog.get(name('Collection'));
  } catch { /* structure unreadable: report nothing */ }
  return out;
}

const MB = 1024 * 1024;

function isFlate(doc, dict) {
  let filter = lookup(doc, dict.get(name('Filter')));
  if (filter instanceof PDFArray) filter = lookup(doc, filter.get(0));
  const label = filter?.asString?.() ?? '';
  return label === '/FlateDecode' || label === '/Fl';
}

/**
 * Inflates zlib data under a budget and reports how much came out for how much went in.
 * @returns {Promise<{out: number, fed: number, finished: boolean}>}
 */
async function inflateUnderBudget(bytes, limitOut) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  let out = 0;
  let fed = 0;
  let stop = false;
  const pump = (async () => {
    try {
      while (fed < bytes.length && !stop) {
        const end = Math.min(bytes.length, fed + 16384);
        await writer.write(bytes.subarray(fed, end));
        fed = end;
      }
      if (!stop) await writer.close();
    } catch { /* the reader below reports what it got */ }
  })();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      out += value.length;
      if (out >= limitOut) break;
    }
  } catch { finished = true; }      // corrupt data ends the stream: nothing more can expand
  stop = true;
  await reader.cancel().catch(() => {});
  await writer.abort().catch(() => {});
  await pump;
  return { out, fed, finished };
}

/**
 * True when some large stream in the document unpacks to far more than it takes up: at least
 * `perStream` bytes (128 MB) out of a stream that has supplied less than 1/50th of that. Only the
 * biggest compressed streams are tried, and only up to `totalBudget` bytes of output altogether,
 * so a large ordinary PDF costs about a second at most and a bomb is caught in a fraction of one.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @param {{minCompressed?: number, perStream?: number, totalBudget?: number, maxStreams?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function findExpandingStreams(doc, opts = {}) {
  const minCompressed = opts.minCompressed ?? 100 * 1024;
  const perStream = opts.perStream ?? 128 * MB;
  const totalBudget = opts.totalBudget ?? 384 * MB;
  const maxStreams = opts.maxStreams ?? 60;
  if (typeof DecompressionStream === 'undefined') return false;
  try {
    const candidates = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.contents.length >= minCompressed && isFlate(doc, obj.dict)) candidates.push(obj.contents);
    }
    candidates.sort((a, b) => b.length - a.length);
    let spent = 0;
    for (const bytes of candidates.slice(0, maxStreams)) {
      if (spent >= totalBudget) break;
      const { out, fed, finished } = await inflateUnderBudget(bytes, perStream);
      spent += out;
      if (!finished && out >= perStream && fed * 50 < out) return true;
    }
  } catch { /* unreadable: report none */ }
  return false;
}

/**
 * The 1-based numbers of the pages that carry an embedded image of more than `maxPixels` pixels,
 * counting images inside Form XObjects too. Reads each image's declared /Width x /Height only: no
 * stream is decoded, so it costs next to nothing on a document made to be enormous. This is how a
 * caller finds out, before rendering, that pdf.js would drop an over-cap image without a signal.
 * Nothing here throws: a page whose resources cannot be read is simply not reported.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @param {number} maxPixels
 * @returns {number[]}
 */
export function findOversizedImagePages(doc, maxPixels) {
  const pages = [];
  let leaves = [];
  try { leaves = doc.getPages(); } catch { return pages; }
  const number = (v) => { const n = lookup(doc, v); return n instanceof PDFNumber ? n.asNumber() : 0; };

  /** True when this resource dictionary, or any Form XObject below it, holds an over-cap image. */
  const hasOversized = (resources, seen) => {
    const xobjects = dictOf(doc, resources?.get(name('XObject')));
    if (!xobjects) return false;
    for (const [, ref] of xobjects.entries()) {
      // A Form XObject can name itself or an ancestor; each object is read once per page.
      if (ref instanceof PDFRef) {
        if (seen.has(ref.tag)) continue;
        seen.add(ref.tag);
      }
      const xo = lookup(doc, ref);
      const dict = xo?.dict;
      if (!dict) continue;
      const subtype = lookup(doc, dict.get(name('Subtype')));
      if (subtype === name('Image')) {
        if (number(dict.get(name('Width'))) * number(dict.get(name('Height'))) > maxPixels) return true;
      } else if (subtype === name('Form') && hasOversized(dictOf(doc, dict.get(name('Resources'))), seen)) {
        return true;
      }
    }
    return false;
  };

  leaves.forEach((page, i) => {
    try {
      if (hasOversized(page.node.Resources(), new Set())) pages.push(i + 1);
    } catch { /* an unreadable page is not reported */ }
  });
  return pages;
}
