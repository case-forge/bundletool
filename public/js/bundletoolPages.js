/**
 * BundleTool
 * Copyright (c) 2025-2026 Tris Sherliker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * A tool for the creation of legal bundles.
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolPages.js
 * Page-level operations: validation on upload, coversheets, page numbering.
 *
 * ENCRYPTION IS REFUSED, NOT WORKED AROUND. Neither validateAndCountPages()
 * nor validateCoverPage() loads a PDF with `ignoreEncryption: true`. That flag
 * does not decrypt anything: it tells pdf-lib to carry on with content streams
 * that are still ciphertext, and the pages come out blank. A bundle of blank
 * pages is the worst failure available to a tool like this, because nothing
 * about it looks wrong until it is in front of a judge.
 *
 * DAMAGE IS RECOVERED AND DISCLOSED. A damaged PDF may be the only copy of a
 * document in existence, so refusing it can destroy the only route to its
 * contents. validateAndCountPages() therefore reports what was recovered and
 * leaves the decision to the user; bundletoolPdfLoad.js does the detection.
 */

import { PDFDocument, rgb, getFontkit, degrees, PDFDict, PDFArray, PDFRef, PDFStream, PDFNull } from './bundletoolPdfLib.js';
import { loadPdf, EncryptedPdfError, UnreadablePdfError } from './bundletoolPdfLoad.js';
import { detectBundle } from './bundletoolRestore.js';
import { findUnappliedRedactions, prepareSourceForMerge } from './bundletoolPdfSafety.js';
import { readPdfFacts, findExpandingStreams } from './bundletoolPdfInspect.js';
import { MAX_PAGE_POINTS } from './frontend/limits.js';
import { drawFooterOnPage, registerPageFont, inkBandAtSize } from './bundletoolFooter.js';
import { getFontSettings, withBase } from './bundletoolFontSettings.js';
import { normaliseFontKey } from './bundletoolConfig.js';
import { pageDimensions, pageWidth } from './bundletoolPageSize.js';
import { applyWatermarkToDoc } from './bundletoolWatermark.js';
import { startWorker, watchForLazyLoadFailures } from '/js/shared/lazy-load.js';

/**
 * THE FOOTER FONT FOLLOWS `pageNumbering.footerFont`.
 *
 * An option that is accepted, stored and read back but does nothing is worse
 * than either having it or not, so the footer is drawn in the font the setting
 * names. The default is Liberation Sans.
 *
 * What keeps the footer centred under a free choice of font is that the label
 * is MEASURED WITH THE FONT IT IS DRAWN IN: the same font object produces the
 * width the plate is sized from, the ink band the baseline is derived from,
 * and the glyphs on the page (see drawFooterOnPage(), which has no second font
 * to drift against). The label also carries no zero-width characters (see
 * buildFooterTexts()): pdf-lib's CustomFontEmbedder.widthOfTextAtSize sums
 * each glyph's own advanceWidth rather than using the shaper's positions, so
 * in Liberation Sans, where U+200B maps to the ordinary space glyph, they
 * would measure and draw as leading whitespace.
 */
export const FOOTER_FONT_URL = '/fonts/arialalt/liberation-sans/LiberationSans-Regular.ttf';

/**
 * The font file for a footer font key.
 *
 * Unknown and retired keys resolve through normaliseFontKey(), so a
 * configuration naming a font this build does not ship still renders, in
 * Liberation Sans, rather than failing.
 *
 * @param {string} fontKey
 * @returns {string} a URL under public/
 */
export function footerFontUrl(fontKey) {
  // withBase() here is a no-op outside a browser (Node has no window), so
  // this equals the raw FOOTER_FONT_URL in every test; only a real browser
  // under a subpath deployment sees the two differ.
  return getFontSettings(normaliseFontKey(fontKey))?.regular?.url ?? withBase(FOOTER_FONT_URL);
}

/**
 * Embeds the configured footer font, falling back to Liberation Sans if the
 * file cannot be fetched. A footer is not worth failing a whole bundle over,
 * and the fallback is metric-compatible with Arial rather than arbitrary.
 */
