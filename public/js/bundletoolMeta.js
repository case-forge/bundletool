/**
 * BundleTool
 * Copyright (c) 2025-2026 Tris Sherliker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * A tool for the creation of legal bundles.
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolMeta.js
 * Index hyperlinks, bookmarks and bundle metadata.
 *
 * pdf-lib parses the document once, all three stages (index links, bookmarks,
 * metadata) change the same object graph, and it is serialised once at the
 * end, which saves two full parse-and-write passes over a document that can be
 * hundreds of megabytes.
 *
 * THE ENTRY LIST LIVES IN THE METADATA. pdf-lib has no length limit on an
 * Info-dictionary entry (tests/meta.test.mjs round-trips 100,000 characters
 * through it), so the whole bundle index, config and entries, is written to
 * /BundleIndex. v1 and v2 bundles keep their entries in a hidden zero-size
 * FreeText annotation on page 1 instead, which bundletoolRestore.js reads.
 *
 * Do not rename the key: "info:BundleIndex" (as mupdf names it) and
 * /BundleIndex are the same dictionary entry, and "load from bundle PDF" finds
 * a bundle by it.
 */

import { PDFName, PDFHexString, PDFString, PDFArray } from './bundletoolPdfLib.js';
import { loadPdf } from './bundletoolPdfLoad.js';
import { setOutline } from './bundletoolOutline.js';
import { addLinkAnnotation } from './bundletoolLinks.js';
import { BUNDLETOOL_VERSION } from './bundletoolVersion.js';

/** The Info-dictionary key carrying the bundle index. Load-from-PDF depends on it. */
export const BUNDLE_INDEX_KEY = 'BundleIndex';

/**
 * Bundle index schema version.
 *   2: config only; entries in the hidden annotation
 *   3: config AND entries, both in the Info dictionary
 * Readers accept both. Writers only ever write 3.
 */
export const BUNDLE_INDEX_VERSION = 3;

/**
 * Groups index row coordinates by the index page they appear on.
 */
function groupRowsByPage(rows) {
  return rows.reduce((acc, row) => {
    (acc[row.pageNumber] ||= []).push(row);
    return acc;
  }, {});
}

/**
 * Formats an index entry's bookmark title according to the configured style.
 * @param {Object} entry
 * @param {Object} section
 * @param {Object} cv - flat config values, keyed by config path
 * @returns {string}
 */
export function formatOutlineItem(entry, section, cv) {
  const style = cv['index.outlineItemStyle'];
  const { title, date } = entry;
  const page = cv['pageNumbering.pageNumberPerSection']
    ? `${section?.sectionLabel || ''}${entry.beginsOnPageOfSection}`
    : (entry.actualPdfStartPageWithToc ?? entry.beginsOnPdfPage);

  switch (style) {
    case 'withPage':        return `${title} - pg. ${page}`;
    case 'withDate':        return date ? `${title} (${date})` : title;
    case 'withDateandPage': return date ? `${title} - (${date}) - pg ${page}` : `${title} - pg. ${page}`;
    case 'plain':
    default:                return title;
  }
}

/**
 * Adds a clickable link to each index row, pointing at the document it names.
 *
 * Coordinate systems: the index pages are drawn by jsPDF, which measures in
 * millimetres from the TOP-LEFT. A PDF annotation rectangle is in points from
 * the BOTTOM-LEFT. Both conversions happen here; getting the second one wrong
 * puts every link an equal distance off the wrong edge of the page, which is
 * the sort of bug that looks like "links don't work" rather than "links are
 * upside down".
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} pdfDoc
 * @param {Array<Object>} tocTableRowCoordinates
 * @param {Array<Object>} tocEntries
 * @param {Object} cv
 * @returns {number} number of links added
 */
export function addIndexHyperlinks(pdfDoc, tocTableRowCoordinates, tocEntries, cv) {
  const MM_TO_PT = 72 / 25.4;
  const coversheetOffset = cv['pageOptions.coversheet'] ? 1 : 0;
  const rowsByPage = groupRowsByPage(tocTableRowCoordinates ?? []);

  const entryByTabNumber = new Map();
  for (const section of tocEntries) {
    for (const entry of section.entries) entryByTabNumber.set(entry.tabNumber, entry);
  }

  let added = 0;
  for (const [pageNumber, rows] of Object.entries(rowsByPage)) {
    const pageIndex = Number(pageNumber) - 1 + coversheetOffset;
    if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) continue;
    const page = pdfDoc.getPage(pageIndex);
    const box = page.getMediaBox();
    const topEdge = box.y + box.height;

    for (const row of rows) {
      const { x, y, width, height, tabNumber } = row;
      const entry = tabNumber ? entryByTabNumber.get(tabNumber) : null;
      if (!entry) continue;
      const destPageIndex = (entry.actualPdfStartPageWithToc || entry.beginsOnPdfPage) - 1;

      const x1 = box.x + x * MM_TO_PT;
      const x2 = box.x + (x + width) * MM_TO_PT;
      const yTop = y * MM_TO_PT;
      const y2 = topEdge - yTop;
      const y1 = topEdge - (yTop + height * MM_TO_PT);

      addLinkAnnotation(pdfDoc, page, [x1, y1, x2, y2], destPageIndex);
      added++;
    }
  }
  return added;
}

