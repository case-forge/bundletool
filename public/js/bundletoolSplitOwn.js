/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolSplitOwn.js
 * The email splitter's "own index and page numbers" kind of part.
 *
 * A part built here is a small bundle in its own right, made from the pages of the finished bundle:
 *
 *   [the bundle's cover, when it has one] [an index of this part's documents] [the documents]
 *
 * The index is drawn by the ordinary index code from the bundle's own embedded index, cut down to the
 * documents this part holds, headed "Part N of M", and it carries a "Bundle page" column saying where
 * each document sits in the whole bundle. The footers are drawn again by the ordinary footer code
 * with the part's own numbers (numbering restarts in each part, in the style the bundle uses), after
 * the footers the bundle already carried have been taken off exactly (they are tagged streams; a
 * bundle from an older build has untagged ones, so the blanking box is widened to cover the longest
 * label the bundle printed). The index rows, the footer links, the bookmarks and the embedded bundle index are all
 * written for the part, so it opens, jumps and can be reopened in BundleTool like any bundle.
 *
 * Why one decision drives both: an index built from the part counts pages from 1, so it only agrees
 * with the footers if the footers count from 1 too. Both come from the same table of entries
 * (createTocEntries), which is the same table the bundle itself was built from.
 *
 * What does not carry over: the bundle's whole index (its page numbers are the whole bundle's), a
 * link to a page that is in another part (a PDF cannot link into a different file), and the part
 * cover of the other labelling styles ("Bundle 1 of 3"), whose job the index heading does. A
 * numbering that is per section ("C15") is already independent of the split, so it is kept as it is.
 */

import { PDFDocument } from './bundletoolPdfLib.js';
import { loadPdf } from './bundletoolPdfLoad.js';
import Config from './bundletoolConfig.js';
import { IndexData } from './bundletoolIndexData.js';
import { createTocEntries, makeDummyTocPages, makeTocPages } from './bundletoolToc.js';
import {
  buildFooterTexts, buildPageLabels, applyPageNumberingToDoc, flattenFooterConfig,
} from './bundletoolPages.js';
import { applyMetaToDoc, flattenConfig } from './bundletoolMeta.js';
import { removeTaggedFooters } from './bundletoolFooter.js';
import { applyWatermarkToDoc } from './bundletoolWatermark.js';
import { copyAllPages } from './bundletoolMerge.js';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE } from './bundletoolPageSize.js';
import { withoutPageLinks, addLink } from './bundletoolSplitLinks.js';

/** The index options the main build uses (bundletoolMain.js); the part index must look like the bundle's. */
const TOC_OPTIONS = {
  font: { family: 'helvetica', sizeTitle: 18, sizeProject: 14, sizeTable: 11 },
  color: { headerFill: [200, 200, 200] },
  table: { showBorders: true, cellPadding: 2, lineHeight: 1.3 },
  margins: { top: 25, right: 22, bottom: 25, left: 22 },
};

const SECTION_ID = /^\d{4}$/;

/** The page-size key whose points match a page, else the default. */
function pageSizeKeyFor(width, height) {
  for (const [key, entry] of Object.entries(PAGE_SIZES)) {
    const [w, h] = entry.points;
    const close = (a, b) => Math.abs(a - b) < 3;
    if ((close(width, w) && close(height, h)) || (close(width, h) && close(height, w))) return key;
  }
  return DEFAULT_PAGE_SIZE;
}

/**
 * What the own-index splitter needs to know about a bundle, read once: the documents in page order with the
 * pages each covers, whether page 1 is a cover, and how the bundle numbered its pages. Null when the bundle
 * records no documents (a PDF that is not a BundleTool bundle cannot be given an index of its own).
 */
