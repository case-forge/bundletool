/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolSplit.js
 * Splits a finished bundle into parts small enough to email.
 *
 * THE ARITHMETIC, from the providers' own documentation: Gmail and Outlook
 * cap the ENTIRE message (headers, body and every attachment AFTER transfer
 * encoding) at 25 MB (25,000,000 bytes in the decimal reading, the safe one).
 * Attachments travel base64-encoded, which costs exactly 4/3, plus a CRLF
 * every 76 characters (78/76), about +36.8% together. So the raw-PDF ceiling
 * for a 25,000,000-byte message is roughly 18.2 MB, and the default target
 * here is 18,000,000 bytes: NOT 25 MB, and not MiB anywhere.
 *
 * Parts are cut at document boundaries read from the bundle's own embedded
 * index, so no document is ever split across two emails unless that single
 * document alone exceeds the target (then it falls back to page boundaries;
 * a single page bigger than the target ships alone, flagged oversize).
 * Sizes are MEASURED, not estimated: each candidate part is actually built
 * and its bytes counted, with a binary search over the cut points, because
 * a scanned exhibit can weigh a hundred times what a typed statement does
 * and any per-page estimate would split real bundles wrongly.
 *
 * Two labelling styles, both wanted by different people:
 *   partCover: true    each part opens with a "Bundle 1 of 3" page saying
 *                      what the split is and which bundle pages follow.
 *   partCover: false   seamless: nothing added, page numbering continues
 *                      from the full bundle, so the parts print and stitch
 *                      back together cleanly.
 * The part cover uses the built-in Helvetica, deliberately: embedding one of
 * the shipped font families would add ~0.5 MB to every part for one page of
 * utilitarian text. Only a title Helvetica cannot draw gets a Liberation Sans subset.
 *
 * What a part keeps of the bundle's navigation: the links whose target page is in the same part
 * (the index rows and page-number footers of part 1 that point into part 1, the footers that point
 * back to the index in part 1) and the bookmarks that point into it, rebuilt to the part's own
 * pages. A link to a page in ANOTHER part is dropped: a PDF cannot link into a different file, and
 * leaving it would make copyPages carry the target page along as an orphan, so that a part could come
 * out nearly as big as the whole bundle. The index page itself is in part 1, and its printed page
 * numbers remain correct throughout.
 */

import { PDFDocument, StandardFonts, rgb } from './bundletoolPdfLib.js';
import { loadPdf } from './bundletoolPdfLoad.js';
import { readBundleIndex } from './bundletoolMeta.js';
import { textFontFor } from './bundletoolTextFont.js';
import { readOutline, setOutline } from './bundletoolOutline.js';
import { withoutPageLinks, addLink } from './bundletoolSplitLinks.js';
import { prepareOwnSplit, buildOwnPart } from './bundletoolSplitOwn.js';

/** The whole-message ceiling Gmail and Outlook enforce, decimal bytes. */
export const EMAIL_MESSAGE_CEILING_BYTES = 25_000_000;

/** base64 (4/3) plus a CRLF per 76 encoded characters (78/76). */
export const BASE64_INFLATION = (4 / 3) * (78 / 76);

/** Default raw-PDF target per part: what fits under the ceiling, rounded. */
export const DEFAULT_TARGET_BYTES = 18_000_000;

/**
 * The largest raw attachment that fits a given whole-message ceiling, after
 * base64 inflation and a headroom allowance for headers and the message body.
 */
export function rawCeilingForMessage(messageBytes = EMAIL_MESSAGE_CEILING_BYTES, headroomBytes = 200_000) {
  return Math.floor((messageBytes - headroomBytes) / BASE64_INFLATION);
}

/**
 * 1-based physical pages a part may begin on: page 1, and the first page of
 * every document recorded in the bundle's embedded index. A bundle with no
 * readable index (or none at all) may be cut at any page.
 */
function cutPointsFrom(payload, pageCount) {
  const points = new Set([1]);
  const sections = payload?.sections;
  if (Array.isArray(sections) && sections.length > 0) {
    for (const section of sections) {
      for (const file of section.files || []) {
        const page = Number(file.page);
        if (Number.isInteger(page) && page >= 1 && page <= pageCount) points.add(page);
      }
    }
  } else {
    for (let p = 1; p <= pageCount; p++) points.add(p);
  }
  return [...points].sort((a, b) => a - b);
}

