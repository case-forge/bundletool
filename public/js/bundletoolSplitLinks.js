/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolSplitLinks.js
 * The link handling the email splitter shares between its two kinds of part: lifting the links
 * that jump to a page of the bundle off the source pages while they are copied (copying a link
 * target drags the target page along, which would make every part nearly as big as the bundle),
 * and writing them back, re-pointed, on the part's own pages.
 */

import { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } from './bundletoolPdfLib.js';
import { destinationForPage } from './bundletoolOutline.js';

const ANNOTS = PDFName.of('Annots');

/** Page ref tag -> 0-based page index, for a source document (built once). */
const pageIndexCache = new WeakMap();
export function pageIndexByTag(srcDoc) {
  let map = pageIndexCache.get(srcDoc);
  if (!map) {
    map = new Map();
    srcDoc.getPages().forEach((page, i) => map.set(page.ref.tag, i));
    pageIndexCache.set(srcDoc, map);
  }
  return map;
}

/** The page a link annotation jumps to, as a 0-based index, or null when it does not jump to a page. */
export function linkTargetIndex(context, annot, indexByTag) {
  let dest = context.lookup(annot.get(PDFName.of('Dest')));
  if (!(dest instanceof PDFArray)) {
    const action = context.lookup(annot.get(PDFName.of('A')));
    if (action instanceof PDFDict && action.get(PDFName.of('S')) === PDFName.of('GoTo')) {
      dest = context.lookup(action.get(PDFName.of('D')));
    }
  }
  if (!(dest instanceof PDFArray) || dest.size() === 0) return null;
  const target = dest.get(0);
  return target instanceof PDFRef && indexByTag.has(target.tag) ? indexByTag.get(target.tag) : null;
}

/**
 * Takes the links that jump to a page of the bundle off the source pages fromIdx..toIdx for the
 * duration of `copy`, so that copying the pages does not drag their target pages along, and puts
 * them back afterwards. Returns what was taken, as {page (0-based, within the range), rect, ...}.
 */
export async function withoutPageLinks(srcDoc, fromIdx, toIdx, copy) {
  const context = srcDoc.context;
  const indexByTag = pageIndexByTag(srcDoc);
  const srcPages = srcDoc.getPages();
  const taken = [];
  const restore = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    const node = srcPages[i].node;
    const original = node.get(ANNOTS);
    const annots = context.lookup(original);
    if (!(annots instanceof PDFArray)) continue;
    const keep = context.obj([]);
    for (let a = 0; a < annots.size(); a++) {
      const annot = context.lookup(annots.get(a));
      const isLink = annot instanceof PDFDict && annot.get(PDFName.of('Subtype')) === PDFName.of('Link');
      const target = isLink ? linkTargetIndex(context, annot, indexByTag) : null;
      if (target === null) { keep.push(annots.get(a)); continue; }
      const rect = context.lookup(annot.get(PDFName.of('Rect')));
      taken.push({
        page: i - fromIdx,
        target,
        rect: rect instanceof PDFArray ? rect.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : 0)) : [0, 0, 0, 0],
        border: context.lookup(annot.get(PDFName.of('Border'))),
        flags: context.lookup(annot.get(PDFName.of('F'))),
      });
    }
    restore.push([node, original]);
    if (keep.size() > 0) node.set(ANNOTS, keep); else node.delete(ANNOTS);
  }
  try {
    return { result: await copy(), links: taken };
  } finally {
    for (const [node, original] of restore) node.set(ANNOTS, original);
  }
}

/** Writes a link from `page` to the part's page `targetIdx` (0-based, in the finished part). */
export function addLink(doc, page, rect, targetIdx, border, flags) {
  const dict = doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: rect, Dest: destinationForPage(doc, targetIdx),
  });
  dict.set(PDFName.of('Border'), border instanceof PDFArray ? border.clone() : doc.context.obj([0, 0, 0]));
  if (flags instanceof PDFNumber) dict.set(PDFName.of('F'), flags);
  const ref = doc.context.register(dict);
  const existing = page.node.get(ANNOTS);
  const list = doc.context.lookup(existing);
  if (list instanceof PDFArray) list.push(ref); else page.node.set(ANNOTS, doc.context.obj([ref]));
}