async function loadFooterFont(pdfDoc, fontKey) {
  const wanted = footerFontUrl(fontKey);
  // FOOTER_FONT_URL itself is the raw value the tests assert against;
  // withBase() gives the URL actually fetched and compared, so the fallback
  // resolves under a subpath deployment rather than 404ing against the
  // unprefixed path.
  const fallback = withBase(FOOTER_FONT_URL);
  for (const url of wanted === fallback ? [wanted] : [wanted, fallback]) {
    try {
      const bytes = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(`font fetch failed: ${url} (${r.status})`);
        return r.arrayBuffer();
      });
      // NOT SUBSETTED, although subsetting would save about 216KB a bundle.
      //
      // pdf-lib's embedFont defaults to subset:false, writing the whole font
      // file in: Liberation Sans is 410,712 bytes and a footer draws about
      // fifteen glyphs. On a 30-document, 237-page bundle the footer is 459KB
      // of a 650KB file; subsetting would take it to 243KB.
      //
      // Subsetting moves the label, though: in the serif font "Bundle Page
      // 999" renders 1.20pt off centre vertically, against the 0.5pt tolerance
      // tests/footer.test.mjs holds it to. inkBandAtSize() reads
      // font.embedder.font, the full parsed fontkit object, so the PREDICTED
      // ink band comes from the full font while the RENDER goes through the
      // subset embedder, and subsetting separates the two. A check that
      // compares predicted band with predicted band cannot see that; only
      // rendering at 600dpi and measuring the ink can, which is what that
      // test does. Any change here has to pass it. The drift depends on the
      // font (Liberation Sans is clean, serif is not), so subsetting per font,
      // gated on that test, is possible.
      return await pdfDoc.embedFont(bytes);
    } catch (err) {
      if (url === fallback) throw err;
      console.warn(`[pages] footer font ${url} unusable (${err.message}); falling back to Liberation Sans`);
    }
  }
  throw new Error(`font fetch failed: ${fallback}`);
}

/**
 * @param {File} file
 * @returns {Promise<number>}
 */
export async function countPdfPages(file) {
  const { doc } = await loadPdf(await file.arrayBuffer());
  return doc.getPageCount();
}

/**
 * Validates an uploaded PDF and reports its page count.
 *
 * @param {Uint8Array} pdfBytes
 * @returns {Promise<{pageCount: number, damaged: boolean, disclosure: string|null}
 *                  |{error: string, errorKind: 'encrypted'|'unreadable'}>}
 */
export async function validateAndCountPages(pdfBytes) {
  try {
    const result = await loadPdf(pdfBytes);
    return {
      pageCount: result.pageCount,
      damaged: result.damaged,
      disclosure: result.disclosure,
      // Uses the parse loadPdf already did, so recognising a bundle costs no
      // second read of the file. null for an ordinary PDF, and null again if
      // detection itself fails: an add is never blocked.
      bundle: detectBundle(result.doc),
      // One-based pages carrying /Redact markers that were never applied ([] when none, and
      // [] again if the check itself fails: never a blocked add). See bundletoolPdfSafety.js.
      redactedPages: findUnappliedRedactions(result.doc),
      // Page count and size, attachments and forms, read from the same parse (see bundletoolPdfInspect.js).
      inspect: { ...readPdfFacts(result.doc), expanding: await findExpandingStreams(result.doc) },
    };
  } catch (err) {
    if (err instanceof EncryptedPdfError) {
      return { error: err.userMessage, errorKind: 'encrypted' };
    }
    if (err instanceof UnreadablePdfError) {
      return { error: err.userMessage, errorKind: 'unreadable' };
    }
    return { error: err.message ?? 'Not a valid PDF', errorKind: 'unreadable' };
  }
}

/**
 * Wraps one or more pictures into a PDF, one page per picture, so a photographed or
 * scanned exhibit can be added like any other document.
 *
 * Every page is A4 (or the bundle's page size) portrait with a small margin, the picture
 * fitted inside it at its own aspect ratio and never enlarged: a photo of a document
 * should print like a document, not as a page the size of the camera sensor. The pictures
 * are JPEG or PNG bytes; other formats are turned into those by bundletoolImages.js first.
 *
 * @param {Array<{bytes: Uint8Array, kind: 'jpeg'|'png'}>} pictures
 * @param {string} [pageSizeKey]
 * @returns {Promise<Uint8Array>} a PDF with one page per picture
 */
