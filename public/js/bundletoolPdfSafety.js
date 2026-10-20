/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolPdfSafety.js
 * What a source document carries beyond its page content, and what happens to it in a bundle.
 *
 * A PDF is more than pages. It can hold annotations, filled-in form fields, links (to a web
 * address, to another page of itself, or to a program on the reader's computer), scripts,
 * attached files and markers that say "redact this" without having done so. copyPages carries
 * a page's annotation objects across but none of the document-level structure they lean on, and
 * follows any page reference it finds, so a bare copy would give a bundle:
 *
 *   - links to other pages of the SOURCE that drag those pages into the bundle as orphans
 *     (unreachable, but adding weight) and point at nothing;
 *   - named-destination links pointing at names the bundle does not have;
 *   - form fields with no form around them: shown, not editable, hidden by some viewers;
 *   - Launch and JavaScript actions (including ones chained behind a harmless-looking link with /Next,
 *     on form widgets, on any kind of annotation, or on a page or field as an additional action) and
 *     attached files, all of it live in a document that is filed and served to other people.
 *
 * `prepareSourceForMerge` runs on each USER document just before it is copied in. It never runs
 * on the pages this tool draws itself (index, cover), whose links and metadata annotation are
 * the bundle's own and must survive untouched.
 *
 * `findUnappliedRedactions` is separate: it reads a document at the moment it is added, so the
 * person can be told BEFORE the text underneath a redaction marker goes into a bundle. It is
 * modelled on Tris Sherliker's own detection in BunTool and keeps its shape: the same function
 * name, one-based page numbers, and the same per-page try/catch that skips an unreadable page's
 * annotations rather than failing the whole check. It reads the annotations through pdf-lib's
 * own types (pdfDoc.getPages() here) rather than through a `pdflib` global.
 *
 * Nothing here throws on a malformed structure: a document that cannot be read closely is left
 * as it is (and copied unchanged) rather than blocking the build.
 */

import { PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString, PDFNumber, PDFStream } from './bundletoolPdfLib.js';
import { addLinkAnnotation } from './bundletoolLinks.js';

const N = (name) => PDFName.of(name);

/** URI schemes a link may keep. file:, javascript:, data: and the like are dropped. */
const SAFE_URI = /^(https?:|mailto:|tel:)/i;

/** Annotation subtypes that are active content or hidden payload, never carried into a bundle. */
const DROPPED_SUBTYPES = new Set(['FileAttachment', 'Screen', 'Movie', 'Sound', 'RichMedia', '3D']);

/** The annotations of a page as dictionaries, resolving references. */
function pageAnnotDicts(doc, page) {
  const out = [];
  let annots = page.node.get(N('Annots'));
  if (annots instanceof PDFRef) annots = doc.context.lookup(annots);
  if (!(annots instanceof PDFArray)) return out;
  for (let i = 0; i < annots.size(); i++) {
    const a = doc.context.lookup(annots.get(i));
    if (a instanceof PDFDict) out.push(a);
  }
  return out;
}

const subtypeOf = (annot) => {
  const s = annot.get(N('Subtype'));
  return s instanceof PDFName ? s.decodeText() : '';
};

// --- redaction markers ---------------------------------------------------------------------

/**
 * One-based page numbers carrying a /Redact annotation. A redaction that has been APPLIED removes
 * the content beneath it and deletes the annotation, so any marker still present is by definition
 * unapplied: the text under it can still be read.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @returns {number[]}
 */
export function findUnappliedRedactions(doc) {
  const pages = [];
  try {
    doc.getPages().forEach((page, index) => {
      try {
        if (pageAnnotDicts(doc, page).some((a) => subtypeOf(a) === 'Redact')) pages.push(index + 1);
      } catch { /* unreadable annotations on this page: keep checking the rest */ }
    });
  } catch { /* a document whose page tree cannot be walked reports none rather than blocking */ }
  return pages;
}

/** "page 2", "pages 2 and 4", "pages 2, 4 and 9". */
export function describePages(pages) {
  if (pages.length === 1) return `page ${pages[0]}`;
  return `pages ${pages.slice(0, -1).join(', ')} and ${pages[pages.length - 1]}`;
}

// --- destinations ---------------------------------------------------------------------------

/** Name -> destination array, from the catalog's /Names /Dests tree and the older /Dests dictionary. */
function namedDestinations(doc) {
  const map = new Map();
  const context = doc.context;
  const take = (name, value) => {
    let v = context.lookup(value);
    if (v instanceof PDFDict) v = context.lookup(v.get(N('D')));
    if (v instanceof PDFArray) map.set(name, v);
  };
  const walk = (node, depth) => {
    if (!(node instanceof PDFDict) || depth > 12) return;
    const names = context.lookup(node.get(N('Names')));
    if (names instanceof PDFArray) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const key = context.lookup(names.get(i));
        if (key instanceof PDFString || key instanceof PDFHexString) take(key.decodeText(), names.get(i + 1));
      }
    }
    const kids = context.lookup(node.get(N('Kids')));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(context.lookup(kids.get(i)), depth + 1);
  };
  try {
    const catalog = doc.catalog;
    const names = context.lookup(catalog.get(N('Names')));
    if (names instanceof PDFDict) walk(context.lookup(names.get(N('Dests'))), 0);
    const legacy = context.lookup(catalog.get(N('Dests')));
    if (legacy instanceof PDFDict) {
      for (const [key, value] of legacy.entries()) take(key.decodeText(), value);
    }
  } catch { /* no usable names: named links are dropped below */ }
  return map;
}

