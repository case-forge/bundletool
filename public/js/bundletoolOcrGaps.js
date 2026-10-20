/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolOcrGaps.js
 * A second look at print the engine passed over. Pure: no DOM, no imports, so the browser and the command line find
 * the same places and keep the same words, and it is tested without a page.
 *
 * WHY. Tesseract's layout step decides what on a page is text before it reads anything, and on a busy page it sets
 * some print aside: the labels beside checkboxes on a form, and on a letter with a stamp and a photograph, whole lines
 * near them. On the benchmark corpus, with the resolution set, a second look at what is set aside finds 64 of the
 * missing words on the stamped letter's first page and the five checkbox labels on a form, and adds nothing on any
 * other page of text, on photographs, blank pages or scribbles.
 *
 * HOW. Mark the page's dark pixels, leave out long ruled lines and every word the first pass found, and gather what
 * is left into line-shaped regions. Each region, with a margin, is read on its own in Tesseract's sparse-text mode
 * (page segmentation mode 11, "find as much text as possible in no particular order"), and only words the engine is
 * sure of (confidence 0.9 or more, at least two letters or digits) that do not lie over a word already found are
 * kept. Regions the size of a photograph, specks and anything shorter or taller than a line of print are not read.
 *
 * All sizes are given at 200 dpi and scaled to the image's own resolution.
 */

export const GAPS = Object.freeze({
  /** Luminance under which a pixel is print. */
  INK: 140,
  /** A dark run at least this long (0.3 inch) across or down the page is a ruled line, not print. */
  RULE: 60,
  /** First-pass word boxes are grown by this much before they are left out. */
  GROW: 4,
  /** Regions are gathered on cells this size; a cell needs MIN_CELL_INK print pixels. */
  CELL: 4,
  MIN_CELL_INK: 2,
  /** Cells are joined into regions across gaps of this many cells along a line, and one cell between lines. */
  JOIN_ALONG: 3,
  /** A region must be a line's height: between these, in pixels. */
  MIN_HEIGHT: 16,
  MAX_HEIGHT: 200,
  /** A region needs this much print (pixels) and must cover less than this share of the page. */
  MIN_INK: 40,
  MAX_AREA: 0.05,
  /** Read at most this many regions a page, top first. */
  MAX_REGIONS: 30,
  /** Margin round each region, so the engine sees white about it. */
  MARGIN: 12,
  /** A word read in a region is kept only when the engine is at least this sure of it. */
  MIN_CONFIDENCE: 0.9,
  /** A word read in a region is dropped when this share of its box lies over a word already found. */
  MAX_OVERLAP: 0.2,
});

/**
 * The regions of print no first-pass word covers, as crop boxes in the image's pixels (margin included, clipped to
 * the image), top to bottom.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{x0: number, y0: number, x1: number, y1: number}[]} words - the first pass's words, in the same pixels
 * @param {number} [dpi]
 * @returns {{x0: number, y0: number, x1: number, y1: number}[]}
 */