export async function imagesToPdf(pictures, pageSizeKey) {
  if (!pictures?.length) throw new Error('No pictures to add');
  const doc = await PDFDocument.create();
  const A4 = pageDimensions(pageSizeKey);
  const MARGIN = 36;
  const maxW = A4[0] - 2 * MARGIN;
  const maxH = A4[1] - 2 * MARGIN;
  for (const { bytes, kind } of pictures) {
    const image = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const scale = Math.min(maxW / image.width, maxH / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    const page = doc.addPage(A4);
    page.drawImage(image, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
  }
  return doc.save();
}

/**
 * Wraps a JPG or PNG into a one-page PDF (see imagesToPdf). The format is read from the
 * bytes' own magic numbers, never the filename.
 *
 * @param {Uint8Array} imageBytes
 * @returns {Promise<Uint8Array>} a one-page PDF
 * @throws {Error} when the bytes are not a JPG or PNG
 */
export async function imageToPdf(imageBytes, pageSizeKey) {
  const isPng = imageBytes.length > 8
    && imageBytes[0] === 0x89 && imageBytes[1] === 0x50 && imageBytes[2] === 0x4e && imageBytes[3] === 0x47;
  const isJpg = imageBytes.length > 3 && imageBytes[0] === 0xff && imageBytes[1] === 0xd8;
  if (!isPng && !isJpg) throw new Error('Not a JPG or PNG image');
  return imagesToPdf([{ bytes: imageBytes, kind: isPng ? 'png' : 'jpeg' }], pageSizeKey);
}

/**
 * Turns the pages of a document by a multiple of 90 degrees, clockwise for a
 * positive number, and returns the new bytes: every page, or only the pages
 * listed.
 *
 * The turn is ADDED to each page's own /Rotate (a scan often already carries
 * one), modulo 360, so turning right and then left gives back the original
 * orientation. It is written into the file itself rather than remembered
 * beside it: the build, the page numbers, the Download button and the autosave
 * all read the same bytes and so all agree without knowing rotation exists.
 * A page's content is drawn in its own space, under its /Rotate, so its text
 * layer (an OCR layer included) turns with it. Page content, count, every
 * page not listed and every other entry are untouched.
 *
 * @param {Uint8Array} pdfBytes  a PDF that is neither encrypted nor unreadable
 * @param {number} deltaDegrees  a multiple of 90 (positive is clockwise)
 * @param {number[]} [pageIndices]  the pages to turn, counted from 0; every page when left out
 * @returns {Promise<Uint8Array>}
 */
export async function rotatePdfBytes(pdfBytes, deltaDegrees, pageIndices) {
  if (!Number.isInteger(deltaDegrees) || deltaDegrees % 90 !== 0) {
    throw new Error('A page can only be turned by a multiple of 90 degrees');
  }
  const { doc } = await loadPdf(pdfBytes);
  const pages = doc.getPages();
  const chosen = pageIndices == null ? pages.map((_, i) => i) : [...new Set(pageIndices)];
  for (const i of chosen) {
    if (!Number.isInteger(i) || i < 0 || i >= pages.length) throw new Error(`This document has no page ${Number(i) + 1} to turn`);
  }
  const turn = ((deltaDegrees % 360) + 360) % 360;
  for (const i of chosen) {
    pages[i].setRotation(degrees((pages[i].getRotation().angle + turn) % 360));
  }
  return doc.save();
}

/**
 * Encrypts a finished bundle with the password the user chose at create time.
 *
 * The password is applied as both user and owner password: the recipient a
 * bundle is sent to needs to open it, print it and copy from it, so a split
 * permission model would only get in the court's way. The password NEVER
 * travels through the Config object: config is serialised into the bundle's
 * own metadata by setMetadata(), and a password stored inside the document it
 * protects is not a password.
 *
 * @param {Uint8Array} pdfBytes - the finished bundle
 * @param {string} password
 * @returns {Promise<Uint8Array>} encrypted bytes
 */
export async function encryptPdf(pdfBytes, password) {
  const doc = await loadPdf(pdfBytes).then((r) => r.doc);
  await doc.encrypt({ userPassword: password, ownerPassword: password });
  return doc.save();
}

/**
 * Page count and unapplied-redaction pages of a stored file in one read, for documents that come back
 * from a reopened bundle rather than through the add path's validation.
 *
 * @param {File|Blob} file
 * @returns {Promise<{pageCount: number, redactedPages: number[]}>}
 */
export async function inspectPdf(file) {
  const { doc } = await loadPdf(await file.arrayBuffer());
  return { pageCount: doc.getPageCount(), redactedPages: findUnappliedRedactions(doc) };
}

/**
 * Removes pages from a document and returns the new bytes. A document always keeps at least one page.
 *
 * A removed page is gone from the file, not only from its page list. Anything that still named it (a bookmark, a
 * link on another page, a form field's widget) names nothing, and every object only the removed pages used (their
 * content, pictures and fonts) is left out of the saved file, so what was on a removed page cannot be read back out
 * of the document. The pages kept are untouched, text layers and all.
 *
 * @param {Uint8Array} pdfBytes  a PDF that is neither encrypted nor unreadable
 * @param {number[]} pageIndices  the pages to remove, counted from 0
 * @returns {Promise<Uint8Array>}
 */
export async function removePdfPages(pdfBytes, pageIndices) {
  const { doc } = await loadPdf(pdfBytes);
  const count = doc.getPageCount();
  const chosen = [...new Set(pageIndices ?? [])].sort((a, b) => b - a);
  if (chosen.length === 0) throw new Error('No page was chosen to remove');
  for (const i of chosen) {
    if (!Number.isInteger(i) || i < 0 || i >= count) throw new Error(`This document has no page ${Number(i) + 1} to remove`);
  }
  if (chosen.length >= count) throw new Error('A document keeps at least one page');
  const removed = new Set(chosen.map((i) => doc.getPage(i).ref.tag));
  for (const i of chosen) doc.removePage(i);
  const { context } = doc;
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (removed.has(ref.tag)) context.delete(ref);
    else forgetReferences(object, removed);
  }
  const { Root, Info, Encrypt } = context.trailerInfo;
  const keep = reachableFrom(context, [Root, Info, Encrypt]);
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!keep.has(ref.tag)) context.delete(ref);
  }
  return doc.save();
}

