/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolLinks.js
 * Internal link annotations, per ISO 32000-1:2008 §12.5.6.5 (Link annotations).
 *
 * Two things matter here, and both are done explicitly:
 *
 *   - /Annots must be APPENDED to, never replaced. The bundle pipeline adds
 *     footer links first and index links afterwards; a setter would silently
 *     drop whichever ran first.
 *   - An annotation /Rect is in unrotated user space. On a page with /Rotate
 *     the clickable area therefore has to be mapped back out of the visible
 *     orientation, or the link sits somewhere off the side of the page.
 */

import { PDFName, PDFNumber, PDFArray, PDFDict, PDFRef } from './bundletoolPdfLib.js';
import { destinationForPage } from './bundletoolOutline.js';

/**
 * Appends a link annotation to a page.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} pdfDoc
 * @param {import('./bundletoolPdfLib.js').PDFPage} page
 * @param {[number, number, number, number]} rect - [x1, y1, x2, y2] in unrotated user space
 * @param {number} destPageIndex - zero-based page index to jump to
 * @returns {import('./bundletoolPdfLib.js').PDFRef} the new annotation's ref
 */
export function addLinkAnnotation(pdfDoc, page, rect, destPageIndex) {
  const context = pdfDoc.context;

  const annot = context.obj({});
  annot.set(PDFName.of('Type'), PDFName.of('Annot'));
  annot.set(PDFName.of('Subtype'), PDFName.of('Link'));

  const rectArray = PDFArray.withContext(context);
  for (const n of rect) rectArray.push(PDFNumber.of(n));
  annot.set(PDFName.of('Rect'), rectArray);

  // No visible border. Border is the older form and Adobe still honours it;
  // /BS is the modern one. Both are cheap, and between them every reader
  // stops drawing the ugly default box round the link.
  const border = PDFArray.withContext(context);
  for (const n of [0, 0, 0]) border.push(PDFNumber.of(n));
  annot.set(PDFName.of('Border'), border);
  const bs = context.obj({});
  bs.set(PDFName.of('W'), PDFNumber.of(0));
  annot.set(PDFName.of('BS'), bs);

  // Bit 3 (value 4) = Print. Without it some readers drop the annotation when
  // the bundle is printed, which is where court bundles usually end up.
  annot.set(PDFName.of('F'), PDFNumber.of(4));

  annot.set(PDFName.of('Dest'), context.obj(destinationForPage(pdfDoc, destPageIndex)));

  const ref = context.register(annot);
  appendAnnotation(pdfDoc, page, ref);
  return ref;
}

/**
 * Pushes an annotation ref onto a page's /Annots, creating or de-referencing
 * the array as needed.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} pdfDoc
 * @param {import('./bundletoolPdfLib.js').PDFPage} page
 * @param {import('./bundletoolPdfLib.js').PDFRef} annotRef
 */
export function appendAnnotation(pdfDoc, page, annotRef) {
  const context = pdfDoc.context;
  const key = PDFName.of('Annots');
  const existing = page.node.get(key);

  if (existing instanceof PDFArray) {
    existing.push(annotRef);
    return;
  }
  if (existing instanceof PDFRef) {
    const resolved = context.lookup(existing);
    if (resolved instanceof PDFArray) {
      resolved.push(annotRef);
      return;
    }
  }
  const arr = PDFArray.withContext(context);
  arr.push(annotRef);
  page.node.set(key, arr);
}

/**
 * Counts the link annotations on a page. Used by the tests to prove that a
 * later stage appended to /Annots rather than replacing it.
 *
 * @returns {number}
 */
export function countLinkAnnotations(pdfDoc, page) {
  const context = pdfDoc.context;
  let annots = page.node.get(PDFName.of('Annots'));
  if (annots instanceof PDFRef) annots = context.lookup(annots);
  if (!(annots instanceof PDFArray)) return 0;
  let n = 0;
  for (let i = 0; i < annots.size(); i++) {
    const a = context.lookup(annots.get(i));
    if (a instanceof PDFDict && a.get(PDFName.of('Subtype')) === PDFName.of('Link')) n++;
  }
  return n;
}
