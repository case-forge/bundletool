/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolOcr.js
 * Makes a scanned page's text selectable and searchable ("Ctrl+F"). Two
 * independent things live here, both pure and both testable without a browser
 * or a live OCR engine:
 *
 *   needsOcr()      decides whether a page is worth OCRing at all, from the
 *                    real text layer pdf.js already reports for it.
 *   embedOcrLayer()  turns one page's OCR result (words plus their pixel
 *                    bounding boxes) into an invisible text layer over the
 *                    page's own existing content: the page's own image is
 *                    never touched or redrawn, only added to.
 *
 * LICENCE NOTE. This file carries no MPL-2.0 header, for the same reason as
 * bundletoolCover.js: none of its code comes from BunTool, which has no OCR
 * feature. tests/policy.test.mjs keeps this file out of MUST_KEEP_MPL_HEADER
 * unless code from a file that does carry the notice is moved into it.
 *
 * ONE ENGINE, TWO CALLERS. The automatic per-page check on file add and the
 * manual "Force OCR" button both call exactly these two functions; neither
 * keeps its own copy of the threshold or the geometry. It is the discipline
 * bundletoolCover.js's flattenCoverConfig() follows too: one place this can be
 * wrong, not several that can quietly drift apart.
 */

import { TextRenderingMode, pushGraphicsState, popGraphicsState, setCharacterSqueeze, concatTransformationMatrix } from './bundletoolPdfLib.js';
import { applyAffine } from './bundletoolDeskew.js';
import { removeInvisibleText } from './bundletoolOcrRedo.js';
import { straightenContent } from './bundletoolOcrReorient.js';

/** A line is flattened onto one baseline when its words' baselines drift by no more than this many line
 * heights. On dense scans read back by poppler (the share of words that come back in order): with a limit
 * of half a line, 90% on a page a few tenths of a degree off level; with two lines, 99%, and on pages up to
 * two degrees off, 81% instead of 59%. The cost is the layer sitting a little off
 * the printed line at its ends (on average half a point on a normal scan, under two on a badly skewed one). */
export const FLATTEN_LIMIT = 2;

/**
 * A page counts as "has real text" once it clears this many extracted
 * characters (page.getTextContent() items, trimmed and joined). 40 is the
 * threshold CaseForge's own tooling uses elsewhere for exactly the same
 * question ("is this near-empty text, or a real layer") on real scanned legal
 * documents. Not zero: a scanned page can carry a handful of real characters (a
 * stamp, a faint header, a page number a scanner's own firmware burned in)
 * without genuinely being text-readable, and treating any non-empty
 * extraction as "done" would skip OCR on exactly the pages that most need it.
 */
export const OCR_MIN_CHARS = 40;

/**
 * @param {Array<{str: string}>} textItems - pdf.js page.getTextContent().items
 * @returns {boolean} true if this page is a real OCR candidate
 */
export function needsOcr(textItems) {
  const chars = (textItems || []).reduce((n, item) => n + (item?.str?.length || 0), 0);
  return chars < OCR_MIN_CHARS;
}

/** Rasterising for OCR at this many pixels per inch, the figure CaseForge's own OCR tooling uses
 * for the same trade-off: good enough for the engine, not so large it costs time for nothing. */
export const OCR_RASTER_DPI = 200;
const POINTS_PER_INCH = 72;

/** The largest SINGLE embedded image pdf.js will decode while opening a document for OCR
 * (pdf.js's own `maxImageSize` loading option, a pixel count, not the page's own size). A page
 * can be an ordinary size while carrying one enormous embedded image, and pdf.js decodes that
 * image before any raster-cap code here runs: uncapped, a small PDF with a single 10000x10000
 * image (100,000,000 pixels) reaches that decode before any other limit in this file applies, and
 * peaks at 1.52 GB. An A3 page at 600 DPI, the real ceiling this must still pass, needs about 69.6
 * million pixels (7016 x 9921); this is set comfortably above that and comfortably below the
 * 100-million-pixel attack shape, so there is no ambiguity at the boundary between the two.
 *
 * NOT a per-page memory bound: this caps one image at a time, not the total pixels a page's
 * images sum to. Four separate 8000x8000 images (each individually under this cap) on one page
 * peak at 1.62 GB together, more than the single large image above. A cumulative bound would need
 * summing every image XObject's declared size per page (including nested Form XObjects) before
 * rendering, which this does not do, so this cap alone does not bound a page with several large
 * images. */
export const OCR_MAX_IMAGE_PIXELS = 90_000_000;

