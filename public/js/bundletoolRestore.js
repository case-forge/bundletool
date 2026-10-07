/**
 * BundleTool
 * Copyright (c) 2025-2026 Tris Sherliker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * A tool for the creation of legal bundles.
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolRestore.js
 * Unpacking a finished bundle PDF back into its documents.
 *
 * The bundle is parsed ONCE: openBundle() reads the metadata, the config and
 * the pages to split from a single parse, because a court bundle can be
 * hundreds of megabytes.
 *
 * Reading is deliberately more forgiving than writing. Writers only ever emit
 * the current format; readers understand every format this tool has produced,
 * because a firm's existing bundles do not rewrite themselves:
 *
 *   v3    entries and config in the Info dictionary   (current)
 *   v2    config in the Info dictionary, entries in a hidden FreeText annotation
 *   v1    flat array in the annotation, no sections
 *   none  no bundle index at all: fall back to the standard Title/Subject fields
 */

import { PDFDocument, PDFName, PDFArray, PDFRef, PDFDict, decodePDFRawStream } from './bundletoolPdfLib.js';
import { loadPdf } from './bundletoolPdfLoad.js';
import { readBundleIndex, BUNDLE_INDEX_KEY } from './bundletoolMeta.js';
import { removeTaggedFooters } from './bundletoolFooter.js';

export const DEFAULT_CONFIG = {
  heading: { claimNumber: '', bundleTitle: '', projectName: '', author: '' },
  pageNumbering: { footerFont: 'sansSerif', alignment: 'centre', numberingStyle: 'PageX', footerPrefix: '', pageNumberPerSection: false },
  index: { fontFace: 'sansSerif', dateStyle: 'DD Mon. YYYY', dateInputOrder: 'UK', outlineItemStyle: 'plain', sectionPrefix: '' },
  pageOptions: { printableBundle: false, coversheet: false, coverSource: 'none', watermark: false, watermarkText: '', watermarkColour: '#999999' },
  cover: { courtName: '', matterOf: '', applicantName: '', respondentName: '', partyLabel1: '', partyLabel2: '', extraText: '', claimNumber: null, bundleTitle: null, author: null },
};

/**
 * How a bundle's page 1 should be treated on reload.
 *
 * A bundle that records no `coverSource` has an uploaded coversheet or no
 * cover. Absent means 'uploaded' when there is a coversheet, because that is
 * the only thing it can be.
 *
 * @param {Object} config - the config read out of a bundle
 * @returns {'uploaded'|'generated'|'none'}
 */
export function coverSourceOf(config) {
  const stored = config?.pageOptions?.coverSource;
  if (stored === 'uploaded' || stored === 'generated' || stored === 'none') return stored;
  return config?.pageOptions?.coversheet === true ? 'uploaded' : 'none';
}

/**
 * For the v1 format: normalises bundle index metadata into the canonical
 * sections format. Metadata already in sections is returned as it is.
 *
 * @param {Array} metadata
 * @returns {Array} sections: {sectionID, sectionLabel, sectionName, files[]}
 */
export function normaliseBundleMetadata(metadata) {
  if (!Array.isArray(metadata) || metadata.length === 0) return metadata;
  if ('sectionID' in metadata[0]) return metadata;

  const sections = [];
  let current = { sectionID: '0000', sectionLabel: '', sectionName: '', files: [] };
  sections.push(current);
  let nextID = 1;

  for (const entry of metadata) {
    if (entry.section === true) {
      // "A: Background Documents" splits into label "A" and name. Only a short
      // prefix counts as a label; a longer one is part of the name itself.
      const raw = (entry.title || '').trim();
      const colonIdx = raw.indexOf(':');
      let label = '';
      let name = raw;
      if (colonIdx > 0 && colonIdx <= 3) {
        label = raw.slice(0, colonIdx).trim();
        name = raw.slice(colonIdx + 1).trim();
      }
      current = { sectionID: String(nextID++).padStart(4, '0'), sectionLabel: label, sectionName: name, files: [] };
      sections.push(current);
    } else if (entry.filename) {
      current.files.push({
        filename: entry.filename,
        title: entry.title || '',
        date: entry.date || '',
        page: entry.page,
      });
    }
  }
  return sections;
}