/** The page index a destination array points at (its first element is the page), or -1. */
function destPageIndex(doc, destArray, pageIndexByTag) {
  if (!(destArray instanceof PDFArray) || destArray.size() < 1) return -1;
  const first = destArray.get(0);
  if (first instanceof PDFRef) {
    const i = pageIndexByTag.get(first.tag);
    return i === undefined ? -1 : i;
  }
  return -1;
}

/** A link's internal destination as a page index in its own document: -1 unresolvable, null not internal. */
function internalTarget(doc, annot, named, pageIndexByTag) {
  const context = doc.context;
  const resolve = (dest) => {
    let d = context.lookup(dest);
    if (d instanceof PDFString || d instanceof PDFHexString) return destPageIndex(doc, named.get(d.decodeText()), pageIndexByTag);
    if (d instanceof PDFName) return destPageIndex(doc, named.get(d.decodeText()), pageIndexByTag);
    if (d instanceof PDFDict) d = context.lookup(d.get(N('D')));
    return destPageIndex(doc, d, pageIndexByTag);
  };
  const dest = annot.get(N('Dest'));
  if (dest !== undefined) return resolve(dest);
  const action = context.lookup(annot.get(N('A')));
  if (action instanceof PDFDict && action.get(N('S')) === N('GoTo')) return resolve(action.get(N('D')));
  return null;
}

/**
 * A fresh action for an action dictionary that is a web, mail or phone address, or null. Built anew
 * from the address alone so nothing else the original carried (a /Next chain of further actions,
 * extra keys) comes with it.
 */
function safeUriActionFrom(context, actionValue) {
  const action = context.lookup(actionValue);
  if (!(action instanceof PDFDict) || action.get(N('S')) !== N('URI')) return null;
  const uri = context.lookup(action.get(N('URI')));
  if (!((uri instanceof PDFString || uri instanceof PDFHexString) && SAFE_URI.test(uri.decodeText().trim()))) return null;
  const clean = PDFDict.withContext(context);
  clean.set(N('S'), N('URI'));
  clean.set(N('URI'), uri);
  return clean;
}

/** Keys that only ever hold scripts, additional actions, attachments or associated files. */
const ACTIVE_KEYS = ['AA', 'JS', 'EF', 'RF', 'AF'];

/** Action types that run programs, send data, open other files, play media or act on the reader's view. */
const UNSAFE_ACTIONS = new Set([
  'JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'Rendition', 'Movie', 'Sound',
  'RichMediaExecute', 'GoTo3DView', 'Thread', 'SetOCGState', 'ResetForm', 'Hide', 'Named', 'Trans',
]);