/**
 * Builds the bookmark tree.
 *
 * Documents are nested under their section, which is what the reader expects
 * and what BundleToolCLI does: in one flat list of 40-odd bookmarks the
 * section headings would be indistinguishable from the documents.
 *
 * @param {Array<Object>} tocEntries
 * @param {Object} cv
 * @param {number} indexPageIndex - zero-based page index of the index
 * @returns {Array<import('./bundletoolOutline.js').OutlineItem>}
 */
export function buildOutlineTree(tocEntries, cv, indexPageIndex) {
  let maxTabNumber = 0;
  for (const section of tocEntries) {
    for (const entry of section.entries) {
      if (entry.tabNumber > maxTabNumber) maxTabNumber = entry.tabNumber;
    }
  }
  const pad = maxTabNumber > 0 ? maxTabNumber.toString().length : 1;

  // The label on the entry that jumps to the index is a setting (some prefer
  // "go to index" or similar). Blank gives "Index".
  const items = [{
    title: `[${'0'.padStart(pad, '0')}] ${String(cv['index.indexBookmarkLabel'] ?? '').trim() || 'Index'}`,
    pageIndex: indexPageIndex,
  }];

  for (const section of tocEntries) {
    const children = section.entries.map((entry) => ({
      title: `[${entry.tabNumber.toString().padStart(pad, '0')}] ${formatOutlineItem(entry, section, cv)}`,
      pageIndex: (entry.actualPdfStartPageWithToc || entry.beginsOnPdfPage) - 1,
    }));

    if (section.sectionID === '0000') {
      // The null section has no heading of its own, so its documents sit at
      // the top level rather than under an invented parent.
      items.push(...children);
      continue;
    }

    const sectionTitle = [section.sectionLabel, section.sectionTitle].filter(Boolean).join(': ')
      || `Section ${section.sectionNumber}`;
    items.push({
      title: sectionTitle,
      pageIndex: (section.actualPdfStartPageWithToc || section.beginsOnPdfPage) - 1,
      open: true,
      children,
    });
  }

  return items;
}

/**
 * Builds the bundle index payload written into the Info dictionary.
 *
 * @param {Array<Object>} tocEntries
 * @param {Object} cv
 * @returns {Object}
 */
