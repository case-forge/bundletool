/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolOcrPrinted.js
 * Reading only what is not already text. A page can carry real, visible text (a born-digital page, or a scan a PDF
 * editor has stamped); OCR reads that text off the rendered page like any other print, and drawing it again as an
 * invisible layer would leave every visible word on the page twice. OCRmyPDF's redo mode reads "an image of each page
 * ... with visible text masked out"; here the same rule is kept by leaving out every recognised word that lies over
 * visible text the page already has. What is printed in its images is still read.
 *
 * WHICH TEXT IS VISIBLE. pdf.js reports every text item with its place (getTextContent) but not how it is drawn, and
 * an existing OCR layer is text too: invisible (render mode 3), and taken off before the new layer is drawn
 * (bundletoolOcrRedo.js), so the words over it must stay. pdf.js's operator list does say how each glyph is drawn. Both
 * come from one reading of the page's content in the same order, so each item's characters are matched, in order, to
 * the glyphs the operator list draws, and an item counts as visible when nearly all of its characters were drawn in
 * a visible mode. An item that cannot be matched counts as not visible: a word over it is kept, so a mistake can only
 * leave a duplicate, never lose a word.
 *
 * Pure: the pdf.js page is passed in, nothing is imported.
 */

/** Render modes that draw nothing: invisible (3), and clipping only (7). */
const UNDRAWN = new Set([3, 7]);
/** How far ahead in the drawn glyphs a character of an item is looked for. */
const LOOKAHEAD = 64;
/** Share of an item's characters that must be matched to visibly drawn glyphs for it to count as visible. */
const VISIBLE_SHARE = 0.8;
/** Share of a recognised word's box that visible text must cover for the word to be left out. */
const COVERED = 0.5;

/** Every glyph the operator list draws outside annotations, in order: its characters and whether it is visible. */
export function drawnGlyphs(opList, OPS) {
  const out = [];
  const stack = [];
  let mode = 0;
  let annotation = 0;
  const { fnArray, argsArray } = opList;
  const take = (glyphs) => {
    for (const g of glyphs) {
      if (Array.isArray(g)) take(g);
      else if (g && typeof g === 'object' && typeof g.unicode === 'string') {
        for (const ch of g.unicode) if (!/\s/.test(ch)) out.push({ ch, visible: !UNDRAWN.has(mode) });
      }
    }
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) stack.push(mode);
    else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) mode = stack.length ? stack.pop() : mode;
    else if (fn === OPS.beginAnnotation) annotation++;
    else if (fn === OPS.endAnnotation) annotation = Math.max(0, annotation - 1);
    else if (fn === OPS.setTextRenderingMode) mode = argsArray[i][0];
    else if ((fn === OPS.showText || fn === OPS.showSpacedText) && !annotation) take(argsArray[i][0] ?? []);
  }
  return out;
}

/** For each text item, whether it is visible text (see this file's header comment). */
export function visibleItems(items, glyphs) {
  let at = 0;
  return items.map((item) => {
    let chars = 0;
    let visible = 0;
    for (const ch of item.str ?? '') {
      if (/\s/.test(ch)) continue;
      chars++;
      const end = Math.min(glyphs.length, at + LOOKAHEAD);
      let j = at;
      while (j < end && glyphs[j].ch !== ch) j++;
      if (j < end) {
        if (glyphs[j].visible) visible++;
        at = j + 1;
      }
    }
    return chars > 0 && visible >= VISIBLE_SHARE * chars;
  });
}

/**
 * The page's visible text, as boxes in the pixels of a raster of it made with `viewport` (pdf.js, rotation 0): each
 * item from a little below its baseline to its full height, along its own direction, as four corners.
 *
 * @param {object} pdfjsPage - a pdf.js page, before cleanup
 * @param {{convertToViewportPoint: (x: number, y: number) => number[]}} viewport - the raster's own viewport
 * @param {object} OPS - pdf.js's OPS
 * @returns {Promise<{x: number, y: number}[][]>}
 */
export async function visibleTextBoxes(pdfjsPage, viewport, OPS) {
  return (await visibleText(pdfjsPage, viewport, OPS)).boxes;
}

/**
 * The page's visible text: its boxes (as visibleTextBoxes gives them) and how many characters it holds, spaces left
 * out. The count says whether the page has text of its own, by the same measure as bundletoolOcr.js's needsOcr: a page
 * with fewer than OCR_MIN_CHARS visible characters is a scan, whatever invisible layer it carries.
 *
 * @returns {Promise<{boxes: {x: number, y: number}[][], chars: number}>}
 */
export async function visibleText(pdfjsPage, viewport, OPS) {
  const content = await pdfjsPage.getTextContent({ disableNormalization: true });
  const items = content.items.filter((i) => typeof i.str === 'string' && i.str.trim());
  if (!items.length) return { boxes: [], chars: 0 };
  const glyphs = drawnGlyphs(await pdfjsPage.getOperatorList(), OPS);
  const visible = visibleItems(items, glyphs);
  const boxes = [];
  let chars = 0;
  items.forEach((item, k) => {
    if (!visible[k]) return;
    chars += item.str.replace(/\s/g, '').length;
    const [a, b, , , e, f] = item.transform;
    const len = Math.hypot(a, b) || 1;
    const ux = a / len, uy = b / len;   // along the text
    const vx = -uy, vy = ux;            // up from the baseline
    const w = item.width, h = item.height || len;
    const corner = (s, t) => {
      const [x, y] = viewport.convertToViewportPoint(e + s * ux + t * vx, f + s * uy + t * vy);
      return { x, y };
    };
    boxes.push([corner(0, -0.25 * h), corner(w, -0.25 * h), corner(w, h), corner(0, h)]);
  });
  return { boxes, chars };
}

/** The inverse of an affine map [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f). */
function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * The recognised words that do not lie over visible text: a word is left out when visible text covers at least half
 * of its box.
 *
 * @param {{x0: number, y0: number, x1: number, y1: number}[]} words - in the pixels of the image they were read on
 * @param {{x: number, y: number}[][]} boxes - visible text, in the raster's pixels (visibleTextBoxes)
 * @param {number[]} [toRaw] - the map from the image the words were read on to the raster (bundletoolDeskew.js)
 */
export function withoutPrintedText(words, boxes, toRaw) {
  if (!boxes.length || !words.length) return words;
  const back = toRaw ? invert(toRaw) : [1, 0, 0, 1, 0, 0];
  const rects = boxes.map((pts) => {
    const xs = [], ys = [];
    for (const { x, y } of pts) {
      xs.push(back[0] * x + back[2] * y + back[4]);
      ys.push(back[1] * x + back[3] * y + back[5]);
    }
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  });
  return words.filter((w) => {
    const area = Math.max(0, w.x1 - w.x0) * Math.max(0, w.y1 - w.y0);
    if (!(area > 0)) return true;
    let covered = 0;
    for (const r of rects) {
      covered += Math.max(0, Math.min(r.x1, w.x1) - Math.max(r.x0, w.x0)) * Math.max(0, Math.min(r.y1, w.y1) - Math.max(r.y0, w.y0));
      if (covered >= COVERED * area) return false;
    }
    return true;
  });
}