/**
 * One boundary per section, at that section's first file's page, for `mode: 'section'`, which
 * partitions by structure instead of by size. An empty section (no files) produces no boundary of
 * its own, same as it produces no page range. Empty when the bundle records no sections at all.
 * Pages ahead of the first section (the cover and the index) are not part of any section: the
 * splitter gives them a part of their own.
 */
function sectionCutPointsFrom(payload, pageCount) {
  const sections = payload?.sections;
  const points = [];
  if (Array.isArray(sections) && sections.length > 0) {
    for (const section of sections) {
      const pages = (section.files || [])
        .map((file) => Number(file.page))
        .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount);
      if (pages.length === 0) continue;
      points.push({
        startPage: pages.reduce((lowest, page) => (page < lowest ? page : lowest), pages[0]),
        sectionLabel: section.sectionLabel || '',
        sectionName: section.sectionName || '',
      });
    }
  }
  return points.sort((a, b) => a.startPage - b.startPage);
}

/**
 * What the split dialog needs to know about a bundle before it offers a choice: its title and its
 * sections, in order, with the pages each covers. `sections` is empty for a PDF that does not carry
 * BundleTool's own index (then only a split by size makes sense).
 *
 * @returns {Promise<{title: string, pageCount: number, sections: Array<{label: string, name: string, fromPage: number, toPage: number}>}>}
 */
export async function inspectBundleForSplit(bundleBytes) {
  const { doc } = await loadPdf(bundleBytes);
  const pageCount = doc.getPageCount();
  const payload = readBundleIndex(doc);
  const bounds = sectionCutPointsFrom(payload, pageCount);
  return {
    title: payload?.config?.heading?.bundleTitle || '',
    pageCount,
    sections: bounds.map((b, i) => ({
      label: b.sectionLabel,
      name: b.sectionName,
      fromPage: b.startPage,
      toPage: i + 1 < bounds.length ? bounds[i + 1].startPage - 1 : pageCount,
    })),
  };
}

/**
 * How a part's page range is worded. The footers of the bundle print their own numbers, which are
 * the PDF page positions only when numbering is plain and continuous. With numbering off, per
 * section (C1, C2 ...), or with roman or skipped front matter, a range of PDF positions would not
 * match anything printed on the pages, so it is said to be PDF pages; and when front matter is
 * unnumbered or roman the printed range is worked out from the first document's page.
 *
 * @returns {{ printed: boolean, from: number, to: number, text: string }} `text` reads "bundle pages
 *   4 to 8" or "PDF pages 4 to 8"; `printed` says whether the numbers are the ones on the pages.
 */
export function describePartPages(payload, fromPage, toPage, totalPages) {
  const numbering = payload?.config?.pageNumbering || {};
  const style = numbering.numberingStyle || 'PageX';
  const front = numbering.frontMatterNumbering || 'continuous';
  const perSection = numbering.pageNumberPerSection === true;
  const firstDoc = Math.min(...(payload?.sections || []).flatMap((sec) => (sec.files || []).map((f) => Number(f.page)))
    .filter((n) => Number.isInteger(n) && n >= 1), Infinity);
  const frontCount = Number.isFinite(firstDoc) ? firstDoc - 1 : 0;
  const pdfPages = { printed: false, from: fromPage, to: toPage, text: `PDF pages ${fromPage} to ${toPage} of ${totalPages}` };
  if (style === 'None' || perSection) return pdfPages;
  if (front === 'continuous') return { printed: true, from: fromPage, to: toPage, text: `bundle pages ${fromPage} to ${toPage} of ${totalPages}` };
  // Roman or skipped front matter: the documents are numbered from 1 after it.
  if (toPage <= frontCount) {
    return { printed: false, from: fromPage, to: toPage, text: `the cover and index (PDF pages ${fromPage} to ${toPage} of ${totalPages})` };
  }
  if (fromPage <= frontCount) return pdfPages;   // a part that mixes front matter and documents
  return { printed: true, from: fromPage - frontCount, to: toPage - frontCount,
           text: `bundle pages ${fromPage - frontCount} to ${toPage - frontCount} of ${totalPages - frontCount}` };
}