/**
 * Reads the hidden FreeText annotation that v1 and v2 bundles carry their
 * entry list in.
 *
 * BundleTool does not write it (see bundletoolMeta.js), but those bundles have
 * their entries nowhere else, and they have to keep opening.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @returns {Array|null}
 */
export function readLegacyAnnotationIndex(doc) {
  if (doc.getPageCount() === 0) return null;
  const context = doc.context;
  const page = doc.getPage(0);

  let annots = page.node.get(PDFName.of('Annots'));
  if (annots instanceof PDFRef) annots = context.lookup(annots);
  if (!(annots instanceof PDFArray)) return null;

  let newest = null;
  for (let i = 0; i < annots.size(); i++) {
    const annot = context.lookup(annots.get(i));
    if (!(annot instanceof PDFDict)) continue;
    const contentsObj = annot.get(PDFName.of('Contents'));
    if (!contentsObj?.decodeText) continue;
    const contents = contentsObj.decodeText();
    if (typeof contents !== 'string' || !contents.includes('BundleIndexData')) continue;

    const json = extractFirstJsonValue(contents);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json);
      newest = Array.isArray(parsed) ? parsed : [parsed];
    } catch (err) {
      console.warn('[restore] skipping unparseable BundleIndexData annotation:', err.message);
    }
  }
  return newest;
}

/**
 * Pulls the first balanced JSON array or object out of a string.
 * @param {string} text
 * @returns {string|null}
 */