/** Most objects the clean-up walk visits in one document; past it the targeted clean-up still applies. */
const WALK_BUDGET = 1_500_000;

/**
 * Clears whatever active content can be reached from the given pages, whichever key it hangs off:
 * scripts and additional actions (/AA, /JS), attached and associated files (/EF, /RF, /AF), an
 * action in /A or /PA that is not a plain web address (a URI action is rebuilt with nothing chained
 * behind it), a chain of /Next actions, and any action dictionary of an unsafe kind found anywhere.
 * This is the net under the per-annotation rules in prepareSourceForMerge: it covers form fields and
 * their parents, popups, replies, appearance and page-level entries, and anything else a page points at.
 *
 * Bounded (a visited set, an iterative walk, an object budget) so a cyclic or enormous structure
 * cannot hang the build.
 */
function scrubReachable(doc, pageNodes) {
  const context = doc.context;
  const seen = new Set();
  const stack = pageNodes.slice();
  let budget = WALK_BUDGET;

  const push = (value) => {
    if (value instanceof PDFRef) {
      if (seen.has(value.tag)) return;
      seen.add(value.tag);
      value = context.lookup(value);
    }
    if (value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream) stack.push(value);
  };

  while (stack.length && budget-- > 0) {
    const node = stack.pop();
    if (node instanceof PDFArray) {
      for (let i = 0; i < node.size(); i++) push(node.get(i));
      continue;
    }
    const dict = node instanceof PDFStream ? node.dict : node;
    if (!(dict instanceof PDFDict)) continue;

    for (const key of ACTIVE_KEYS) dict.delete(N(key));
    for (const key of ['A', 'PA']) {
      const value = dict.get(N(key));
      if (value === undefined) continue;
      const clean = safeUriActionFrom(context, value);
      if (clean) dict.set(N(key), clean); else dict.delete(N(key));
    }
    // An action dictionary reached by any other route (a chained /Next, or one referenced from
    // somewhere unusual): an unsafe kind is emptied, and no chain is left behind a safe one.
    const kind = dict.get(N('S'));
    const kindName = kind instanceof PDFName ? kind.decodeText() : '';
    if (UNSAFE_ACTIONS.has(kindName) || (dict.get(N('Type')) === N('Action') && kindName !== 'URI' && kindName !== 'GoTo')) {
      for (const key of dict.keys().slice()) dict.delete(key);
    } else if (dict.has(N('S')) && dict.has(N('Next'))) {
      dict.delete(N('Next'));
    }

    for (const [key, value] of dict.entries()) {
      // A page's parent leads up to the page tree, which the copy does not follow either.
      if (key === N('Parent') && dict.get(N('Type')) === N('Page')) continue;
      push(value);
    }
  }
}

// --- forms ----------------------------------------------------------------------------------

/** True when some form widget in the document has no appearance stream of its own. */
function someWidgetLacksAppearance(doc) {
  try {
    return doc.getPages().some((page) => pageAnnotDicts(doc, page)
      .some((a) => subtypeOf(a) === 'Widget' && !a.has(N('AP'))));
  } catch {
    return false;
  }
}

/**
 * Flattens the document's form so filled-in values are page content: visible everywhere, not
 * editable, and free of the field-name clashes two forms with a "name" field would otherwise
 * cause in one bundle. Appearances already in the file are kept as they are. A form that cannot
 * be flattened (broken structure, XFA-only) is left alone: its widgets still copy across with
 * their appearance streams.
 *
 * @returns {boolean} true when the form was flattened
 */
function flattenForms(doc) {
  try {
    if (!doc.catalog.has(N('AcroForm'))) return false;
    const form = doc.getForm();
    if (form.getFields().length === 0) return false;
    // Keep the appearances the file has. Only a field with no appearance at all would flatten to
    // nothing, so in that case (and only then) pdf-lib draws the fields itself first.
    form.flatten({ updateFieldAppearances: someWidgetLacksAppearance(doc) });
    return true;
  } catch {
    return false;
  }
}