/** Draws the "Bundle X of N" page onto a part. */
async function addPartCover(doc, { partNumber, partCount, fromPage, toPage, totalPages, title, pagesText }) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // The title is the one line of free text: Helvetica when it can draw it, otherwise a Liberation
  // Sans subset for that line alone (so a Welsh or Polish title prints, and a plain one costs nothing).
  const heading = title ? await textFontFor(doc, title) : null;
  const page = doc.insertPage(0, [595.28, 841.89]);
  const centre = (text, size, f, y) => {
    const width = f.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (595.28 - width) / 2, y, size, font: f, color: rgb(0, 0, 0) });
  };
  centre(`BUNDLE ${partNumber} OF ${partCount}`, 22, bold, 620);
  if (heading) centre(heading.text, 13, heading.font, 580);
  centre('This bundle has been split into parts to fit email size limits.', 11, font, 500);
  centre(`This part contains ${pagesText || `bundle pages ${fromPage} to ${toPage} of ${totalPages}`}.`, 11, font, 480);
  centre('Page numbering continues from the full bundle.', 11, font, 460);
  if (partNumber !== 1) centre('The index to the whole bundle is at the front of part 1.', 11, font, 440);
}

/** The source bundle's bookmarks that point into pages fromIdx..toIdx, re-pointed at the part's pages. */
function outlineForPart(srcDoc, fromIdx, toIdx, offset) {
  const inRange = (i) => typeof i === 'number' && i >= fromIdx && i <= toIdx;
  const trim = (items) => items.flatMap((item) => {
    const children = trim(item.children || []);
    const own = inRange(item.pageIndex);
    if (!own && children.length === 0) return [];
    return [{
      title: item.title,
      pageIndex: own ? item.pageIndex - fromIdx + offset : undefined,
      open: item.open,
      children,
    }];
  });
  return trim(readOutline(srcDoc));
}

/** Builds one part: pages from..to (1-based, inclusive), plus its cover. */
async function buildPart(srcDoc, fromPage, toPage, coverOpts) {
  // A part with an index and page numbers of its own is built by bundletoolSplitOwn.js.
  if (coverOpts?.own) {
    return (await buildOwnPart(srcDoc, coverOpts.own.payload, coverOpts.own.ctx, fromPage, toPage,
      { partNumber: coverOpts.partNumber, partCount: coverOpts.partCount })).bytes;
  }
  const doc = await PDFDocument.create();
  const indices = [];
  for (let p = fromPage; p <= toPage; p++) indices.push(p - 1);
  const { result: pages, links } = await withoutPageLinks(srcDoc, fromPage - 1, toPage - 1, () => doc.copyPages(srcDoc, indices));
  for (const page of pages) doc.addPage(page);
  if (coverOpts) {
    const pagesText = coverOpts.payload ? describePartPages(coverOpts.payload, fromPage, toPage, coverOpts.totalPages).text : undefined;
    await addPartCover(doc, { ...coverOpts, fromPage, toPage, pagesText });
  }
  // The cover, when there is one, is page 0 of the part and shifts every other page by one.
  const offset = coverOpts ? 1 : 0;
  for (const link of links) {
    if (link.target < fromPage - 1 || link.target > toPage - 1) continue;   // into another part
    addLink(doc, pages[link.page], link.rect, link.target - (fromPage - 1) + offset, link.border, link.flags);
  }
  const outline = outlineForPart(srcDoc, fromPage - 1, toPage - 1, offset);
  if (outline.length > 0) setOutline(doc, outline);
  return doc.save();
}

/**
 * The largest cut ending at or under `targetBytes` for a part starting at
 * cutPoints[startIdx], by binary search over the cut points, measuring each
 * candidate for real.
 *
 * Returns { endPage, bytes, oversize }: endPage is the part's last 1-based
 * physical page. Falls back to page boundaries when even a single document
 * exceeds the target; a single PAGE over the target ships alone, flagged.
 */
