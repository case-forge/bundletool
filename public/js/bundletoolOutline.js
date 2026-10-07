/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolOutline.js
 * Document outline (bookmarks) for pdf-lib.
 *
 * PROVENANCE: written from the PDF specification: ISO 32000-1:2008 §12.3.3
 * "Document Outline" and §12.3.2.2 "Explicit Destinations". It is not adapted
 * from, and shares no code with, @lillallol/outline-pdf or any other package.
 * @cantoo/pdf-lib has no outline API, and no maintained package provides one.
 *
 * The structure, for anyone maintaining this without the spec to hand:
 *
 *   Catalog  ──/Outlines──▶  outline root dict
 *                            { /Type /Outlines, /First, /Last, /Count }
 *
 *   Each item dict:
 *     /Title   text string (UTF-16BE with BOM, so case names survive)
 *     /Parent  the containing item, or the outline root
 *     /Prev    previous sibling, absent on the first
 *     /Next    next sibling, absent on the last
 *     /First   first child, absent if childless
 *     /Last    last child, absent if childless
 *     /Count   see below: the field most often got wrong
 *     /Dest    [ pageRef /XYZ left top zoom ]
 *
 * /Count semantics (§12.3.3, Table 153):
 *   - absent or 0  : no children
 *   - positive     : item is OPEN; value is the number of VISIBLE descendants
 *                    at all levels below it
 *   - negative     : item is CLOSED; value is minus the number of IMMEDIATE
 *                    children
 *   On the outline ROOT, /Count is the total number of visible items at all
 *   levels, and is always positive.
 *
 * Every item is a separate indirect object and every one of /Parent, /First,
 * /Last, /Next, /Prev is a reference. Inline dictionaries here are what make
 * readers offer to "repair" a file.
 */

import { PDFName, PDFNumber, PDFHexString, PDFNull } from './bundletoolPdfLib.js';

/**
 * @typedef {Object} OutlineItem
 * @property {string} title
 * @property {number} pageIndex  - zero-based page index in THIS document
 * @property {boolean} [open]    - whether children start expanded (default true)
 * @property {OutlineItem[]} [children]
 */

/**
 * Builds an explicit destination array pointing at the top of a page.
 *
 * [ pageRef /XYZ left top zoom ] with a null zoom means "go here, keep the
 * reader's current magnification": the right behaviour for a bundle, where
 * changing the reader's zoom on every bookmark click gets in the way.
 *
 * `left` and `top` are the corner of the page that shows top-left on screen, in
 * unrotated user space, taken from the MediaBox rather than assumed (a MediaBox does
 * not have to start at the origin) and from the page's /Rotate: (x, y+h) at 0,
 * (x, y) at 90, (x+w, y) at 180 and (x+w, y+h) at 270.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} pdfDoc
 * @param {number} pageIndex
 * @returns {Array} array suitable for context.obj()
 */
export function destinationForPage(pdfDoc, pageIndex) {
  const count = pdfDoc.getPageCount();
  const idx = Math.max(0, Math.min(pageIndex, count - 1));
  const page = pdfDoc.getPage(idx);
  const box = page.getMediaBox();
  // The corner that appears top-left once the page is turned: a document the reader rotated by 90,
  // 180 or 270 degrees (/Rotate) would otherwise land at what is, on screen, its bottom or side.
  const turn = (((page.getRotation().angle % 360) + 360) % 360);
  const left = (turn === 180 || turn === 270) ? box.x + box.width : box.x;
  const top = (turn === 90 || turn === 180) ? box.y : box.y + box.height;
  return [page.ref, PDFName.of('XYZ'), PDFNumber.of(left), PDFNumber.of(top), PDFNull];
}

/**
 * Counts the visible descendants of a node, per the /Count rules above.
 * A child is always visible; its own descendants are visible only if it is open.
 *
 * @param {OutlineItem[]} children
 * @returns {number}
 */
function visibleDescendantCount(children) {
  let total = 0;
  for (const child of children ?? []) {
    total += 1;
    const grandchildren = child.children ?? [];
    if (grandchildren.length > 0 && child.open !== false) {
      total += visibleDescendantCount(grandchildren);
    }
  }
  return total;
}

/**
 * Writes a document outline into pdfDoc, replacing any existing one.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} pdfDoc
 * @param {OutlineItem[]} items - top-level items, in display order
 * @param {Object} [opts]
 * @param {boolean} [opts.showOutlinePane=true] - set /PageMode /UseOutlines so
 *        the bundle opens with the bookmarks panel showing
 * @returns {number} the number of outline items written
 */