// --- preparing a source for the merge ---------------------------------------------------------

/**
 * Cleans one user document in memory just before its pages are copied into the bundle, and reports
 * the internal links to re-create once they have a new home.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} src
 * @returns {{ links: Array<{pageIndex: number, rect: number[], targetPageIndex: number}> }}
 */
export function prepareSourceForMerge(src) {
  const links = [];
  const context = src.context;
  flattenForms(src);

  let pages;
  try { pages = src.getPages(); } catch { return { links }; }
  const pageIndexByTag = new Map(pages.map((p, i) => [p.ref.tag, i]));
  const named = namedDestinations(src);

  pages.forEach((page, pageIndex) => {
    try {
      // Scripted page open/close actions, article threads (whose beads point at other pages),
      // attachments and app-specific data never travel.
      for (const key of ['AA', 'B', 'AF', 'PieceInfo']) page.node.delete(N(key));
      const annotsRaw = page.node.get(N('Annots'));
      const annots = annotsRaw instanceof PDFRef ? context.lookup(annotsRaw) : annotsRaw;
      if (!(annots instanceof PDFArray)) return;

      const keep = PDFArray.withContext(context);
      for (let i = 0; i < annots.size(); i++) {
        const entry = annots.get(i);
        const annot = context.lookup(entry);
        if (!(annot instanceof PDFDict)) continue;
        const subtype = subtypeOf(annot);
        annot.delete(N('AA'));     // scripted mouse and focus actions

        if (DROPPED_SUBTYPES.has(subtype)) continue;

        if (subtype === 'Link') {
          const target = internalTarget(src, annot, named, pageIndexByTag);
          if (target === null) {
            // A web, mail or phone address is kept, rebuilt with nothing chained behind it. Launch,
            // JavaScript, SubmitForm, remote GoTo, file: and the rest are left out.
            const clean = safeUriActionFrom(context, annot.get(N('A')));
            if (!clean) continue;
            annot.set(N('A'), clean);
            annot.delete(N('PA'));
          } else {
            // Re-created after the copy, aimed at the page it now occupies. Left in place,
            // copyPages would follow the reference and copy the target page (and its
            // neighbours) into the bundle as unreachable orphans.
            const rect = context.lookup(annot.get(N('Rect')));
            if (target >= 0 && rect instanceof PDFArray && rect.size() === 4) {
              const nums = [0, 1, 2, 3].map((k) => {
                const v = context.lookup(rect.get(k));
                return v instanceof PDFNumber ? v.asNumber() : NaN;
              });
              if (nums.every(Number.isFinite)) links.push({ pageIndex, rect: nums, targetPageIndex: target });
            }
            continue;
          }
        } else {
          // Only a link acts on a click in a bundle. A form widget's or any other annotation's own
          // action (a script, a program to launch, a form to send) is removed; its appearance stays.
          annot.delete(N('A'));
          annot.delete(N('PA'));
        }
        keep.push(entry);
      }
      page.node.set(N('Annots'), keep);
    } catch { /* leave this page's annotations as they were */ }
  });
  scrubReachable(src, pages.map((p) => p.node));
  return { links };
}

/**
 * Copies a user document's pages into the bundle: cleaned first, internal links re-created after.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} dst
 * @param {import('./bundletoolPdfLib.js').PDFDocument} src
 * @returns {Promise<number>} pages copied
 */
export async function copyDocumentPages(dst, src) {
  const start = dst.getPageCount();
  const { links } = prepareSourceForMerge(src);
  const pages = await dst.copyPages(src, src.getPageIndices());
  for (const page of pages) dst.addPage(page);
  for (const { pageIndex, rect, targetPageIndex } of links) {
    try {
      addLinkAnnotation(dst, dst.getPage(start + pageIndex), rect, start + targetPageIndex);
    } catch { /* a link that cannot be re-created is simply not carried */ }
  }
  return pages.length;
}