export function buildBundleIndexPayload(tocEntries, cv) {
  return {
    version: BUNDLE_INDEX_VERSION,
    softwareVersion: BUNDLETOOL_VERSION,
    config: {
      heading: {
        claimNumber:  cv['heading.claimNumber']  || '',
        bundleTitle:  cv['heading.bundleTitle']  || '',
        projectName:  cv['heading.projectName']  || '',
        author:       cv['heading.author']       || '',
        fontSize:     cv['heading.fontSize']     || 'medium',
      },
      pageNumbering: {
        footerFont:           cv['pageNumbering.footerFont']           || 'serif',
        alignment:            cv['pageNumbering.alignment']            || 'centre',
        numberingStyle:       cv['pageNumbering.numberingStyle']       || 'PageX',
        footerPrefix:         cv['pageNumbering.footerPrefix']         || '',
        pageNumberPerSection: cv['pageNumbering.pageNumberPerSection'] ?? false,
        // How the cover and index are numbered, and how far the footers sit from the foot of the page:
        // the email splitter needs the first to say which page numbers a part holds.
        frontMatterNumbering: cv['pageNumbering.frontMatterNumbering'] || 'continuous',
        footerOffset:         Number(cv['pageNumbering.footerOffset']) || 0,
        plateColour:          cv['pageNumbering.plateColour']          || '#f4f4f4',
        plateOpacity:         cv['pageNumbering.plateOpacity']         ?? 100,
        // What a split part needs to draw its own footers the way this bundle draws them.
        footerFontSize:       cv['pageNumbering.footerFontSize']       || 'medium',
        pageNumberColour:     cv['pageNumbering.pageNumberColour']     || '#000000',
        footerLink:           cv['pageNumbering.footerLink']           || 'index',
      },
      index: {
        fontFace:         cv['index.fontFace']         || 'serif',
        dateStyle:        cv['index.dateStyle']        || 'DD Mon. YYYY',
        outlineItemStyle: cv['index.outlineItemStyle'] || 'plain',
        sectionPrefix:    cv['index.sectionPrefix']    || '',
        indexBookmarkLabel: cv['index.indexBookmarkLabel'] || '',
        fontSize:         cv['index.fontSize']         || 'medium',
        showTableBorders: cv['index.showTableBorders'] ?? true,
        headingText:      cv['index.headingText']      || '',
      },
      pageOptions: {
        printableBundle: cv['pageOptions.printableBundle'] ?? false,
        pageSize:        cv['pageOptions.pageSize']        || 'a4',
        watermark:       cv['pageOptions.watermark']       ?? false,
        watermarkText:   cv['pageOptions.watermarkText']   ?? '',
        watermarkColour: cv['pageOptions.watermarkColour'] ?? '#999999',
        watermarkOpacity: cv['pageOptions.watermarkOpacity'] ?? 28,
        // On unless the build said false, so a bundle reopens with the setting it was made with.
        smallerPhotos:   cv['pageOptions.smallerPhotos'] !== false,
        coversheet:      cv['pageOptions.coversheet']      ?? false,
        // Which kind of cover page page 1 is. Readers treat an absent value as
        // 'uploaded' when there is a coversheet (coverSourceOf() in
        // bundletoolRestore.js). Reopening a bundle needs this: an uploaded
        // cover comes back as a file the user can keep, a generated one is
        // redrawn from the fields below so it cannot go stale.
        coverSource:     cv['pageOptions.coverSource']
                         ?? (cv['pageOptions.coversheet'] ? 'uploaded' : 'none'),
      },
      // Cover-page case details. Only meaningful when coverSource is
      // 'generated', but stored either way so that turning the generated cover
      // back on after reopening a bundle does not need them typed again.
      cover: {
        courtName:      cv['cover.courtName']      || '',
        matterOf:       cv['cover.matterOf']       || '',
        applicantName:  cv['cover.applicantName']  || '',
        respondentName: cv['cover.respondentName'] || '',
        partyLabel1:    cv['cover.partyLabel1']    || '',
        partyLabel2:    cv['cover.partyLabel2']    || '',
        extraText:      cv['cover.extraText']      || '',
        // null = the cover follows Basic Information; kept as null, not '', so a reopened
        // bundle can tell "follows" from "deliberately empty".
        claimNumber:    cv['cover.claimNumber']    ?? null,
        bundleTitle:    cv['cover.bundleTitle']    ?? null,
        author:         cv['cover.author']         ?? null,
      },
      // The two OCR settings that change scanned pages, so a reopened bundle keeps them. Written only when one is
      // on: a bundle made with both off (the default) carries no ocr group, and reopens with both off.
      ...(cv['ocr.turnUpright'] === true || cv['ocr.straighten'] === true
        ? { ocr: { turnUpright: cv['ocr.turnUpright'] === true, straighten: cv['ocr.straighten'] === true } }
        : {}),
    },
    // Entries (see the file header).
    sections: tocEntries.map((section) => ({
      sectionID:    section.sectionID,
      sectionLabel: section.sectionLabel || '',
      sectionName:  section.sectionTitle || '',
      files: section.entries.map((entry) => ({
        tab:      entry.tabNumber,
        filename: entry.filename,
        title:    entry.title,
        date:     entry.date,
        page:     entry.actualPdfStartPageWithToc || entry.beginsOnPdfPage,
        // Set when the source PDF was damaged and only partially recovered.
        // Carried so a reopened bundle still shows which documents were suspect.
        ...(entry.recovered ? { recovered: true, recoveryNote: entry.recoveryNote || '' } : {}),
        // Set when this document was converted in the browser from a .docx, and
        // carried for the same reason as `recovered` above. Neither is read
        // back to show its badge again on a reopened bundle (see fileRows.js).
        ...(entry.convertedFromDocx ? { convertedFromDocx: true } : {}),
      })),
    })),
  };
}

/**
 * Writes the standard metadata fields and the bundle index.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} pdfDoc
 * @param {Array<Object>} tocEntries
 * @param {Object} cv
 * @returns {number} the serialised length of the bundle index payload
 */