/** Replaces, inside one object, every reference to an object in `gone` with null. */
function forgetReferences(object, gone) {
  if (object instanceof PDFStream) {
    forgetReferences(object.dict, gone);
  } else if (object instanceof PDFDict) {
    for (const [key, value] of object.entries()) {
      if (value instanceof PDFRef && gone.has(value.tag)) object.set(key, PDFNull);
      else forgetReferences(value, gone);
    }
  } else if (object instanceof PDFArray) {
    for (let i = 0; i < object.size(); i++) {
      const value = object.get(i);
      if (value instanceof PDFRef && gone.has(value.tag)) object.set(i, PDFNull);
      else forgetReferences(value, gone);
    }
  }
}

/** The tags of every indirect object reachable from `roots`, the roots included. */
function reachableFrom(context, roots) {
  const seen = new Set();
  const stack = [];
  const take = (value) => {
    if (value instanceof PDFRef) {
      if (!seen.has(value.tag)) { seen.add(value.tag); stack.push(value); }
    } else if (value instanceof PDFStream) {
      take(value.dict);
    } else if (value instanceof PDFDict) {
      for (const [, v] of value.entries()) take(v);
    } else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) take(value.get(i));
    }
  };
  roots.filter(Boolean).forEach(take);
  while (stack.length) take(context.lookup(stack.pop()));
  return seen;
}

/** One-based pages of a coversheet upload that carry unapplied redaction markers (only page 1 is used). */
export async function coverRedactionPages(file) {
  const { doc } = await loadPdf(await file.arrayBuffer());
  return findUnappliedRedactions(doc).filter((n) => n === 1);
}

/**
 * Validates a coversheet and returns its first page as a fresh one-page PDF.
 * Copying into a new document drops embedded files and other detritus.
 *
 * @param {File} file
 * @returns {Promise<Uint8Array>}
 */