/**
 * One recognised word, in the rasterised image's own pixel space (top-left origin, y growing down:
 * tesseract-wasm's own rect convention, kept here so the caller needs no translation before this).
 * @typedef {Object} OcrWord
 * @property {string} text
 * @property {number} x0
 * @property {number} y0
 * @property {number} x1
 * @property {number} y1
 */

/** Of the font size recovered from a word's characters, the share drawn: 0.8 of a full-height word's. */
const FONT_SIZE_FACTOR = 0.8;
/** Horizontal scaling (Tz, in percent) a word may be given to fill its box. */
const MIN_SQUEEZE = 25;
const MAX_SQUEEZE = 400;
const CAP_HEIGHT = 0.72;
const X_HEIGHT = 0.52;
const DESCENT = 0.21;
const TAIL = 0.12; // how far a comma or semicolon dips below the baseline
const TALL_LETTERS = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789bdfhijklt\u00C0\u00C1\u00C2\u00C3\u00C4\u00C5\u00C7\u00C8\u00C9\u00CA\u00CB\u00CC\u00CD\u00CE\u00CF\u00D1\u00D2\u00D3\u00D4\u00D5\u00D6\u00D8\u00D9\u00DA\u00DB\u00DC\u00DD\u00DF\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5\u00E8\u00E9\u00EA\u00EB\u00EC\u00ED\u00EE\u00EF\u00F2\u00F3\u00F4\u00F5\u00F6\u00F9\u00FA\u00FB\u00FC']);
const SHORT_LETTERS = new Set([...'acemnorsuvwxz\u00E6\u00F1\u00F8\u0153']);
const DESCENDERS = new Set([...'gjpqyQ\u00E7\u00FF']);
const REACHES_UP = new Set([...'()[]{}!?"\'&%$/|@#']);
const REACHES_DOWN = new Set([...'()[]{}/|$@_']);
const TAILS = new Set([...',;']);

/**
 * A recognised word's box is the extent of its ink, so its height follows the shapes of its characters, not
 * just the font size: a word of only short letters ("over") is about half as tall as one with an ascender and
 * a descender ("quick") in the very same font, and a trailing comma pulls the bottom of "Smith," below the
 * baseline. Read as sizes, those boxes make one printed line look like several, and readers start a new text
 * block at each change. The font size is recovered from the text instead: the box height divided by the
 * height these characters should have, and the baseline from the bottom of the box, raised by however far
 * the characters reach below it. Returns null for a word with no Latin letter or digit to go by (punctuation
 * on its own, other scripts), which falls back to the box itself.
 *
 * The extents, in fractions of the font size, are those of a typical sans-serif face; the estimate only has
 * to agree with itself from word to word, not match the printed font exactly.
 */
export function wordShape(text, boxHeight) {
  let evidence = false, tall = false, down = 0;
  for (const ch of text) {
    if (TALL_LETTERS.has(ch)) evidence = tall = true;
    else if (SHORT_LETTERS.has(ch)) evidence = true;
    else if (REACHES_UP.has(ch)) tall = true;
    if (DESCENDERS.has(ch)) { evidence = true; down = DESCENT; }
    else if (REACHES_DOWN.has(ch)) down = DESCENT;
    else if (TAILS.has(ch) && down < TAIL) down = TAIL;
  }
  if (!evidence) return null;
  const size = boxHeight / ((tall ? CAP_HEIGHT : X_HEIGHT) + down);
  return { size, descent: down * size };
}

/**
 * Groups word boxes into text lines WITHOUT reordering them, and gives each line one baseline. Tesseract
 * measures every word box on its own, so words on one printed line differ by a pixel or two in top and
 * bottom (an ascender or descender changes the box); drawn at those raw positions the invisible text has a
 * slightly different baseline per word, and readers that rebuild lines from baselines (poppler's pdftotext,
 * and copy-paste in some viewers) read the words back out of order. Pure.
 *
 * Tesseract's own order is kept (it already follows its layout analysis: a two-column page comes out column
 * by column), and a word joins the line before it only when it continues it: its middle is level with the
 * PREVIOUS word's (so a page that is a degree or two off level, whose lines drift slowly, still groups; the
 * drift never accumulates) and it starts to the right of where that word ends (so a jump back left, or to
 * another column, starts a new line).
 *
 * A line is flattened onto one baseline when its words' baselines lie within FLATTEN_LIMIT line heights of
 * each other, which covers any scan that is not badly skewed. A line that slopes more than that keeps
 * every word's own baseline, so the text layer still sits on the picture.
 *
 * @param {OcrWord[]} words
 * @returns {{ height: number, flat: boolean, words: { word: OcrWord, baseline: number }[] }[]} in the input's order;
 *   `flat` is false for a line left on its words' own baselines (and sizes)
 */