export function setMetadata(pdfDoc, tocEntries, cv) {
  pdfDoc.setProducer(`BundleTool (CaseForge) v${BUNDLETOOL_VERSION}`);
  pdfDoc.setCreator('BundleTool');
  pdfDoc.setTitle(cv['heading.bundleTitle'] || '');
  pdfDoc.setAuthor(cv['heading.author'] || '');
  pdfDoc.setSubject(cv['heading.projectName'] || '');
  pdfDoc.setKeywords([cv['heading.claimNumber'] || '']);

  const json = JSON.stringify(buildBundleIndexPayload(tocEntries, cv));
  pdfDoc.getInfoDict().set(PDFName.of(BUNDLE_INDEX_KEY), PDFHexString.fromText(json));
  return json.length;
}

/**
 * Reads the bundle index back out of a document's Info dictionary.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} pdfDoc
 * @returns {Object|null} the parsed payload, or null if absent/unparseable
 */
export function readBundleIndex(pdfDoc) {
  try {
    const value = pdfDoc.getInfoDict().get(PDFName.of(BUNDLE_INDEX_KEY));
    if (!value) return null;
    const text = value.decodeText ? value.decodeText() : String(value);
    return JSON.parse(text);
  } catch (err) {
    console.warn('[meta] bundle index present but unreadable:', err.message);
    return null;
  }
}

/**
 * Runs all three metadata stages against one parsed document.
 *
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 * @param {Array<Object>} tocTableRowCoordinates
 * @param {Array<Object>} tocEntries
 * @param {Object} cv
 * @param {(label: string) => void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function applyMeta(pdfBytes, tocTableRowCoordinates, tocEntries, cv, onProgress) {
  const { doc } = await loadPdf(pdfBytes);
  applyMetaToDoc(doc, tocTableRowCoordinates, tocEntries, cv, onProgress);
  return doc.save();
}

/**
 * The three metadata stages against an ALREADY-PARSED document, no parse and
 * no save: the single-pass build worker calls this on the document it is
 * already holding. applyMeta() above is the wrapper that takes and returns
 * bytes.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @param {Array<Object>} tocTableRowCoordinates
 * @param {Array<Object>} tocEntries
 * @param {Object} cv
 * @param {(label: string) => void} [onProgress]
 */
export function applyMetaToDoc(doc, tocTableRowCoordinates, tocEntries, cv, onProgress) {
  const indexPageIndex = cv['pageOptions.coversheet'] ? 1 : 0;

  const links = addIndexHyperlinks(doc, tocTableRowCoordinates, tocEntries, cv);
  onProgress?.('Adding bookmarks…');

  const bookmarks = setOutline(doc, buildOutlineTree(tocEntries, cv, indexPageIndex));
  onProgress?.('Preparing file for save…');

  const payloadLength = setMetadata(doc, tocEntries, cv);
  console.log(`[meta] ${links} index links, ${bookmarks} bookmarks, ${payloadLength}-char bundle index`);
}

/**
 * Flattens a Config instance into the plain dictionary the worker receives.
 * One list, used by both the direct and worker paths, so they cannot drift
 * apart: a key missing from one path would be dropped from every bundle it
 * writes, and come back wrong when the bundle is reopened.
 *
 * @param {Object} config
 * @returns {Object}
 */
export function flattenConfig(config) {
  const keys = [
    'pageOptions.coversheet', 'pageOptions.printableBundle', 'pageOptions.coverSource',
    'pageOptions.pageSize', 'pageOptions.watermark', 'pageOptions.watermarkText',
    'pageOptions.watermarkColour', 'pageOptions.watermarkOpacity', 'pageOptions.smallerPhotos',
    'index.outlineItemStyle', 'index.fontFace', 'index.dateStyle', 'index.dateInputOrder', 'index.sectionPrefix',
    'index.indexBookmarkLabel',
    'heading.bundleTitle', 'heading.projectName',
    'heading.author', 'heading.claimNumber', 'heading.fontSize',
    'index.fontSize', 'index.showTableBorders', 'index.headingText',
    'pageNumbering.footerFontSize', 'pageNumbering.pageNumberColour',
    'pageNumbering.footerFont', 'pageNumbering.alignment', 'pageNumbering.numberingStyle',
    'pageNumbering.footerPrefix', 'pageNumbering.pageNumberPerSection',
    'pageNumbering.frontMatterNumbering', 'pageNumbering.footerOffset',
    'pageNumbering.plateColour', 'pageNumbering.plateOpacity',
    'pageNumbering.footerLink',
    'cover.courtName', 'cover.matterOf', 'cover.applicantName', 'cover.respondentName',
    'cover.partyLabel1', 'cover.partyLabel2',
    'cover.extraText', 'cover.claimNumber', 'cover.bundleTitle', 'cover.author',
    'ocr.turnUpright', 'ocr.straighten',
  ];
  const out = {};
  for (const key of keys) out[key] = config.getOption(key);
  return out;
}