function extractFirstJsonValue(text) {
  const bracket = text.indexOf('[');
  const brace = text.indexOf('{');
  let start = -1;
  let open = '[';
  let close = ']';
  if (bracket !== -1 && (brace === -1 || bracket < brace)) {
    start = bracket;
  } else if (brace !== -1) {
    start = brace;
    open = '{';
    close = '}';
  }
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Says whether a parsed PDF is a bundle this tool (or BunTool) made,
 * without splitting or restoring it. Used when a file is added to the table,
 * so it must be cheap against an already-parsed document and must NEVER throw:
 * a detection failure means "not a bundle", and the file is added normally.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc - already parsed
 * @returns {{version: number, documents: number}|null}
 */
export function detectBundle(doc) {
  try {
    const payload = readBundleIndex(doc);
    if (payload?.version >= 3 && Array.isArray(payload.sections)) {
      const documents = payload.sections.reduce((n, s) => n + (s.files?.length ?? 0), 0);
      return { version: payload.version, documents };
    }
    const legacy = readLegacyAnnotationIndex(doc);
    if (legacy) {
      const documents = legacy.filter((e) => e.section !== true && e.filename).length;
      return { version: payload?.version ?? 1, documents };
    }
  } catch (err) {
    console.warn('[restore] bundle detection failed; treating as an ordinary PDF:', err.message);
  }
  return null;
}

/**
 * Opens a bundle PDF once and returns everything the restore flow needs.
 *
 * @param {Uint8Array} bundleBytes
 * @returns {Promise<{doc: Object, metadata: Array|null, config: Object, version: number|null, damaged: boolean, disclosure: string|null}>}
 */
export async function openBundle(bundleBytes) {
  const { doc, damaged, disclosure } = await loadPdf(bundleBytes);

  const payload = readBundleIndex(doc);

  // v3: entries live in the Info dictionary alongside the config.
  if (payload?.version >= 3 && Array.isArray(payload.sections)) {
    return {
      doc,
      metadata: payload.sections,
      config: payload.config ?? DEFAULT_CONFIG,
      version: payload.version,
      damaged,
      disclosure,
    };
  }

  // v2 and earlier: config may be in the Info dictionary, entries are not.
  const legacy = readLegacyAnnotationIndex(doc);
  const config = payload?.config ?? configFromStandardFields(doc);
  return {
    doc,
    metadata: legacy,
    config,
    version: payload?.version ?? (legacy ? 1 : null),
    damaged,
    disclosure,
  };
}

/**
 * Reconstructs what config can be inferred from the ordinary metadata fields,
 * for bundles with no bundle index at all.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @returns {Object}
 */
export function configFromStandardFields(doc) {
  const title = doc.getTitle() || '';
  // Strip a fixed "CONFIDENTIAL " prefix, which some bundles carry in their
  // title, so it is not baked into the restored bundle title.
  const wasConfidential = title.startsWith('CONFIDENTIAL ');
  return {
    ...DEFAULT_CONFIG,
    heading: {
      claimNumber: (doc.getKeywords() || ''),
      bundleTitle: wasConfidential ? title.slice('CONFIDENTIAL '.length) : title,
      projectName: doc.getSubject() || '',
      author: doc.getAuthor() || '',
    },
  };
}

/**
 * Splits an opened bundle back into its constituent documents.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} bundlePdf - from openBundle
 * @param {Array} metadata
 * @param {boolean} [hasCoversheet]
 * @returns {Promise<Map<string, Uint8Array>>} filename → PDF bytes
 */
export async function splitBundlePdf(bundlePdf, metadata, hasCoversheet = false, onProgress = null) {
  if (!Array.isArray(metadata)) {
    throw new Error(`Invalid metadata: expected array, got ${typeof metadata}`);
  }

  const totalPages = bundlePdf.getPageCount();
  const isNewFormat = metadata.length > 0 && 'sectionID' in metadata[0];

  let documentEntries;
  if (isNewFormat) {
    documentEntries = [];
    for (const section of metadata) {
      for (const file of section.files ?? []) {
        if (file.filename && file.page != null) {
          documentEntries.push({ filename: file.filename, page: file.page });
        }
      }
    }
    documentEntries.sort((a, b) => a.page - b.page);
  } else {
    documentEntries = metadata.filter((e) => e.section !== true && e.filename && e.page != null);
  }

  if (documentEntries.length === 0) {
    console.warn('[restore] no document entries found in metadata');
    return new Map();
  }

  const extracted = new Map();

  for (let i = 0; i < documentEntries.length; i++) {
    const entry = documentEntries[i];
    const next = documentEntries[i + 1];
    const start = Math.max(0, entry.page - 1);
    const end = Math.min(next ? next.page - 1 : totalPages, totalPages);

    if (start >= end) {
      // Position, not filename: client document names stay out of the console.
      console.warn(`[restore] skipping document ${i + 1}: empty page range [${start}, ${end})`);
      continue;
    }

    const indices = [];
    for (let p = start; p < end; p++) indices.push(p);

    onProgress?.(i + 1, documentEntries.length);

    try {
      const out = await PDFDocument.create();
      const pages = await out.copyPages(bundlePdf, indices);
      for (const page of pages) out.addPage(page);
      let bytes = await out.save();
      bytes = await removePageNumbering(bytes);
      extracted.set(entry.filename, bytes);
    } catch (err) {
      console.error(`[restore] failed to extract document ${i + 1}:`, err);
      // Keep the raw page range so the document still appears in the table and
      // the user can decide whether to replace it with the original.
      try {
        const fallback = await PDFDocument.create();
        const pages = await fallback.copyPages(bundlePdf, indices);
        for (const page of pages) fallback.addPage(page);
        extracted.set(entry.filename, await fallback.save());
        console.warn(`[restore] stored raw fallback for document ${i + 1}`);
      } catch (fallbackErr) {
        console.error(`[restore] fallback also failed for document ${i + 1}:`, fallbackErr);
      }
    }
  }

  if (hasCoversheet) {
    const cover = await PDFDocument.create();
    const [page] = await cover.copyPages(bundlePdf, [0]);
    cover.addPage(page);
    let bytes = await cover.save();
    // The coversheet gets the same treatment as every other extracted
    // document, footer removal included, so a reused coversheet does not carry
    // the last bundle's page 1 footer into the next bundle.
    bytes = await removePageNumbering(bytes);
    bytes = await stripBundleIndexAnnotations(bytes);
    extracted.set('coversheet.pdf', bytes);
  }

  console.log(`[restore] split bundle into ${extracted.size} documents`);
  return extracted;
}

/**
 * Removes the hidden BundleIndexData annotation (the v1 and v2 entry list)
 * from a PDF.
 *
 * BundleTool does not write this annotation, but an extracted coversheet still
 * needs it stripped: the coversheet is a copy of bundle page 1, which is where
 * v1 and v2 bundles keep it. Reused in a new bundle, a stale annotation is a
 * second answer to "what is in this bundle" sitting inside a bundle that has
 * its own, and the v1/v2 reader would find it if the current metadata ever
 * failed to parse.
 *
 * @param {Uint8Array} pdfBytes
 * @returns {Promise<Uint8Array>}
 */
export async function stripBundleIndexAnnotations(pdfBytes) {
  try {
    const { doc } = await loadPdf(pdfBytes);
    const context = doc.context;
    let removed = 0;

    for (const page of doc.getPages()) {
      let annots = page.node.get(PDFName.of('Annots'));
      if (annots instanceof PDFRef) annots = context.lookup(annots);
      if (!(annots instanceof PDFArray)) continue;

      const keep = [];
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const annot = context.lookup(ref);
        const contents = annot instanceof PDFDict ? annot.get(PDFName.of('Contents')) : null;
        const text = contents?.decodeText ? contents.decodeText() : null;
        if (typeof text === 'string' && text.includes('BundleIndexData')) removed++;
        else keep.push(ref);
      }
      if (keep.length === annots.size()) continue;

      const replacement = PDFArray.withContext(context);
      for (const ref of keep) replacement.push(ref);
      page.node.set(PDFName.of('Annots'), replacement);
    }

    if (removed === 0) return pdfBytes;
    console.log(`[restore] stripped ${removed} legacy BundleIndexData annotation(s)`);
    // Also drop the Info-dictionary index, so an extracted coversheet cannot
    // masquerade as a bundle in its own right.
    doc.getInfoDict().delete(PDFName.of(BUNDLE_INDEX_KEY));
    return doc.save();
  } catch (err) {
    console.error('[restore] error stripping BundleIndexData annotations:', err);
    return pdfBytes;
  }
}