export function setOutline(pdfDoc, items, { showOutlinePane = true } = {}) {
  const context = pdfDoc.context;
  const catalog = pdfDoc.catalog;

  if (!Array.isArray(items) || items.length === 0) {
    catalog.delete(PDFName.of('Outlines'));
    return 0;
  }

  const rootRef = context.nextRef();
  let written = 0;

  /**
   * Creates the dictionaries for one sibling run and links them to each other
   * and to their parent. Returns [firstRef, lastRef].
   */
  const buildLevel = (siblings, parentRef) => {
    const refs = siblings.map(() => context.nextRef());

    siblings.forEach((item, i) => {
      const children = item.children ?? [];
      const isOpen = item.open !== false;

      const dict = context.obj({});
      dict.set(PDFName.of('Title'), PDFHexString.fromText(String(item.title ?? '')));
      dict.set(PDFName.of('Parent'), parentRef);
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < refs.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);

      if (typeof item.pageIndex === 'number') {
        dict.set(PDFName.of('Dest'), context.obj(destinationForPage(pdfDoc, item.pageIndex)));
      }

      // Register before descending so children can name this ref as /Parent.
      context.assign(refs[i], dict);
      written++;

      if (children.length > 0) {
        const [childFirst, childLast] = buildLevel(children, refs[i]);
        dict.set(PDFName.of('First'), childFirst);
        dict.set(PDFName.of('Last'), childLast);
        dict.set(
          PDFName.of('Count'),
          PDFNumber.of(isOpen ? visibleDescendantCount(children) : -children.length),
        );
      }
    });

    return [refs[0], refs[refs.length - 1]];
  };

  const [firstRef, lastRef] = buildLevel(items, rootRef);

  const rootDict = context.obj({});
  rootDict.set(PDFName.of('Type'), PDFName.of('Outlines'));
  rootDict.set(PDFName.of('First'), firstRef);
  rootDict.set(PDFName.of('Last'), lastRef);
  // Root /Count is the number of items visible when the document opens.
  rootDict.set(PDFName.of('Count'), PDFNumber.of(visibleDescendantCount(items)));
  context.assign(rootRef, rootDict);

  catalog.set(PDFName.of('Outlines'), rootRef);
  if (showOutlinePane) catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));

  return written;
}

/**
 * Reads an outline back out of a document as a plain tree.
 *
 * Production code does not need this: the restore path reads the bundle index
 * from metadata, not from bookmarks. It lives here rather than in the tests so
 * that "can this be read back correctly" is answered by traversing the same
 * /First,/Next chain a reader would, and so a future change to setOutline has
 * its counterpart in the same file.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} pdfDoc
 * @returns {Array<{title: string, pageIndex: number|null, open: boolean, count: number|null, children: Array}>}
 */
export function readOutline(pdfDoc) {
  const context = pdfDoc.context;
  const rootRef = pdfDoc.catalog.get(PDFName.of('Outlines'));
  if (!rootRef) return [];
  const root = context.lookup(rootRef);
  if (!root) return [];

  const pageIndexByRefTag = new Map();
  pdfDoc.getPages().forEach((p, i) => pageIndexByRefTag.set(p.ref.tag, i));

  const walk = (firstRef, parentTag, seen = new Set()) => {
    const out = [];
    let ref = firstRef;
    while (ref) {
      if (seen.has(ref.tag)) break; // defensive: a malformed /Next loop
      seen.add(ref.tag);
      const dict = context.lookup(ref);
      if (!dict) break;

      const titleObj = dict.get(PDFName.of('Title'));
      const title = titleObj?.decodeText ? titleObj.decodeText() : String(titleObj ?? '');

      let pageIndex = null;
      const dest = context.lookup(dict.get(PDFName.of('Dest')));
      if (dest && typeof dest.get === 'function' && dest.size?.() > 0) {
        const target = dest.get(0);
        pageIndex = pageIndexByRefTag.has(target?.tag) ? pageIndexByRefTag.get(target.tag) : null;
      }

      const countObj = dict.get(PDFName.of('Count'));
      const count = countObj?.asNumber ? countObj.asNumber() : null;

      const parent = dict.get(PDFName.of('Parent'));
      const firstChild = dict.get(PDFName.of('First'));

      out.push({
        title,
        pageIndex,
        open: count == null ? true : count >= 0,
        count,
        parentTagMatches: parentTag == null ? true : parent?.tag === parentTag,
        children: firstChild ? walk(firstChild, ref.tag) : [],
      });

      ref = dict.get(PDFName.of('Next'));
    }
    return out;
  };

  return walk(root.get(PDFName.of('First')), rootRef.tag);
}
