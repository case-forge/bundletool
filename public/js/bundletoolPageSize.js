/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolPageSize.js
 * The one place that knows how big a page is.
 *
 * Every page size the tool uses comes from here: the blank pages that pad a
 * printable bundle, the page an added JPG or PNG is placed on, the width the
 * footer shrinks its label against, the cover page's own width, and the jsPDF
 * document the index is drawn into. A separate literal in each place is how a
 * bundle would end up with A4 index pages in front of Letter documents, which
 * is worse than not offering the choice at all.
 *
 * Sizes are in POINTS, which is what pdf-lib works in. jsPDF takes millimetres
 * here (bundletoolToc.js constructs its document with unit:'mm'), so it gets
 * its own accessor rather than converting at the call site.
 *
 * NOTE ON SOURCE DOCUMENTS: this sets the size of pages BundleTool itself
 * draws. Pages copied from the user's own PDFs keep whatever size they were
 * authored at: rescaling someone's evidence would change what the court
 * sees, and is never done silently.
 */

/** Page sizes in points, portrait. */
export const PAGE_SIZES = {
  a4:     { label: 'A4',          points: [595.28, 841.89], mm: 'a4' },
  letter: { label: 'US Letter',   points: [612, 792],       mm: 'letter' },
  legal:  { label: 'US Legal',    points: [612, 1008],      mm: 'legal' },
};

export const DEFAULT_PAGE_SIZE = 'a4';

/** Every key the setting accepts, for Config's validator. */
export const validPageSizes = Object.keys(PAGE_SIZES);

/**
 * Resolves a page-size key to its entry, falling back rather than throwing:
 * a bundle is not worth failing over an unknown size string from a settings
 * code made by another version, and A4 is the default.
 *
 * @param {string} key
 * @returns {{label: string, points: number[], mm: string}}
 */
export function pageSize(key) {
  return PAGE_SIZES[String(key || '').toLowerCase()] ?? PAGE_SIZES[DEFAULT_PAGE_SIZE];
}

/** [width, height] in points. */
export function pageDimensions(key) {
  return pageSize(key).points;
}

/** Width in points: what the footer measures its label against. */
export function pageWidth(key) {
  return pageSize(key).points[0];
}

/** The format string jsPDF expects (its document is constructed in mm). */
export function jsPdfFormat(key) {
  return pageSize(key).mm;
}