// ── Footer removal ───────────────────────────────────────────────────────────

/**
 * The RGB fill colours BundleTool uses for footer text. Every bundle this tool
 * produces has them, so they identify a footer that is not in its own tagged
 * content stream.
 *
 * Do not change these values: they are the only handle on such footers in
 * bundles people already have.
 */
export const FOOTER_COLOURS = [
  '0.072 0.021 0.073',
  '0.872 0.032 0.101',
  '0.083 0.221 0.873',
];

const FOOTER_COLOUR_RE = new RegExp(
  `(?:${FOOTER_COLOURS.map((c) => c.replace(/ /g, '\\s+')).join('|')})\\s+rg`,
);

/**
 * Largest content-stream block that will be accepted as "a footer".
 *
 * A footer is a blanking rectangle, a plate and a short string: a few hundred
 * bytes. Body content is not. This cap is the last line of defence against
 * deleting a page's contents, and it is why the size is checked before the
 * block is removed rather than after.
 */
const MAX_FOOTER_BLOCK_BYTES = 2048;

/** Operators that never appear in a footer and always mean real page content. */
const CONTENT_OPERATOR_RE = /(?:^|[\s\]>)])(?:Do|BI|sh|EI)(?:[\s[<(/]|$)/;

/**
 * Finds the byte offsets of top-level `q` and `Q` operators in a content stream.
 *
 * A naive search for the letters is wrong: `q` and `Q` occur inside literal
 * strings, `(Quote)`, inside hex strings and inside comments, and treating
 * one of those as a graphics-state operator unbalances everything after it.
 * This walks the stream tracking those three states and only records `q`/`Q`
 * when they stand alone as operators.
 *
 * @param {string} text
 * @returns {Array<{index: number, char: string}>}
 */
export function findGraphicsStateOperators(text) {
  const found = [];
  const isDelimiter = (c) => c === undefined || /[\s()<>[\]{}/%]/.test(c);

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (c === '%') {                                  // comment to end of line
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (c === '(') {                                  // literal string, nestable
      let depth = 1;
      i++;
      while (i < text.length && depth > 0) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        i++;
      }
      continue;
    }
    if (c === '<' && text[i + 1] !== '<') {           // hex string
      while (i < text.length && text[i] !== '>') i++;
      i++;
      continue;
    }
    if ((c === 'q' || c === 'Q') && isDelimiter(text[i - 1]) && isDelimiter(text[i + 1])) {
      found.push({ index: i, char: c });
    }
    i++;
  }
  return found;
}

/**
 * Removes BundleTool footer blocks from a decoded content stream.
 *
 * A plain regex such as `q[\s\S]*?<colour> rg[\s\S]*?Q` is not safe here: it
 * matches from the FIRST `q` in the stream to the FIRST `Q` after the colour.
 * That only works while each footer sits in its own self-contained q/Q block,
 * which is true of the streams pdf-lib writes and not guaranteed of anything
 * else. Against a producer that puts body content and the footer in one
 * stream, or that nests graphics states, it would swallow the body content
 * between them and leave an unbalanced `Q` behind.
 *
 * This finds the INNERMOST balanced q/Q block that actually contains the footer
 * colour, and removes a block only if it is small enough and draws nothing but
 * text and rectangles.
 *
 * @param {string} text - decoded content stream
 * @returns {{cleaned: string, removed: number}}
 */
export function stripFooterBlocks(text) {
  if (!FOOTER_COLOUR_RE.test(text)) return { cleaned: text, removed: 0 };

  const ops = findGraphicsStateOperators(text);
  if (ops.length === 0) return { cleaned: text, removed: 0 };

  // Pair every q with its matching Q.
  const blocks = [];
  const stack = [];
  for (const op of ops) {
    if (op.char === 'q') stack.push(op.index);
    else if (stack.length > 0) blocks.push({ start: stack.pop(), end: op.index + 1 });
  }
  if (blocks.length === 0) return { cleaned: text, removed: 0 };

  // Every position where a footer colour is set.
  const colourPositions = [];
  const globalColourRe = new RegExp(FOOTER_COLOUR_RE.source, 'g');
  let m;
  while ((m = globalColourRe.exec(text)) !== null) colourPositions.push(m.index);

  const doomed = [];
  for (const pos of colourPositions) {
    // Innermost enclosing block = the shortest one containing this position.
    let best = null;
    for (const block of blocks) {
      if (block.start <= pos && pos < block.end) {
        if (!best || (block.end - block.start) < (best.end - best.start)) best = block;
      }
    }
    if (!best) continue;
    if (best.end - best.start > MAX_FOOTER_BLOCK_BYTES) continue;
    const body = text.slice(best.start, best.end);
    if (CONTENT_OPERATOR_RE.test(body)) continue;
    if (!doomed.some((d) => d.start === best.start && d.end === best.end)) doomed.push(best);
  }
  if (doomed.length === 0) return { cleaned: text, removed: 0 };

  doomed.sort((a, b) => b.start - a.start); // remove from the end so offsets hold
  let cleaned = text;
  for (const block of doomed) {
    cleaned = cleaned.slice(0, block.start) + cleaned.slice(block.end);
  }
  return { cleaned, removed: doomed.length };
}

/**
 * Removes BundleTool page-number footers from a PDF.
 *
 * Two mechanisms, in order:
 *   1. Drop content streams tagged /BundleToolFooter. Exact, and the route for
 *      every footer this tool draws.
 *   2. Fall back to colour matching inside the remaining streams, for a footer
 *      that is not tagged.
 *
 * @param {Uint8Array} pdfBytes
 * @returns {Promise<Uint8Array>}
 */
export async function removePageNumbering(pdfBytes) {
  try {
    const { doc } = await loadPdf(pdfBytes);
    const context = doc.context;

    const taggedRemoved = removeTaggedFooters(doc);
    let blocksRemoved = 0;
    let pagesModified = 0;

    for (const page of doc.getPages()) {
      let contents = page.node.get(PDFName.of('Contents'));
      if (contents instanceof PDFRef) contents = context.lookup(contents);

      const streamRefs = contents instanceof PDFArray
        ? Array.from({ length: contents.size() }, (_, i) => contents.get(i))
        : (page.node.get(PDFName.of('Contents')) ? [page.node.get(PDFName.of('Contents'))] : []);

      let pageModified = false;
      for (const ref of streamRefs) {
        const stream = context.lookup(ref);
        if (!stream?.dict || !stream.contents) continue;

        let decoded;
        try {
          decoded = decodePDFRawStream(stream).decode();
        } catch {
          continue; // an undecodable stream is left exactly as it is
        }

        let text = '';
        for (let i = 0; i < decoded.length; i++) text += String.fromCharCode(decoded[i]);

        const { cleaned, removed } = stripFooterBlocks(text);
        if (removed === 0) continue;

        context.assign(ref, context.flateStream(cleaned));
        blocksRemoved += removed;
        pageModified = true;
      }
      if (pageModified) pagesModified++;
    }

    if (taggedRemoved === 0 && blocksRemoved === 0) return pdfBytes;
    console.log(`[restore] removed ${taggedRemoved} tagged footer stream(s) and ${blocksRemoved} legacy footer block(s) across ${pagesModified} page(s)`);
    return doc.save();
  } catch (err) {
    console.error('[restore] error removing page numbering:', err);
    return pdfBytes;
  }
}