export function uncoveredRegions(rgba, width, height, words, dpi = 200) {
  const s = dpi / 200;
  const W = width, H = height;
  const ink = new Uint8Array(W * H);
  for (let i = 0, o = 0; i < W * H; i++, o += 4) {
    if (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2] < GAPS.INK) ink[i] = 1;
  }
  // Ruled lines: runs of print at least RULE long, across and down.
  const rule = Math.max(8, Math.round(GAPS.RULE * s));
  const ruled = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let start = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && ink[y * W + x];
      if (on && start < 0) start = x;
      if (!on && start >= 0) { if (x - start >= rule) ruled.fill(1, y * W + start, y * W + x); start = -1; }
    }
  }
  for (let x = 0; x < W; x++) {
    let start = -1;
    for (let y = 0; y <= H; y++) {
      const on = y < H && ink[y * W + x];
      if (on && start < 0) start = y;
      if (!on && start >= 0) { if (y - start >= rule) for (let k = start; k < y; k++) ruled[k * W + x] = 1; start = -1; }
    }
  }
  // Everything the first pass found.
  const grow = Math.round(GAPS.GROW * s);
  for (const w of words) {
    const x0 = Math.max(0, Math.floor(w.x0) - grow), x1 = Math.min(W, Math.ceil(w.x1) + grow);
    for (let y = Math.max(0, Math.floor(w.y0) - grow); y < Math.min(H, Math.ceil(w.y1) + grow); y++) ink.fill(0, y * W + x0, y * W + x1);
  }
  // Print left over, counted on cells, joined along lines.
  const C = GAPS.CELL;
  const cw = Math.ceil(W / C), ch = Math.ceil(H / C);
  const cells = new Uint16Array(cw * ch);
  for (let y = 0; y < H; y++) {
    const row = ((y / C) | 0) * cw;
    for (let x = 0; x < W; x++) if (ink[y * W + x] && !ruled[y * W + x]) cells[row + ((x / C) | 0)]++;
  }
  const on = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (cells[y * cw + x] < GAPS.MIN_CELL_INK) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -GAPS.JOIN_ALONG; dx <= GAPS.JOIN_ALONG; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < ch && xx >= 0 && xx < cw) on[yy * cw + xx] = 1;
        }
      }
    }
  }
  const seen = new Uint8Array(cw * ch);
  const regions = [];
  const minH = GAPS.MIN_HEIGHT * s, maxH = GAPS.MAX_HEIGHT * s, minInk = GAPS.MIN_INK * s * s;
  for (let start = 0; start < cw * ch; start++) {
    if (!on[start] || seen[start]) continue;
    seen[start] = 1;
    const stack = [start];
    let x0 = cw, y0 = ch, x1 = 0, y1 = 0, inkN = 0;
    while (stack.length) {
      const j = stack.pop();
      const x = j % cw, y = (j / cw) | 0;
      inkN += cells[j];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [x > 0 ? j - 1 : -1, x < cw - 1 ? j + 1 : -1, j - cw, j + cw]) {
        if (k >= 0 && k < cw * ch && on[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    const box = { x0: x0 * C, y0: y0 * C, x1: Math.min(W, (x1 + 1) * C), y1: Math.min(H, (y1 + 1) * C) };
    const h = box.y1 - box.y0;
    if (inkN < minInk || h < minH || h > maxH || (box.x1 - box.x0) * h > GAPS.MAX_AREA * W * H) continue;
    regions.push(box);
  }
  regions.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const margin = Math.round(GAPS.MARGIN * s);
  return regions.slice(0, GAPS.MAX_REGIONS).map((r) => ({
    x0: Math.max(0, r.x0 - margin), y0: Math.max(0, r.y0 - margin), x1: Math.min(W, r.x1 + margin), y1: Math.min(H, r.y1 + margin),
  }));
}

/**
 * The words read in one region worth keeping, moved from the region's pixels into the page's.
 *
 * @param {{text: string, confidence?: number, x0: number, y0: number, x1: number, y1: number}[]} found - read in the region
 * @param {{x0: number, y0: number}} region - where the region starts on the page
 * @param {{x0: number, y0: number, x1: number, y1: number}[]} words - every word already kept for the page
 */
export function keepFound(found, region, words) {
  const kept = [];
  for (const f of found) {
    if (!((f.confidence ?? 0) >= GAPS.MIN_CONFIDENCE)) continue;
    if ((f.text.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) continue;
    const w = { ...f, x0: f.x0 + region.x0, x1: f.x1 + region.x0, y0: f.y0 + region.y0, y1: f.y1 + region.y0 };
    const area = (w.x1 - w.x0) * (w.y1 - w.y0);
    const over = words.some((o) => Math.max(0, Math.min(o.x1, w.x1) - Math.max(o.x0, w.x0)) * Math.max(0, Math.min(o.y1, w.y1) - Math.max(o.y0, w.y0)) > GAPS.MAX_OVERLAP * area);
    if (!over) kept.push(w);
  }
  return kept;
}