async function fitOnePart(srcDoc, cutPoints, startIdx, targetBytes, coverOpts, pageCount) {
  const startPage = cutPoints[startIdx];
  // Candidate end pages, ascending: the page before each later cut point,
  // then the end of the bundle.
  const candidates = cutPoints.slice(startIdx + 1).map((p) => p - 1);
  if (candidates[candidates.length - 1] !== pageCount) candidates.push(pageCount);

  // Largest candidate that fits, by binary search; each probe is a real
  // build, so the memo keeps the winning bytes rather than rebuilding.
  let lo = 0, hi = candidates.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bytes = await buildPart(srcDoc, startPage, candidates[mid], coverOpts);
    if (bytes.length <= targetBytes) { best = { endPage: candidates[mid], bytes }; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (best) return best;

  // Even the smallest candidate (one document) is over target: try page
  // boundaries inside that document.
  const docEndPage = candidates[0];
  let pageFit = null;
  let pLo = startPage, pHi = docEndPage - 1;
  while (pLo <= pHi) {
    const pMid = (pLo + pHi + 1) >> 1;
    const bytes = await buildPart(srcDoc, startPage, pMid, coverOpts);
    if (bytes.length <= targetBytes) { pageFit = { endPage: pMid, bytes }; pLo = pMid + 1; }
    else pHi = pMid - 1;
  }
  if (pageFit) return pageFit;

  // A single page over target: it ships alone, flagged.
  const bytes = await buildPart(srcDoc, startPage, startPage, coverOpts);
  return { endPage: startPage, bytes, oversize: bytes.length > targetBytes };
}

/**
 * Splits a finished bundle into email-sized parts.
 *
 * @param {Uint8Array} bundleBytes
 * @param {Object} opts
 * @param {number}  [opts.targetBytes]  raw-PDF budget per part (decimal bytes)
 * @param {'fill'|'even'|'section'} [opts.mode]
 *                                      fill each part to the limit, spread the
 *                                      same part count evenly by size, or
 *                                      one part for the cover and index and one
 *                                      per section; a part over targetBytes is
 *                                      cut further by size (subPart/subPartCount).
 *                                      'even' is the default: real bundles over
 *                                      the 18 MB ceiling are mostly 18 to 42 MB,
 *                                      so the typical split is 2 or 3 parts,
 *                                      where fill gives a lopsided 18 + 2 MB
 *                                      pair and even gives two parts of about
 *                                      11 MB, clear of every gateway's limit.
 * @param {boolean} [opts.partCover]    prepend a "Bundle 1 of 3" page per part
 * @param {'cover'|'seamless'|'own'} [opts.labelling]  overrides partCover: 'own' gives each part its own index
 *                                      (headed "Part N of M") and page numbers that restart in the part, see
 *                                      bundletoolSplitOwn.js
 * @param {string}  [opts.title]        shown on the part covers
 * @param {(label: string) => void} [opts.onProgress]
 * @returns {Promise<Array<{bytes: Uint8Array, fromPage: number, toPage: number,
 *   partNumber: number, partCount: number, oversize: boolean,
 *   kind?: 'front'|'section'|'whole', sectionLabel?: string, sectionName?: string,
 *   subPart?: number, subPartCount?: number, bundleTitle?: string}>>} the last fields
 *   are only present for mode: 'section' (subPart is 0 when the section was not cut further).
 */
export async function splitForEmail(bundleBytes, {
  targetBytes = DEFAULT_TARGET_BYTES,
  mode = 'even',
  partCover = true,
  labelling = null,
  title = '',
  onProgress = () => {},
} = {}) {
  // Floor kept low deliberately so the tests can exercise multi-part splits
  // with kilobyte fixtures; the UI enforces its own 1 MB minimum.
  if (!Number.isFinite(targetBytes) || targetBytes < 10_000) {
    throw new Error(`Split target too small to hold a PDF: ${targetBytes}`);
  }

  onProgress('Reading bundle…');
  const { doc: srcDoc } = await loadPdf(bundleBytes);
  const pageCount = srcDoc.getPageCount();
  const payload = readBundleIndex(srcDoc);
  let cutPoints = cutPointsFrom(payload, pageCount);
  const bundleTitle = title || payload?.config?.heading?.bundleTitle || '';

  // How the parts are labelled: a cover page each, nothing added, or an index and page numbers of their own.
  const style = labelling || (partCover ? 'cover' : 'seamless');
  const own = style === 'own';
  const ownCtx = own ? prepareOwnSplit(srcDoc, payload) : null;
  if (own && !ownCtx) throw new Error('This PDF does not record its documents, so its parts cannot be given an index of their own. Split it with a cover page or seamlessly.');
  // Pages ahead of the first document (the bundle's cover and index) do not belong to any part of their own in this style.
  const firstPage = own ? ownCtx.docsStart : 1;
  if (own) cutPoints = cutPoints.filter((p) => p >= firstPage);
  /** What buildPart needs to make a part of this style; null for seamless parts. */
  const partOptions = (partNumber, partCount) => {
    if (style === 'seamless') return null;
    const base = { partNumber, partCount, totalPages: pageCount, title: bundleTitle, payload };
    return own ? { ...base, own: { payload, ctx: ownCtx } } : base;
  };
  /** The finished part, with what the own style reports about it. */
  const finishPart = async (fromPage, toPage, partNumber, partCount) => {
    if (!own) return { bytes: await buildPart(srcDoc, fromPage, toPage, partOptions(partNumber, partCount)) };
    const built = await buildOwnPart(srcDoc, payload, ownCtx, fromPage, toPage, { partNumber, partCount });
    return { bytes: built.bytes, ownInfo: { documents: built.documents, droppedLinks: built.droppedLinks, indexPages: built.indexPages } };
  };

  // Split by section: one part for the cover and index, then one per section, in order. A part
  // that is over the size target is cut further by size at document boundaries and labelled
  // "Part 1 of 2"; a part within the target is left whole, however small.
  if (mode === 'section') {
    const bounds = sectionCutPointsFrom(payload, pageCount);
    const groups = [];
    if (bounds.length === 0) {
      groups.push({ kind: 'whole', fromPage: 1, toPage: pageCount, sectionLabel: '', sectionName: '' });
    } else {
      if (bounds[0].startPage > 1 && !own) {
        groups.push({ kind: 'front', fromPage: 1, toPage: bounds[0].startPage - 1, sectionLabel: '', sectionName: '' });
      }
      bounds.forEach((b, i) => groups.push({
        kind: 'section', fromPage: b.startPage,
        toPage: i + 1 < bounds.length ? bounds[i + 1].startPage - 1 : pageCount,
        sectionLabel: b.sectionLabel, sectionName: b.sectionName,
      }));
    }

    // The groups come from the PDF's own index, so cap them before measuring any.
    if (groups.length > 200) throw new Error('Split produced over 200 parts; refusing to continue');

    // Measure every group (with a placeholder cover; the real numbers are drawn at the end).
    const planned = [];
    for (const group of groups) {
      onProgress(`Measuring ${planned.length + 1} of ${groups.length}…`);
      const placeholder = partOptions(planned.length + 1, 99);
      const whole = await buildPart(srcDoc, group.fromPage, group.toPage, placeholder);
      if (whole.length <= targetBytes) { planned.push({ ...group, bytes: whole, subPart: 0, subPartCount: 0 }); continue; }
      const inside = [group.fromPage, ...cutPoints.filter((p) => p > group.fromPage && p <= group.toPage)];
      const pieces = [];
      let startPage = group.fromPage;
      while (startPage <= group.toPage) {
        const points = inside.includes(startPage) ? inside.slice(inside.indexOf(startPage)) : [startPage, ...inside.filter((p) => p > startPage)];
        const fit = await fitOnePart(srcDoc, points, 0, targetBytes, placeholder, group.toPage);
        pieces.push({ fromPage: startPage, toPage: fit.endPage, bytes: fit.bytes });
        startPage = fit.endPage + 1;
        if (pieces.length > 200) throw new Error('Split produced over 200 parts; refusing to continue');
      }
      pieces.forEach((piece, i) => planned.push({ ...group, ...piece, subPart: i + 1, subPartCount: pieces.length }));
      if (planned.length > 200) throw new Error('Split produced over 200 parts; refusing to continue');
    }

    const partCount = planned.length;
    const out = [];
    for (let i = 0; i < partCount; i++) {
      const item = planned[i];
      let bytes = item.bytes;
      let ownInfo;
      if (style !== 'seamless') {
        onProgress(`Finishing part ${i + 1} of ${partCount}…`);
        ({ bytes, ownInfo } = await finishPart(item.fromPage, item.toPage, i + 1, partCount));
      }
      // Drop the measuring copy once the finished part exists, so only one of each is held.
      if (style !== 'seamless') item.bytes = null;
      out.push({
        bytes, fromPage: item.fromPage, toPage: item.toPage, partNumber: i + 1, partCount,
        oversize: bytes.length > targetBytes,
        pagesLabel: describePartPages(payload, item.fromPage, item.toPage, pageCount).text,
        kind: item.kind, sectionLabel: item.sectionLabel, sectionName: item.sectionName,
        subPart: item.subPart, subPartCount: item.subPartCount, bundleTitle,
        ...(ownInfo ? { own: true, ...ownInfo } : {}),
      });
    }
    return out;
  }

  const plan = async (perPartTarget) => {
    const parts = [];
    let startPage = firstPage;
    while (startPage <= pageCount) {
      onProgress(`Measuring part ${parts.length + 1}…`);
      // partCount is not known until the plan is complete; measure with a
      // placeholder and redraw the covers once it is (same geometry, so the
      // size difference is a few bytes).
      const coverOpts = partOptions(parts.length + 1, 99);
      // A part may start mid-document after a page-level cut; the remainder
      // of that document becomes the first candidate segment.
      const points = cutPoints.includes(startPage)
        ? cutPoints.slice(cutPoints.indexOf(startPage))
        : [startPage, ...cutPoints.filter((p) => p > startPage)];
      const fit = await fitOnePart(srcDoc, points, 0, perPartTarget, coverOpts, pageCount);
      parts.push({ fromPage: startPage, toPage: fit.endPage, oversize: fit.oversize === true, bytes: fit.bytes });
      startPage = fit.endPage + 1;
      if (parts.length > 200) throw new Error('Split produced over 200 parts; refusing to continue');
    }
    return parts;
  };

  let parts = await plan(targetBytes);

  if (mode === 'even' && parts.length > 1) {
    // Same number of parts, evened out: aim each part at the mean of what
    // fill produced, growing the aim until the plan still lands on the same
    // part count without breaching the user's ceiling.
    const totalBytes = parts.reduce((sum, p) => sum + p.bytes.length, 0);
    const partCount = parts.length;
    let aim = Math.ceil(totalBytes / partCount);
    for (let attempt = 0; attempt < 8; attempt++) {
      if (aim >= targetBytes) { aim = targetBytes; break; }
      const evened = await plan(aim);
      if (evened.length <= partCount) { parts = evened; break; }
      aim = Math.min(targetBytes, Math.ceil(aim * 1.1));
    }
  }

  // Rebuild each part's cover with the real part count (measurement used a
  // placeholder). Seamless parts are already final.
  const partCount = parts.length;
  const out = [];
  for (let i = 0; i < partCount; i++) {
    const { fromPage, toPage } = parts[i];
    let bytes = parts[i].bytes;
    let ownInfo;
    if (style !== 'seamless') {
      onProgress(`Finishing part ${i + 1} of ${partCount}…`);
      ({ bytes, ownInfo } = await finishPart(fromPage, toPage, i + 1, partCount));
    }
    // Oversize is judged against the user's own target on the finished bytes (a part that met the
    // internal "even" aim, or that shipped alone, must not be flagged unless it really is over it).
    out.push({ bytes, fromPage, toPage, partNumber: i + 1, partCount, oversize: bytes.length > targetBytes,
               pagesLabel: describePartPages(payload, fromPage, toPage, pageCount).text,
               ...(ownInfo ? { own: true, ...ownInfo } : {}) });
  }
  return out;
}