export async function validateCoverPage(file) {
  const { doc: input } = await loadPdf(await file.arrayBuffer());
  if (input.getPageCount() === 0) throw new CoverPageError('has no pages');
  // The cover is the person's own document: scripts, attachments and links into pages that will
  // not come along are cleaned out first, exactly as for a document in the table.
  prepareSourceForMerge(input);
  const single = await PDFDocument.create();
  const [first] = await single.copyPages(input, [0]);
  single.addPage(first);
  // Only the first page is kept, so only it is checked: a page far larger than paper, or one whose data
  // unpacks to gigabytes, would be drawn into every bundle.
  const { width, height } = first.getSize();
  if (Math.max(width, height) > MAX_PAGE_POINTS) {
    throw new CoverPageError('has a first page far larger than paper (about ' + (Math.max(width, height) / 72 * 0.0254).toFixed(1) + ' metres across)');
  }
  if (await findExpandingStreams(single)) throw new CoverPageError('has a first page that holds data unpacking to far more than its size, which can crash a PDF reader');
  return single.save();
}

/** A coversheet PDF that cannot be used for a reason the person can act on; `userMessage` finishes "the file ...". */
export class CoverPageError extends Error {
  constructor(userMessage) {
    super(`The coversheet ${userMessage}.`);
    this.name = 'CoverPageError';
    this.userMessage = userMessage;
  }
}