export function groupIntoLines(words) {
  // Where a word's baseline sits in its own box when its letters say nothing: about 68% of the box height
  // down (text size is 85% of the box height, and the baseline is 80% of that below the box's top).
  const BASELINE_FRACTION = 0.8 * 0.85;
  const items = words
    .filter((w) => (w.text || '').trim() && w.x1 > w.x0 && w.y1 > w.y0)
    .map((w) => {
      const h = w.y1 - w.y0;
      const shape = wordShape(w.text, h);
      return { word: w, h, mid: (w.y0 + w.y1) / 2, shape, base: shape ? w.y1 - shape.descent : w.y0 + h * BASELINE_FRACTION };
    });
  const runs = [];
  for (const item of items) {
    const run = runs[runs.length - 1];
    const prev = run && run[run.length - 1];
    const tolerance = prev && 0.5 * Math.min(item.h, prev.h);
    if (prev && Math.abs(item.mid - prev.mid) <= tolerance && item.word.x0 >= prev.word.x1 - tolerance) run.push(item);
    else runs.push([item]);
  }
  const lines = runs.map((run) => {
    const height = median(run.map((i) => i.h));
    // A punctuation mark or a word of another script has no shape to go by, so its baseline is a guess:
    // only words with a shape decide whether the line is level and where its baseline is.
    const shaped = run.filter((i) => i.shape);
    const bases = (shaped.length ? shaped : run).map((i) => i.base);
    const flat = Math.max(...bases) - Math.min(...bases) <= FLATTEN_LIMIT * height;
    const shared = median(bases);
    const sizes = shaped.map((i) => i.shape.size);
    return {
      height, flat, fontSize: sizes.length ? median(sizes) : null,
      words: run.map((i) => ({ word: i.word, baseline: flat ? shared : i.base, fontSize: i.shape ? i.shape.size : null })),
    };
  });
  shareSizes(lines);
  return lines;
}

/**
 * Lines of one printed size still estimate a little differently from line to line, and readers treat even a
 * small size change as the start of a new text block: poppler's pdftotext then reads a page as columns of
 * whole lines instead of line by line. So the flat lines whose font sizes lie within 15% of one another take
 * one common size, the median of that group. A clearly different size (a heading against body text) falls
 * outside the group and keeps its own, and a line left on its own baselines keeps its own sizes too.
 */