export function prepareOwnSplit(srcDoc, payload) {
  const sections = payload?.sections;
  if (!Array.isArray(sections) || sections.length === 0) return null;
  const pageCount = srcDoc.getPageCount();
  const docs = [];
  sections.forEach((section, sectionIndex) => {
    (section.files || []).forEach((file) => {
      const start = Number(file.page);
      if (!Number.isInteger(start) || start < 1 || start > pageCount) return;
      docs.push({ sectionIndex, section, file, start });
    });
  });
  if (docs.length === 0) return null;
  docs.sort((a, b) => a.start - b.start);
  docs.forEach((d, i) => { d.end = i + 1 < docs.length ? docs[i + 1].start - 1 : pageCount; });
  // First page of each section's first document: numbering by section counts from there.
  const sectionFirst = new Map();
  for (const d of docs) if (!sectionFirst.has(d.sectionIndex)) sectionFirst.set(d.sectionIndex, d.start);

  const cfg = payload.config || {};
  const numbering = cfg.pageNumbering || {};
  const hasCover = cfg.pageOptions?.coversheet === true && docs[0].start > 1;
  const docsStart = docs[0].start;
  const perSection = numbering.pageNumberPerSection === true;
  const style = numbering.numberingStyle || 'PageX';

  // How the bundle labelled each of its pages, for the "Bundle page" column and the blanking width.
  const pageLabels = [];
  if (perSection) {
    for (const d of docs) {
      const label = d.section.sectionLabel || '';
      const first = sectionFirst.get(d.sectionIndex);
      for (let p = d.start; p <= d.end; p++) pageLabels[p - 1] = `${label}${p - first + 1}`;
    }
  }
  const footerCv = {
    'pageNumbering.numberingStyle': style,
    'pageNumbering.footerPrefix': numbering.footerPrefix ?? '',
    'pageNumbering.pageNumberPerSection': perSection,
    'pageNumbering.frontMatterNumbering': numbering.frontMatterNumbering || 'continuous',
  };
  const originalTexts = style === 'None' ? [] : buildFooterTexts(footerCv, pageLabels, pageCount, docsStart - 1).texts;
  const bareTexts = style === 'None' ? [] : buildFooterTexts({ ...footerCv, 'pageNumbering.numberingStyle': 'X', 'pageNumbering.footerPrefix': '' }, pageLabels, pageCount, docsStart - 1).texts;
  // The two longest labels the bundle printed are enough to size a blanking box that covers all of them.
  const longest = [...new Set(originalTexts)].sort((a, b) => b.length - a.length).slice(0, 2);

  const first = srcDoc.getPage(0);
  const { width, height } = first.getSize();
  return {
    pageCount, docs, docsStart, hasCover, perSection, style,
    bareTexts, longestOldLabels: longest,
    pageSizeKey: pageSizeKeyFor(width, height),
    sectionFirst,
  };
}

/** The bundle's own label for page `page` (1-based) as printed on it, or the page position when none is printed. */
function bundlePageLabel(ctx, page) {
  if (ctx.perSection) return undefined;   // the same label is printed in the part, so no extra column
  const text = ctx.bareTexts[page - 1];
  return text ? text : String(page);
}

function buildConfig(payload, overrides) {
  const config = new Config();
  const base = JSON.parse(JSON.stringify(payload.config || {}));
  const merged = { ...base };
  for (const [group, values] of Object.entries(overrides)) merged[group] = { ...(base[group] || {}), ...values };
  try {
    config.updateOptions(merged);
    config.validateStructure();
    config.validateOptions();
  } catch (error) {
    throw new Error(`This bundle's recorded settings could not be used for a part index (${error.message}). Split it with a cover page or seamlessly instead.`);
  }
  return config;
}

/**
 * Builds one own-index part from bundle pages fromPage..toPage (1-based, inclusive). Pages ahead of the first
 * document (the bundle's cover and index) are not part of a document range: the cover is added back as the
 * part's first page and the bundle's index is replaced by the part's own.
 *
 * @returns {Promise<{bytes: Uint8Array, documents: number, droppedLinks: number, indexPages: number}>}
 */