/** i, ii, iii… for front matter numbered the printed-bundle way. */
function toRoman(n) {
  const table = [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],
                 [50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']];
  let out = '';
  for (const [v, sym] of table) while (n >= v) { out += sym; n -= v; }
  return out;
}

/**
 * Works out the per-page footer text for the whole document.
 *
 * Kept out of the drawing loop so both the direct and worker paths compute it
 * identically, and so the widest label, which the blanking rectangle is sized
 * from, is known before the first page is drawn.
 *
 * @param {Object} cv - flat config values
 * @param {Array<string>} pageLabels - sparse per-page section labels
 * @param {number} totalPageCount
 * @returns {{texts: string[], style: string}}
 */
export function buildFooterTexts(cv, pageLabels, totalPageCount, frontMatterCount = 0) {
  const style = cv['pageNumbering.numberingStyle'] || 'PageX';
  const prefix = cv['pageNumbering.footerPrefix'] ?? '';
  const perSection = cv['pageNumbering.pageNumberPerSection'];
  // How the cover and index are numbered. The DOCUMENTS always start at 1
  // under roman and skip, which is the point of both: a reader given "page
  // 12" should find it in the evidence, not four pages into the index.
  const front = cv['pageNumbering.frontMatterNumbering'] || 'continuous';
  const fm = front === 'continuous' ? 0 : Math.max(0, frontMatterCount);

  const texts = [];
  for (let i = 0; i < totalPageCount; i++) {
    if (i < fm) {
      // Front matter: roman numerals, or nothing at all.
      texts.push(front === 'roman' ? toRoman(i + 1) : '');
      continue;
    }
    const n = i - fm + 1;
    const display = perSection && pageLabels[i] != null ? pageLabels[i] : n;
    const total = totalPageCount - fm;
    const formats = {
      PageX:    `Page ${display}`,
      PageXofY: perSection ? `Page ${display}` : `Page ${n} of ${total}`,
      X:        `${display}`,
      XofY:     perSection ? `${display}` : `${n} of ${total}`,
      XslashY:  perSection ? `${display}` : `${n}/${total}`,
    };
    // A label carries no zero-width characters. pdf-lib does not use the
    // shaper's positions, so a U+200B ZERO WIDTH SPACE is drawn with the
    // advance width of whatever glyph it maps to (the ordinary space, in
    // Liberation Sans) and is written into the CIDFont /W array the same way.
    // Two of them would add 10pt of leading whitespace at 18pt, measured into
    // the plate's width and drawn onto the page, pushing the visible label 5pt
    // right of the centre of its box. The text extracted from the PDF would
    // hold two ordinary spaces rather than U+200B, so they would not work as a
    // search marker either.
    texts.push(`${prefix ? `${prefix} ` : ''}${formats[style] || formats.PageX}`);
  }
  return { texts, style };
}

/** The wording on a blank page that printable mode adds, so it is never taken for a page of the document before it. */
export const PADDING_PAGE_TEXT = 'This page is intentionally left blank';

/**
 * Writes PADDING_PAGE_TEXT, small and grey, across the middle of each page index given.
 *
 * @param {Array} pages - the document's pages
 * @param {number[]} indices - zero-based indices of the pages printable mode added
 * @param {Object} font - an embedded font
 */
function markPaddingPages(pages, indices, font) {
  const size = 11;
  const textWidth = font.widthOfTextAtSize(PADDING_PAGE_TEXT, size);
  for (const index of indices) {
    const page = pages[index];
    if (!page) continue;
    const { width, height } = page.getSize();
    page.drawText(PADDING_PAGE_TEXT, { x: (width - textWidth) / 2, y: height / 2, size, font, color: rgb(0.45, 0.45, 0.45) });
  }
}

/**
 * Applies the page-number footer to every page of an ALREADY-PARSED document.
 *
 * This is the footer pass with the parse and serialise peeled off, so the
 * single-pass build worker can run it against the document it is already
 * holding instead of paying a full parse and save round trip for the footer
 * alone. applyPageNumbering() below is the wrapper that takes and returns
 * bytes.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @param {Object} cv - flat config values
 * @param {Array<string>} [pageLabels]
 * @param {number|null} [indexPageIndex] - page the footer links to
 * @param {number} [frontMatterCount]
 * @param {{blankFloorTexts?: string[], paddingPages?: number[]}} [opts] - paddingPages: the pages printable
 *   mode added, which carry PADDING_PAGE_TEXT
 */
export async function applyPageNumberingToDoc(doc, cv, pageLabels = [], indexPageIndex = null, frontMatterCount = 0, { blankFloorTexts = [], paddingPages = [] } = {}) {
  // Independent of the footer below: a watermark with page numbering set to
  // 'None' is a legitimate combination (a draft stamp with no footer at
  // all), so this runs before the early return rather than after it.
  if (cv['pageOptions.watermark'] === true) {
    await applyWatermarkToDoc(
      doc,
      cv['pageOptions.watermarkText'] || 'CONFIDENTIAL',
      cv['pageOptions.watermarkColour'],
      cv['pageOptions.watermarkOpacity'],
    );
  }
  const numbered = (cv['pageNumbering.numberingStyle'] || 'PageX') !== 'None';
  if (!numbered && paddingPages.length === 0) return;

  doc.registerFontkit(await getFontkit());
  const pages = doc.getPages();
  const font = await loadFooterFont(doc, cv['pageNumbering.footerFont']);
  // Printable mode's blank pages say what they are, with or without page numbers.
  markPaddingPages(pages, paddingPages, font);
  if (!numbered) return;

  // Medium reproduces BundleToolCLI exactly (12pt text in a 26pt plate, the
  // size of the bundles it makes); small and large step either side.
  let fontSize = ({ large: 16, medium: 12, small: 10 })[cv['pageNumbering.footerFontSize']] || 12;
  const { texts } = buildFooterTexts(cv, pageLabels, pages.length, frontMatterCount);

  // Shrink until the widest label fits comfortably across an A4 page. This is
  // recomputed over EVERY label, not sampled from page 1: "Bundle Page 1000" is
  // 20pt wider than "Bundle Page 1", and a width taken from the first page
  // would overflow its box for the whole of a four-digit bundle.
  // The width the label is shrunk against follows the bundle's page size:
  // on Letter the same label has 17pt more room, and on a narrow size it
  // must shrink sooner or it overflows its box.
  const A4_WIDTH = pageWidth(cv['pageOptions.pageSize']);
  const widest = () => texts.reduce((m, t) => Math.max(m, font.widthOfTextAtSize(t, fontSize)), 0);
  let maxTextWidth = widest();
  while (maxTextWidth > (2 * A4_WIDTH / 3) && fontSize > 6) {
    fontSize -= 1;
    maxTextWidth = widest();
  }
  // Labels a footer drawn earlier may have carried (a split part renumbers pages that already show
  // the whole bundle's numbers): the blanking box is at least as wide as the widest of them, so a
  // longer old label such as "Page 148 of 320" never shows beside a shorter new one.
  if (blankFloorTexts.length > 0) {
    const floor = blankFloorTexts.reduce((m, t) => Math.max(m, font.widthOfTextAtSize(t, fontSize)), 0);
    maxTextWidth = Math.max(maxTextWidth, floor);
  }

  // Measured once for the document, so the baseline is identical on every page.
  const textInk = inkBandAtSize(font, texts, fontSize);

  // Named presets, for a bundle or autosave snapshot that stores a colour
  // name rather than a hex value, so it keeps its exact colour.
  const colourMap = {
    black: rgb(0.072, 0.021, 0.073),
    red:   rgb(0.872, 0.032, 0.101),
    blue:  rgb(0.083, 0.221, 0.873),
  };
  const pageNumberColourRaw = String(cv['pageNumbering.pageNumberColour'] ?? '').trim().toLowerCase();
  const colour = /^#[0-9a-f]{6}$/.test(pageNumberColourRaw)
    ? rgb(
      parseInt(pageNumberColourRaw.slice(1, 3), 16) / 255,
      parseInt(pageNumberColourRaw.slice(3, 5), 16) / 255,
      parseInt(pageNumberColourRaw.slice(5, 7), 16) / 255,
    )
    : colourMap[pageNumberColourRaw] ?? colourMap.black;
  const align = cv['pageNumbering.alignment'] || 'centre';

  // The plate's colour and opacity are settings, so the grey box can be
  // tinted or removed. The default hex is the CLI's composited grey, for
  // which null is passed through so the plate is drawn with the grey operator.
  const plateHex = String(cv['pageNumbering.plateColour'] ?? '').trim().toLowerCase();
  const plateColour = /^#[0-9a-f]{6}$/.test(plateHex) && plateHex !== '#f4f4f4'
    ? rgb(
      parseInt(plateHex.slice(1, 3), 16) / 255,
      parseInt(plateHex.slice(3, 5), 16) / 255,
      parseInt(plateHex.slice(5, 7), 16) / 255,
    )
    : null;
  const rawOpacity = Number(cv['pageNumbering.plateOpacity']);
  const plateOpacity = Number.isFinite(rawOpacity)
    ? Math.min(1, Math.max(0, rawOpacity / 100))
    : 1;

  const offset = Number(cv['pageNumbering.footerOffset']) || 0;
  pages.forEach((page, i) => {
    // A blank label means this page is deliberately unnumbered (front matter
    // under "skip"). Drawing it would leave an empty plate, which looks like
    // a printing fault rather than a choice.
    if (!texts[i]) return;
    drawFooterOnPage(doc, page, {
      text: texts[i],
      offset,
      font,
      fontKey: registerPageFont(page, font),
      fontSize,
      colour,
      align,
      maxTextWidth,
      textInk,
      indexPageIndex,
      plateColour,
      plateOpacity,
    });
  });
}

/**
 * Applies the page-number footer to every page.
 *
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 * @param {Object} cv - flat config values
 * @param {Array<string>} [pageLabels]
 * @param {number|null} [indexPageIndex] - page the footer links to
 * @returns {Promise<Uint8Array>}
 */
export async function applyPageNumbering(pdfBytes, cv, pageLabels = [], indexPageIndex = null, frontMatterCount = 0) {
  const numberingOff = (cv['pageNumbering.numberingStyle'] || 'PageX') === 'None';
  const watermarkOn  = cv['pageOptions.watermark'] === true;
  if (numberingOff && !watermarkOn) {
    // Nothing to draw, so return the bytes untouched rather than paying for a
    // full parse and re-serialise of the whole bundle to produce a copy.
    return pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  }

  const { doc } = await loadPdf(pdfBytes);
  await applyPageNumberingToDoc(doc, cv, pageLabels, indexPageIndex, frontMatterCount);
  return doc.save();
}

/**
 * Pre-computes the sparse per-page section labels used when page numbering
 * restarts within each section.
 *
 * @param {Array<Object>|null} tocEntries
 * @param {boolean} perSection
 * @returns {Array<string>}
 */
export function buildPageLabels(tocEntries, perSection) {
  const labels = [];
  if (!perSection || !tocEntries) return labels;
  for (const section of tocEntries) {
    for (const entry of section.entries) {
      const startIdx = (entry.actualPdfStartPageWithToc || entry.beginsOnPdfPage) - 1;
      const label = section.sectionLabel || '';
      for (let p = 0; p < entry.pageCount; p++) {
        labels[startIdx + p] = `${label}${entry.beginsOnPageOfSection + p}`;
      }
      if (entry.blankPageAfter) {
        labels[startIdx + entry.pageCount] = `${label}${entry.beginsOnPageOfSection + entry.pageCount}`;
      }
    }
  }
  return labels;
}

/**
 * Flattens a Config instance into the plain dictionary the footer path uses.
 * @param {Object} config
 * @returns {Object}
 */
export function flattenFooterConfig(config) {
  const keys = [
    'pageNumbering.footerPrefix', 'pageNumbering.alignment', 'pageNumbering.numberingStyle',
    'pageNumbering.footerFont', 'pageNumbering.footerFontSize', 'pageNumbering.pageNumberColour',
    'pageNumbering.pageNumberPerSection',
    'pageNumbering.plateColour', 'pageNumbering.plateOpacity',
    'pageOptions.pageSize', 'pageOptions.watermark', 'pageOptions.watermarkText',
    'pageOptions.watermarkColour', 'pageOptions.watermarkOpacity',
    'pageNumbering.frontMatterNumbering', 'pageNumbering.footerOffset',
  ];
  const out = {};
  for (const key of keys) out[key] = config.getOption(key);
  return out;
}

/**
 * Direct (non-worker) page numbering, kept for tests and for callers that
 * already hold a parsed document's bytes on the main thread.
 *
 * @param {Uint8Array} pdfDocBytes
 * @param {Object} config
 * @param {Array<Object>|null} [tocEntries]
 * @param {number|null} [indexPageIndex]
 * @returns {Promise<Uint8Array>}
 */
export async function addPageNumberingToPdf(pdfDocBytes, config, tocEntries = null, indexPageIndex = null) {
  const cv = flattenFooterConfig(config);
  const labels = buildPageLabels(tocEntries, cv['pageNumbering.pageNumberPerSection']);
  return applyPageNumbering(pdfDocBytes, cv, labels, indexPageIndex);
}

// --- worker-based version ---

const FOOTER_WORKER_URL = new URL('./workers/bundletoolFooterWorker.js', import.meta.url);

/** Worker peak reading from the most recent footer worker run. */
export const footerWorkerPeaks = {};

/**
 * Runs the footer pass inside a dedicated worker. The input buffer is
 * transferred, so the caller must not use it afterwards.
 *
 * @param {Uint8Array} pdfBytes
 * @param {Object} config
 * @param {Array<Object>|null} [tocEntries]
 * @param {number|null} [indexPageIndex]
 * @returns {Promise<Uint8Array>}
 */
export function addPageNumberingViaWorker(pdfBytes, config, tocEntries = null, indexPageIndex = null) {
  if (config.getOption('pageNumbering.numberingStyle') === 'None' && config.getOption('pageOptions.watermark') !== true) {
    return Promise.resolve(pdfBytes);
  }

  const configValues = flattenFooterConfig(config);
  const pageLabels = buildPageLabels(tocEntries, configValues['pageNumbering.pageNumberPerSection']);
  const buf = pdfBytes.buffer.byteLength === pdfBytes.byteLength
    ? pdfBytes.buffer : pdfBytes.slice().buffer;

  return new Promise((resolve, reject) => {
    const worker = startWorker(FOOTER_WORKER_URL, { type: 'module' });
    watchForLazyLoadFailures(worker);

    worker.onmessage = (e) => {
      if (e.data?.ready) {
        worker.postMessage({ buffer: buf, configValues, pageLabels, indexPageIndex }, [buf]);
        return;
      }
      // Not this handler's message: watchForLazyLoadFailures() (attached above) has already turned it
      // into the reload toast. Only a worker's own failure (an {error} reply, below) ends the job;
      // treating this one as the final (empty) result would terminate the worker before its real reply
      // (the error the lazy-load failure itself is about to cause) arrives.
      if (e.data?.type === 'lazy-load-failed') return;
      worker.terminate();
      if (e.data?.workerPeakMB != null) footerWorkerPeaks.pageNumbering = e.data.workerPeakMB;
      if (e.data?.error) {
        const err = new Error(e.data.error);
        if (e.data.stack) err.stack = e.data.stack;
        reject(err);
      } else resolve(e.data.result);
    };

    worker.onerror = (e) => {
      console.error('[FooterWorker] onerror:', e.message, e);
      worker.terminate();
      reject(new Error(e.message ?? 'Worker error'));
    };

    worker.addEventListener('messageerror', (e) => {
      console.error('[FooterWorker] messageerror:', e);
      worker.terminate();
      reject(new Error('Worker messageerror'));
    });
  });
}