const SIZE_GROUP_RATIO = 1.15;
function shareSizes(lines) {
  const flat = lines.filter((l) => l.flat && l.fontSize != null).sort((a, b) => a.fontSize - b.fontSize);
  let group = [];
  const close = () => {
    if (!group.length) return;
    const common = median(group.map((l) => l.fontSize));
    for (const l of group) l.fontSize = common;
    group = [];
  };
  for (const line of flat) {
    if (group.length && line.fontSize > group[0].fontSize * SIZE_GROUP_RATIO) close();
    group.push(line);
  }
  close();
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Adds an invisible text layer to one page, positioned from OCR word boxes measured on a raster of
 * that SAME page at OCR_RASTER_DPI. The page's own content (whatever image or vector content it
 * already carries) is never touched: this only adds new, invisible text objects on top of it.
 *
 * Deliberately rasterised (by the caller) at page.rotate = 0, i.e. ignoring the page's own /Rotate
 * entry: that keeps the raster's pixel space mapped 1:1 onto the page's own raw MediaBox space, so
 * these coordinates need no un-rotation here: pdf-lib applies the SAME stored page rotation to the
 * existing content and this new text uniformly, since both live in one page object.
 * Rasterising WITH page.rotate applied would need this function to invert that rotation by hand, a
 * second place the same transform could drift from pdf.js's own.
 *
 * A page that was turned upright before it was read (bundletoolDeskew.js) passes `toRaw`, the map from the upright
 * image the words were found on back to the raster as scanned. Lines, sizes and spacing are all worked out on the
 * upright page, where the lines are level; only the drawing goes back through the map. A page read on its side or
 * upside down has its text turned by that quarter turn, so a selection follows the printed words and a reader sees a
 * line on its side as a line. The tilt is treated as FLATTEN_LIMIT treats a line on a page read as it is: a line
 * whose ends drift by no more than FLATTEN_LIMIT line heights is drawn level on one baseline, which readers need to
 * read lines in order; a line that slopes more is turned to run along its printed line, as Tesseract's own PDF
 * renderer turns each line's text to its baseline.
 *
 * @param {import('@cantoo/pdf-lib').PDFPage} page - the destination page, MediaBox in PDF points
 * @param {import('@cantoo/pdf-lib').PDFFont} font - a font already embedded on the document
 * @param {OcrWord[]} words - in the pixels of the image they were found on
 * @param {number} [dpi] - the DPI of the raster as scanned
 * @param {{toRaw?: number[]}} [opts] - the affine map from the image the words were found on to the raster as scanned
 *   (bundletoolDeskew.js's uprightGeometry); by default they were found on the raster itself
 */
export function embedOcrLayer(page, font, words, dpi = OCR_RASTER_DPI, { toRaw } = {}) {
  const { height: pageHeightPt } = page.getSize();
  // Lengths: raster pixels per pixel of the image the words were found on (1 unless it was scaled), then points.
  const stretch = toRaw ? Math.hypot(toRaw[0], toRaw[1]) : 1;
  const scale = (POINTS_PER_INCH / dpi) * stretch;
  const rawScale = POINTS_PER_INCH / dpi;
  const frames = lineFrames(toRaw);
  // Drawn in Tesseract's own order; the words of a line share that line's baseline (see groupIntoLines).
  for (const line of groupIntoLines(words)) {
    const { origins, turned } = frames.place(line, stretch);
    for (let i = 0; i < line.words.length; i++) {
      const { word: w, baseline, fontSize } = line.words[i];
      let text = (w.text || '').trim();
      if (!text) continue;
      let boxWidthPt = Math.max(0, (w.x1 - w.x0)) * scale;
      let boxHeightPt = Math.max(0, (w.y1 - w.y0)) * scale;
      if (boxWidthPt <= 0 || boxHeightPt <= 0) continue;
      // Size from the text's own characters (see wordShape), not from the box height: a masthead in 36pt and
      // a footnote in 6pt on the same page both get their own invisible text sized to roughly cover their own
      // box, while the words of one printed line, whose boxes differ with their letters, all get one size,
      // which readers need to see a line as one line. On a flat line a word within 25% of the line's size
      // takes the line's; a clearly different size is kept, and a line left on its own baselines keeps its
      // own sizes too. Where the letters say nothing (punctuation, other scripts) the box height decides.
      let size;
      if (fontSize != null) {
        const own = fontSize;
        size = (line.flat && line.fontSize != null && Math.abs(own - line.fontSize) <= 0.25 * line.fontSize ? line.fontSize : own) * scale * FONT_SIZE_FACTOR;
      } else {
        if (line.flat && Math.abs(w.y1 - w.y0 - line.height) <= 0.25 * line.height) boxHeightPt = line.height * scale;
        size = boxHeightPt * 0.85;
      }

      // A word followed by another on its line is drawn with a space after it, running to where the next one
      // starts, as Tesseract's own PDF output does. Without it the words are separate objects with the real
      // gap between them, and a reader takes a gap that lines up from one line to the next (all of them, in a
      // monospaced face) for a column break. A gap wider than a line's own height is a real break: no space.
      const next = line.words[i + 1]?.word;
      const gapPx = next ? next.x0 - w.x1 : -1;
      if (gapPx >= 0 && gapPx <= (line.fontSize ?? line.height)) {
        text += ' ';
        boxWidthPt = (next.x0 - w.x0) * scale;
      }

      // The word is stretched to its box's width with horizontal scaling (Tz), at the size chosen above. Drawn
      // at its natural width a word is usually narrower than the box it was found in, which leaves gaps between
      // words several times wider than the real ones. Squeezed below MIN_SQUEEZE a word would be unreadably
      // thin, so past that the size shrinks instead: a word is never drawn wider than its box. Stretched past
      // MAX_SQUEEZE it stays narrower than the box.
      const natural = font.widthOfTextAtSize(text, size);
      if (!(size > 0) || !(natural > 0)) continue;
      let squeeze = (100 * boxWidthPt) / natural;
      if (squeeze < MIN_SQUEEZE) {
        size *= squeeze / MIN_SQUEEZE;
        squeeze = MIN_SQUEEZE;
      }
      squeeze = Math.min(MAX_SQUEEZE, squeeze);
      if (!(size > 0)) continue;

      // The line's shared baseline, not this word's own box: a descender or ascender in one word must not
      // move that word off the line.
      const xPt = origins[i].x * rawScale;
      const yPt = pageHeightPt - origins[i].y * rawScale;

      // The squeeze is set inside its own graphics state, so it ends with this word and the next starts from 100%.
      // So is a turned word's rotation: the word is drawn at the origin of a coordinate system moved to its start
      // and turned to its line.
      page.pushOperators(pushGraphicsState(), setCharacterSqueeze(squeeze));
      if (turned) page.pushOperators(concatTransformationMatrix(turned.cos, turned.sin, -turned.sin, turned.cos, xPt, yPt));
      try {
        page.drawText(text, { x: turned ? 0 : xPt, y: turned ? 0 : yPt, size, font, renderMode: TextRenderingMode.Invisible });
      } catch {
        // A standard font substitutes rather than throws for a character outside WinAnsi, so this is
        // not expected to fire in practice; it is there so a malformed recognised word (or an embedded,
        // non-standard font that does throw) costs that one word, not the rest of the page.
      } finally {
        page.pushOperators(popGraphicsState());
      }
    }
  }
}

/** A rotation counter-clockwise by `angle` radians on the PDF page, as a cosine and sine rounded to six places (so a
 * quarter turn is written as whole numbers), or null for none. */
function rotationBy(angle) {
  const cos = Math.round(Math.cos(angle) * 1e6) / 1e6 || 0;
  const sin = Math.round(Math.sin(angle) * 1e6) / 1e6 || 0;
  return cos === 1 && sin === 0 ? null : { cos, sin };
}

/**
 * Where each line of words found on an upright image is drawn on the raster as scanned (see embedOcrLayer): each
 * word's starting point on the line's baseline, in raster pixels, and the rotation its text is drawn with.
 */
function lineFrames(toRaw) {
  const map = toRaw ? (x, y) => applyAffine(toRaw, x, y) : (x, y) => ({ x, y });
  // The direction a line of upright text runs on the page, counter-clockwise from the page's x axis (the raster's y
  // grows downwards, PDF's upwards), and the nearest quarter turn to it.
  const angle = toRaw ? Math.atan2(-toRaw[1], toRaw[0]) : 0;
  const quarter = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
  const along = rotationBy(angle);
  const level = rotationBy(quarter);
  // In raster pixels: along a line drawn level after the quarter turn, and across it.
  const ux = Math.cos(quarter), uy = -Math.sin(quarter);
  const nx = Math.sin(quarter), ny = Math.cos(quarter);
  return {
    place(line, stretch) {
      const origins = line.words.map(({ word, baseline }) => map(word.x0, baseline));
      if (!line.flat || angle === quarter) return { origins, turned: angle === quarter ? level : along };
      const across = origins.map((p) => p.x * nx + p.y * ny);
      if (Math.max(...across) - Math.min(...across) > FLATTEN_LIMIT * line.height * stretch) return { origins, turned: along };
      const shared = median(across);
      return {
        origins: origins.map((p) => { const t = p.x * ux + p.y * uy; return { x: t * ux + shared * nx, y: t * uy + shared * ny }; }),
        turned: level,
      };
    },
  };
}

/**
 * Draws a page's new text layer in place of the one it had: the page's existing invisible text (an earlier OCR layer,
 * BundleTool's or any other program's) is taken off first, as OCRmyPDF's redo mode does, so reading a page again
 * never leaves every word on it twice (bundletoolOcrRedo.js; its visible text is never touched). Called only with the
 * words of a page that was read, so a page whose new reading found nothing keeps the layer it had. Same arguments as
 * embedOcrLayer, and `straighten` for a page that is to be turned level (bundletoolOcrReorient.js's reorientPage): its
 * content is turned after the old layer is taken off (the turn is written in streams of pdf-lib's own, which that
 * step does not read) and before the new layer is drawn, which then goes level over the level page.
 *
 * @param {{toRaw?: number[], straighten?: {tilt: number, centre: {x: number, y: number}, toLevel: number[]}}} [opts]
 * @returns {number} how many showing operators of the existing invisible text were taken off
 */
export function replaceOcrLayer(page, font, words, dpi = OCR_RASTER_DPI, { toRaw, straighten } = {}) {
  const removed = removeInvisibleText(page);
  const level = Boolean(straighten) && straightenContent(page, straighten.tilt, straighten.centre);
  embedOcrLayer(page, font, words, dpi, { toRaw: level ? straighten.toLevel : toRaw });
  return removed;
}