export async function buildOwnPart(srcDoc, payload, ctx, fromPage, toPage, { partNumber, partCount }) {
  const first = Math.max(fromPage, ctx.docsStart);
  if (toPage < first) throw new Error('A part with no documents cannot be given an index.');

  // The documents in this part, cut to the pages it holds.
  const pieces = [];
  for (const d of ctx.docs) {
    const s = Math.max(d.start, first);
    const e = Math.min(d.end, toPage);
    if (s > e) continue;
    pieces.push({ d, from: s, to: e, continued: s > d.start });
  }

  const bundleTitle = String(payload.config?.heading?.bundleTitle || '').trim();
  const headingText = `${bundleTitle ? `${bundleTitle}: ` : ''}Part ${partNumber} of ${partCount}`;
  const config = buildConfig(payload, {
    pageOptions: {
      coversheet: ctx.hasCover, coverSource: ctx.hasCover ? 'uploaded' : 'none',
      printableBundle: false, pageSize: ctx.pageSizeKey,
    },
    index: { headingText },
  });

  // IndexData: this part's documents only, grouped in their original sections.
  const bySection = new Map();
  for (const piece of pieces) {
    if (!bySection.has(piece.d.sectionIndex)) bySection.set(piece.d.sectionIndex, []);
    bySection.get(piece.d.sectionIndex).push(piece);
  }
  const orderedPieces = [];
  const sections = [...bySection.entries()].map(([sectionIndex, list]) => {
    orderedPieces.push(...list);
    const original = payload.sections[sectionIndex];
    return {
      sectionID: SECTION_ID.test(String(original.sectionID)) ? String(original.sectionID) : String(sectionIndex).padStart(4, '0'),
      sectionLabel: original.sectionLabel || '',
      sectionName: original.sectionName || '',
      files: list.map((piece) => ({
        filename: piece.d.file.filename || `document-${piece.d.start}.pdf`,
        title: piece.continued ? `${piece.d.file.title || ''} (continued)`.trim() : (piece.d.file.title || ''),
        date: piece.d.file.date || null,
        pageCount: piece.to - piece.from + 1,
        ...(piece.d.file.recovered ? { recovered: true, recoveryNote: piece.d.file.recoveryNote || '' } : {}),
      })),
    };
  });
  const indexData = new IndexData(sections);
  indexData.validateIndexStructure();

  const tocEntries = await createTocEntries(indexData, config);
  // Numbers as the bundle printed them: a section's own pages keep their per-section numbers, and the
  // "Bundle page" column says where the document begins in the whole bundle.
  let n = 0;
  for (const section of tocEntries) {
    for (const entry of section.entries) {
      const piece = orderedPieces[n++];
      entry.beginsOnPageOfSection = piece.from - (ctx.sectionFirst.get(piece.d.sectionIndex) ?? piece.d.start) + 1;
      const label = bundlePageLabel(ctx, piece.from);
      if (label !== undefined) entry.bundlePage = label;
    }
  }
  const expectedTocLength = await makeDummyTocPages(tocEntries, TOC_OPTIONS, config);
  const [tocBytes, coordinates, tocPages] = await makeTocPages(tocEntries, TOC_OPTIONS, config, expectedTocLength);
  if (tocPages !== expectedTocLength) throw new Error('The part index changed length between measuring and drawing.');

  // Assemble: cover, index, documents.
  const dst = await PDFDocument.create();
  if (ctx.hasCover) {
    const { result: pages } = await withoutPageLinks(srcDoc, 0, 0, () => dst.copyPages(srcDoc, [0]));
    for (const page of pages) dst.addPage(page);
  }
  {
    const { doc: tocDoc } = await loadPdf(tocBytes);
    if (payload.config?.pageOptions?.watermark === true) {
      // The bundle's own pages already carry the watermark; the new index pages get it here.
      await applyWatermarkToDoc(tocDoc, payload.config.pageOptions.watermarkText || 'CONFIDENTIAL',
        payload.config.pageOptions.watermarkColour, payload.config.pageOptions.watermarkOpacity);
    }
    await copyAllPages(dst, tocDoc);
  }
  const frontMatterCount = (ctx.hasCover ? 1 : 0) + tocPages;
  const indices = [];
  for (let p = first; p <= toPage; p++) indices.push(p - 1);
  const { result: docPages, links } = await withoutPageLinks(srcDoc, first - 1, toPage - 1, () => dst.copyPages(srcDoc, indices));
  for (const page of docPages) dst.addPage(page);

  // The footers the bundle drew come off exactly, and the part's own are drawn from the same entries as the index.
  removeTaggedFooters(dst);
  const footerCv = flattenFooterConfig(config);
  footerCv['pageOptions.watermark'] = false;   // the pages that had a watermark keep it; the index pages got theirs above
  const indexPageIndex = ctx.hasCover ? 1 : 0;
  const footerLink = config.getOption('pageNumbering.footerLink') || 'index';
  const footerLinkPageIndex = footerLink === 'none' ? null : footerLink === 'top' ? 0 : indexPageIndex;
  await applyPageNumberingToDoc(dst, footerCv, buildPageLabels(tocEntries, footerCv['pageNumbering.pageNumberPerSection']),
    footerLinkPageIndex, frontMatterCount, { blankFloorTexts: ctx.longestOldLabels });

  // Index links, bookmarks and the embedded index, exactly as for a bundle.
  applyMetaToDoc(dst, coordinates, tocEntries, flattenConfig(config));

  // Links inside a document that point at a page of this part come back, re-pointed; those that point at another part are dropped.
  // A link to the bundle's own cover or index is not counted: the footers and index rows were redrawn above.
  let dropped = 0;
  for (const link of links) {
    if (link.target >= first - 1 && link.target <= toPage - 1) {
      addLink(dst, docPages[link.page], link.rect, frontMatterCount + (link.target - (first - 1)), link.border, link.flags);
    } else if (link.target >= ctx.docsStart - 1) {
      dropped++;
    }
  }

  dst.setTitle(`${bundleTitle || 'Bundle'} (part ${partNumber} of ${partCount})`.trim());
  const bytes = await dst.save({ objectsPerTick: Infinity });
  return { bytes, documents: pieces.length, droppedLinks: dropped, indexPages: tocPages };
}
