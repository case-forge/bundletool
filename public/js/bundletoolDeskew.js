/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolDeskew.js
 * Turning a scanned page upright before it is read: a page that is tilted, lying on its side or upside down. Pure:
 * no DOM, no side effects and no imports but the pure bundletoolOcrGaps.js, so the browser and the command line make
 * exactly the same decisions with the same geometry, and it is tested without a page. Only moving the pixels differs
 * (a canvas in the browser, the pure functions at the end of this file on the command line).
 *
 * WHY. Tesseract's own quality guide names skew as a cause of "significantly reduced" line segmentation and
 * recommends rotating the page so the text lines are horizontal. On dense pages with exact ground truth, the engine
 * here does not degrade gradually; it collapses: a page tilted 1.4 degrees one way reads 20% of its characters, pages
 * tilted 20 to 40 degrees read almost nothing, and a page upside down or on its right side reads under 10%.
 *
 * HOW, in four steps, each taken only when it is safe.
 *  0. The page's own /Rotate: a page stored turned and shown upright by /Rotate is turned by it first (readUpright).
 *  1. Which way the lines run, from the pixels (estimateLayout). Shrink the page, weight every pixel by its darkness
 *     and try every direction across half a turn. At the right one the text lines line up with the pixel rows, so the
 *     row-by-row ink profile is at its sharpest (largest sum of squared differences between neighbouring rows). The
 *     best direction is found for lines across the page (rows) and for lines up and down it (columns); the axis is the
 *     one clearly sharper (three times), after setting aside an axis whose profile shows fewer than three lines: a
 *     long straight edge, such as a scanner's lid shadow down the side of a page, outscores the text on it but is one
 *     line, not thirty. When neither is clearly sharper (a ruled grid) the axis is unknown. The result counts only
 *     when the best direction stands out from the directions near it ("prominence"). Measured on synthetic scans,
 *     the benchmark corpus and real photographs: pages of text stand out by 19 or more (25 to 100 for most), a page
 *     of photograph, a blank page with specks and a scribble by 5 or less. Those are left alone.
 *  2. The tilt: the smaller turn, at most 45 degrees either way, that makes the lines exactly horizontal or exactly
 *     vertical. The page is turned into a larger canvas, so no corner is cut off.
 *  3. The quarter turn, from the engine (tesseract-wasm's getOrientation, which is Leptonica's up/down and left/right
 *     test on the levelled page; Leptonica asks for a deskewed page). The engine answers on any page, a blank page,
 *     a photograph and a ruled table included, and reports no usable confidence, so its answer is taken only when it
 *     agrees with the ink profile, which stands in for the confidence threshold OCRmyPDF applies to Tesseract's own
 *     orientation check: lines across the page can be upright or upside down (0 or 180), lines up and down it can
 *     only be on their side (90 or 270). The profile cannot tell 0 from 180 or 90 from 270; the engine can. A page
 *     whose axis is unknown is not turned.
 *
 * The words are found on the upright page and stay in its coordinates: the text layer goes back onto the page as it
 * was scanned through one affine map (toRaw), each word's text turned to run along its printed line, as Tesseract's
 * own PDF renderer turns each line's text to the line's baseline. Reading never changes the page itself; two optional
 * settings, off by default, then turn a sideways page upright or straighten a tilted one from what was measured here
 * (bundletoolOcrReorient.js).
 *
 * ANGLE CONVENTION. Every angle is the rotation to APPLY, in degrees, counter-clockwise as the page is seen (positive
 * turns the text anticlockwise). A page whose lines run downhill to the right needs a positive angle; a page lying
 * on its right side (text running bottom to top) needs 270.
 */

import { uncoveredRegions, keepFound } from './bundletoolOcrGaps.js';

export const DESKEW = Object.freeze({
  COARSE_STEP: 0.5,
  FINE_STEP: 0.05,
  /** Prominence compares the best direction with the directions within this many degrees of it. */
  WINDOW: 15,
  /** The best direction must score at least this many times the median of the directions near it (see step 1). */
  MIN_PROMINENCE: 10,
  /** Rows (or columns) are the lines' axis only when their best direction is this many times as sharp as the other
   * axis's: 10 or more measured on pages of text, about 3.4 on a form that is mostly a ruled table, 1 on a ruled grid
   * with no text and up to 2.2 on a photograph. */
  MIN_AXIS_RATIO: 3,
  /** An axis whose sharpest profile shows fewer lines than this is an edge, not text (see countLines). */
  MIN_LINES: 3,
  /** A peak of the profile counts as a line when it stands this far (a share of the highest peak) above the valleys
   * either side of it. */
  LINE_PEAK: 0.2,
  /** Share of the shrunken page that must be ink: below this there is nothing to measure (three lines of text on an
   * A4 page tilted 30 degrees are about 0.3%). */
  MIN_INK_FRACTION: 0.001,
  /** A tilt smaller than this is left alone; the engine reads it fine and a rotation only costs a little sharpness. */
  APPLY_MIN: 0.25,
  /** Target length, in pixels, of the longer side of the shrunken page. */
  TARGET_SIDE: 440,
});

/** Average `factor` x `factor` blocks of RGBA into luminance 0..255. */
function shrinkLuminance(rgba, width, height, factor) {
  const sw = Math.max(1, Math.floor(width / factor));
  const sh = Math.max(1, Math.floor(height / factor));
  const out = new Float32Array(sw * sh);
  const area = factor * factor;
  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        let i = ((sy * factor + dy) * width + sx * factor) * 4;
        for (let dx = 0; dx < factor; dx++, i += 4) sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      }
      out[sy * sw + sx] = sum / area;
    }
  }
  return { lum: out, sw, sh };
}

/** Darkness 0 (paper) .. 1 (black) of every pixel of the shrunken page, against the page's own paper tone. */
function darknessWeights(lum) {
  const hist = new Uint32Array(256);
  for (const v of lum) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  let seen = 0;
  let paper = 255;
  const target = lum.length * 0.9;
  for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen >= target) { paper = v; break; } }
  paper = Math.max(paper, 1);
  const w = new Float32Array(lum.length);
  for (let i = 0; i < lum.length; i++) w[i] = Math.max(0, Math.min(1, (paper - lum[i]) / paper));
  return w;
}

/** The row-by-row ink profile of the page once it is rotated by `angle` degrees (counter-clockwise). */
function profile(points, sw, sh, angle) {
  const a = (angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // y' = y cos a - x sin a (rows grow downwards); its range over the page is set by the page's corners.
  const lo = Math.min(0, -sw * sin, sh * cos, sh * cos - sw * sin);
  const hi = Math.max(0, -sw * sin, sh * cos, sh * cos - sw * sin);
  const shift = 1 - lo;
  const bins = Math.ceil(hi - lo) + 4;
  const hist = new Float64Array(bins);
  for (let k = 0; k < points.length; k += 3) {
    const yy = points[k + 1] * cos - points[k] * sin + shift;
    const i = Math.floor(yy);
    const f = yy - i;
    hist[i] += points[k + 2] * (1 - f);
    hist[i + 1] += points[k + 2] * f;
  }
  return hist;
}

/** How sharp the profile is at `angle`: the sum of squared differences between neighbouring rows. */
function sharpness(points, sw, sh, angle) {
  const hist = profile(points, sw, sh, angle);
  let s = 0;
  for (let i = 1; i < hist.length; i++) { const d = hist[i] - hist[i - 1]; s += d * d; }
  return s;
}

/**
 * How many lines a profile shows: peaks that stand out from the valleys either side of them by at least a fifth of
 * the highest peak. Lines of text give one peak each; a long straight edge (a scanner's lid shadow, a dark border, the
 * margin of a block of justified text seen side on) gives one or two, however sharp.
 */
function countLines(hist) {
  // A light smoothing, so one line's own unevenness is not counted as two lines.
  const h = hist.map((_, i) => ((hist[i - 1] ?? 0) + hist[i] + (hist[i + 1] ?? 0)) / 3);
  let top = 0;
  for (const v of h) top = Math.max(top, v);
  if (!(top > 0)) return 0;
  let count = 0;
  for (let i = 1; i < h.length - 1; i++) {
    if (!(h[i] > h[i - 1] && h[i] >= h[i + 1])) continue;
    // The lowest point on each side before the profile climbs higher than this peak.
    let left = h[i];
    for (let j = i - 1; j >= 0 && h[j] <= h[i]; j--) left = Math.min(left, h[j]);
    let right = h[i];
    for (let j = i + 1; j < h.length && h[j] <= h[i]; j++) right = Math.min(right, h[j]);
    if (h[i] - Math.max(left, right) >= DESKEW.LINE_PEAK * top) count++;
  }
  return count;
}

/** An angle brought into (-90, 90]: a direction and its opposite are the same line. */
function halfTurn(angle) {
  let a = angle % 180;
  if (a <= -90) a += 180;
  if (a > 90) a -= 180;
  return a;
}

/** A quarter turn brought to one of 0, 90, 180, 270. */
function quarter(turn) {
  return ((((Math.round(turn / 90) * 90) % 360) + 360) % 360);
}

function median(values) {
  const v = [...values].sort((p, q) => p - q);
  return v[v.length >> 1];
}

/**
 * Finds which way a page's lines run, from its pixels alone.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - RGBA pixels, row by row
 * @param {number} width
 * @param {number} height
 * @param {{factor?: number}} [opts] - shrink factor; by default the longer side is shrunk to about DESKEW.TARGET_SIDE
 * @returns {{angle: number, tilt: number, axis: 'rows'|'columns'|null, prominence: number, axisRatio: number,
 *   inkFraction: number, confident: boolean}}
 *   angle: the rotation that makes the lines horizontal, in (-90, 90]. tilt: the smaller rotation, within 45 degrees
 *   either way, that makes them horizontal or vertical, whichever is nearer. axis: which of the two they then are, or
 *   null when rows and columns score too nearly alike to say. confident: the direction stands out; when it is false
 *   nothing about the page is changed.
 */
export function estimateLayout(rgba, width, height, { factor } = {}) {
  const f = factor ?? Math.max(1, Math.round(Math.max(width, height) / DESKEW.TARGET_SIDE));
  const { lum, sw, sh } = shrinkLuminance(rgba, width, height, f);
  const w = darknessWeights(lum);
  // Only the inked pixels matter; keep them as flat (x, y, weight) triples so each angle is one pass over a short list.
  // Each pixel stands at a fixed random point inside its own square, not at its corner: projected at an angle such as
  // 45 degrees, a regular grid of points falls into the profile's bins unevenly, and that unevenness alone would score
  // a photograph's dark areas as sharply as lines of text.
  const triples = [];
  let ink = 0;
  let seed = 12345;
  const jitter = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = w[y * sw + x];
      ink += v;
      if (v > 0.02) triples.push(x + jitter(), y + jitter(), v);
    }
  }
  const points = Float64Array.from(triples);
  const inkFraction = ink / (sw * sh);
  const none = { angle: 0, tilt: 0, axis: null, prominence: 0, axisRatio: 1, inkFraction, confident: false };
  if (points.length < 30 || inkFraction < DESKEW.MIN_INK_FRACTION) return none;

  // Every direction across half a turn, -90 up to (not including) +90; the scores wrap round at the ends. The best
  // direction is found for each axis: within 45 degrees of horizontal (rows) and of vertical (columns).
  const n = Math.round(180 / DESKEW.COARSE_STEP);
  const scores = new Float64Array(n);
  let kRows = -1;
  let kColumns = -1;
  for (let k = 0; k < n; k++) {
    scores[k] = sharpness(points, sw, sh, -90 + k * DESKEW.COARSE_STEP);
    if (Math.abs(-90 + k * DESKEW.COARSE_STEP) <= 45) { if (kRows < 0 || scores[k] > scores[kRows]) kRows = k; }
    else if (kColumns < 0 || scores[k] > scores[kColumns]) kColumns = k;
  }
  const fine = (k) => {
    const coarse = -90 + k * DESKEW.COARSE_STEP;
    let best = coarse;
    let bestScore = -1;
    for (let a = coarse - DESKEW.COARSE_STEP; a <= coarse + DESKEW.COARSE_STEP + 1e-9; a += DESKEW.FINE_STEP) {
      const sc = sharpness(points, sw, sh, a);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    return { k, angle: halfTurn(best), score: scores[k], lines: countLines(profile(points, sw, sh, best)) };
  };
  const across = fine(kRows);
  const down = fine(kColumns);
  // Which way the lines run: the axis whose best direction is clearly sharper. An axis whose sharpest profile shows
  // fewer than MIN_LINES lines is an edge, not lines of text (a lid shadow down the side of a scan outscores the
  // text on it), and is set aside. When neither axis is clearly sharper (a ruled grid, a photograph), or neither shows
  // lines, the axis is unknown and the tilt is taken across the page.
  const lined = [across, down].filter((x) => x.lines >= DESKEW.MIN_LINES);
  let axis = null;
  let axisRatio = 1;
  if (lined.length === 2) {
    axisRatio = Math.max(across.score, down.score) / Math.max(Math.min(across.score, down.score), 1e-9);
    if (axisRatio >= DESKEW.MIN_AXIS_RATIO) axis = across.score > down.score ? 'rows' : 'columns';
  } else if (lined.length === 1) {
    axis = lined[0] === across ? 'rows' : 'columns';
    axisRatio = Infinity;
  }
  const chosen = axis === 'columns' ? down : across;

  const span = Math.round(DESKEW.WINDOW / DESKEW.COARSE_STEP);
  const near = [];
  for (let j = -span; j <= span; j++) near.push(scores[(chosen.k + j + n) % n]);
  const prominence = scores[chosen.k] / Math.max(median(near), 1e-9);
  const angle = Math.round(chosen.angle * 100) / 100;
  const tilt = Math.round((Math.abs(angle) <= 45 ? angle : angle - 90 * Math.sign(angle)) * 100) / 100;
  return {
    angle, tilt, axis, prominence, axisRatio, lines: [across.lines, down.lines], inkFraction,
    confident: prominence >= DESKEW.MIN_PROMINENCE,
  };
}

/** True when an estimate is trustworthy and the tilt big enough to be worth correcting. */
export function shouldStraighten(estimate) {
  return Boolean(estimate?.confident) && Math.abs(estimate.tilt) >= DESKEW.APPLY_MIN;
}

/**
 * When a page looks blank (pageInk). Measured on pages drawn as the document window draws them (pdf.js, fitted
 * inside the window, at one and two device pixels to the CSS pixel): the 40 pages of the OCR benchmark corpus,
 * faded fax included, hold 1.12% ink or more; blank scans with grain, 400 specks, a recycled paper tone, a lid
 * shadow, punch holes or show-through from the back, and a page with only a page number, hold 0.012% or less; a page
 * with one short line ("This page is intentionally left blank", "EXHIBIT JS1", a three-line address) holds 0.10% to
 * 0.13%. The limit sits between the blank pages and the one-line pages.
 */
export const BLANK = Object.freeze({
  /** Share of each side left out: scanner lid edges, their shadows, punch holes and page numbers fall there. */
  MARGIN: 0.08,
  /** A shrunken pixel is ink from this darkness (0 paper .. 1 black). Faded fax text is about 0.25 before the page
   * is shrunk to the window, so the floor sits well under it; paper grain and most show-through are fainter. */
  MIN_DARKNESS: 0.1,
  /** Below this share of ink the page looks blank. */
  MAX_INK: 0.0004,
});

/**
 * How much of a page is ink, for saying a page looks blank: estimateLayout's measure (the page shrunk, every pixel
 * weighed by its darkness against the page's own paper tone) with a blank scan's leftovers set aside. A pixel lighter
 * than BLANK.MIN_DARKNESS is paper, an inked pixel with no inked neighbour is a speck, and the outer BLANK.MARGIN of
 * each side is not looked at.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - RGBA pixels, row by row
 * @returns {{inkFraction: number, blank: boolean}}
 */
export function pageInk(rgba, width, height, { factor, margin = BLANK.MARGIN, minDarkness = BLANK.MIN_DARKNESS } = {}) {
  const f = factor ?? Math.max(1, Math.round(Math.max(width, height) / DESKEW.TARGET_SIDE));
  const { lum, sw, sh } = shrinkLuminance(rgba, width, height, f);
  const w = darknessWeights(lum);
  const x0 = Math.floor(sw * margin);
  const y0 = Math.floor(sh * margin);
  const x1 = sw - x0;
  const y1 = sh - y0;
  const inked = (x, y) => w[y * sw + x] >= minDarkness;
  let ink = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!inked(x, y)) continue;
      let neighbour = false;
      for (let dy = -1; dy <= 1 && !neighbour; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < sw && ny < sh && inked(nx, ny)) { neighbour = true; break; }
        }
      }
      if (neighbour) ink += w[y * sw + x];
    }
  }
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  const inkFraction = ink / area;
  return { inkFraction, blank: inkFraction < BLANK.MAX_INK };
}

/**
 * The quarter turn to apply to a levelled page, given its ink profile and the engine's orientation answer for it
 * ({rotation}: counter-clockwise, as tesseract-wasm's getOrientation reports it). 0 unless the two agree: lines across
 * the page can only be upright or upside down, lines up and down it can only be on their side, and a page whose axis
 * is unknown is never turned.
 *
 * @returns {0|90|180|270}
 */
export function acceptedTurn(estimate, orientation) {
  if (!estimate?.confident || !estimate.axis || !Number.isFinite(orientation?.rotation)) return 0;
  const r = quarter(orientation.rotation);
  if (estimate.axis === 'rows') return r === 180 ? 180 : 0;
  return r === 90 || r === 270 ? r : 0;
}

/** The affine map that applies `inner`, then `outer` (both [a, b, c, d, e, f]). */
function compose(outer, inner) {
  const [a, b, c, d, e, f] = outer;
  const [p, q, r, s, t, u] = inner;
  return [a * p + c * q, b * p + d * q, a * r + c * s, b * r + d * s, a * t + c * u + e, b * t + d * u + f];
}

/** A point carried by an affine map [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export function applyAffine(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** The map from a `width` x `height` image turned by a quarter `turn` (counter-clockwise) back to the image itself. */
function unturnMap(turn, width, height) {
  return {
    0: [1, 0, 0, 1, 0, 0],
    90: [0, 1, -1, 0, width, 0],       // (X, Y) -> (W - Y, X)
    180: [-1, 0, 0, -1, width, height], // (X, Y) -> (W - X, H - Y)
    270: [0, -1, 1, 0, 0, height],     // (X, Y) -> (Y, H - X)
  }[quarter(turn)];
}

/** The quarter turn, counter-clockwise, that shows a page's raster the way the page is displayed: a PDF page's
 * /Rotate turns it clockwise. */
export function displayTurn(rotate) {
  return quarter(360 - quarter(rotate || 0));
}

/**
 * Where everything goes when a `width` x `height` raster is first given the page's own quarter turn (`pageTurn`,
 * counter-clockwise: displayTurn of its /Rotate, so the raster is the right way up as the page is displayed), then
 * rotated by `tilt` degrees into a canvas that holds all of it, then given a further quarter `turn` (both
 * counter-clockwise). When that canvas would hold more than `maxPixels` pixels (and more than the raster itself), it is
 * scaled down to fit; a page that is not tilted is never scaled.
 *
 * @returns {{tiltWidth: number, tiltHeight: number, scale: number, width: number, height: number, toRaw: number[],
 *   toLevel: number[]}}
 *   tiltWidth/tiltHeight: the tilted canvas, before the further quarter turn; scale: its pixels per raster pixel;
 *   width/height: the upright image; toRaw: the affine map [a, b, c, d, e, f] (see applyAffine) from a point of the
 *   upright image to the same point of the raster as scanned, in pixels, origin top left. toLevel: the same, to the
 *   raster once the page itself has been turned by `tilt` about its centre (straightened, bundletoolOcrReorient.js):
 *   no rotation is left in it but quarter turns, and it equals toRaw when there is no tilt.
 */
export function uprightGeometry(width, height, tilt = 0, turn = 0, maxPixels = Infinity, pageTurn = 0) {
  const shown = quarter(pageTurn);
  const DW = shown === 90 || shown === 270 ? height : width;
  const DH = shown === 90 || shown === 270 ? width : height;
  const t = (tilt * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const fullW = DW * Math.abs(cos) + DH * Math.abs(sin);
  const fullH = DW * Math.abs(sin) + DH * Math.abs(cos);
  const room = Math.max(maxPixels, width * height);
  const scale = tilt && fullW * fullH > room ? Math.sqrt(room / (fullW * fullH)) : 1;
  const W1 = tilt ? Math.max(1, Math.round(fullW * scale)) : DW;
  const H1 = tilt ? Math.max(1, Math.round(fullH * scale)) : DH;
  const q = quarter(turn);

  // Tilted canvas -> the raster as displayed: the scale and the rotation undone, centre onto centre.
  const k = 1 / scale;
  const a = k * cos;
  const b = k * sin;
  const untilt = [a, b, -b, a, DW / 2 - (a * W1 / 2 - b * H1 / 2), DH / 2 - (b * W1 / 2 + a * H1 / 2)];
  // Tilted canvas -> the raster as displayed once it is itself turned by the tilt about its centre: untilt followed by
  // that turn, which cancels untilt's rotation and leaves its scale, centre onto centre. Written out rather than
  // composed, so a straightened page's text layer carries no rounding error in its angle.
  const level = tilt ? [k, 0, 0, k, DW / 2 - k * W1 / 2, DH / 2 - k * H1 / 2] : untilt;
  const sideways = q === 90 || q === 270;
  return {
    tiltWidth: W1, tiltHeight: H1, scale,
    width: sideways ? H1 : W1,
    height: sideways ? W1 : H1,
    // Upright image -> tilted canvas -> raster as displayed -> raster as scanned.
    toRaw: compose(unturnMap(shown, width, height), compose(untilt, unturnMap(q, W1, H1))),
    toLevel: compose(unturnMap(shown, width, height), compose(level, unturnMap(q, W1, H1))),
  };
}

/**
 * Rotates a page raster by `angle` degrees counter-clockwise about its centre, bilinear, the uncovered corners filled
 * opaque white. By default the result is the same size as the input; pass the tilted canvas's size and scale from
 * uprightGeometry to keep the whole page. The input is not touched.
 *
 * @param {{width?: number, height?: number, scale?: number}} [into]
 * @returns {Uint8ClampedArray}
 */
export function straightenRgba(rgba, width, height, angle, { width: outW = width, height: outH = height, scale = 1 } = {}) {
  const a = (angle * Math.PI) / 180;
  const cos = Math.cos(a) / scale;
  const sin = Math.sin(a) / scale;
  const cx = width / 2;
  const cy = height / 2;
  const ox = outW / 2;
  const oy = outH / 2;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const dy = y + 0.5 - oy;
    for (let x = 0; x < outW; x++) {
      const dx = x + 0.5 - ox;
      // The output pixel takes its value from where the inverse rotation puts its centre in the input.
      const sx = dx * cos - dy * sin + cx - 0.5;
      const sy = dx * sin + dy * cos + cy - 0.5;
      const o = (y * outW + x) * 4;
      if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * width + x0) * 4;
      const i10 = (y0 * width + x1) * 4;
      const i01 = (y1 * width + x0) * 4;
      const i11 = (y1 * width + x1) * 4;
      for (let c = 0; c < 4; c++) {
        out[o + c] = (rgba[i00 + c] * (1 - fx) + rgba[i10 + c] * fx) * (1 - fy)
          + (rgba[i01 + c] * (1 - fx) + rgba[i11 + c] * fx) * fy;
      }
    }
  }
  return out;
}

/**
 * Turns a raster by a quarter turn counter-clockwise (90, 180 or 270), moving whole pixels, so nothing is resampled.
 * The input is not touched.
 *
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
export function turnRgba(rgba, width, height, turn) {
  const q = quarter(turn);
  const sideways = q === 90 || q === 270;
  const outW = sideways ? height : width;
  const outH = sideways ? width : height;
  const src = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const dst = new Uint32Array(outW * outH);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let i;
      if (q === 90) i = (width - 1 - x) * outW + y;                       // (x, y) -> (y, W - 1 - x)
      else if (q === 180) i = (height - 1 - y) * outW + (width - 1 - x);  // (x, y) -> (W - 1 - x, H - 1 - y)
      else if (q === 270) i = x * outW + (height - 1 - y);                // (x, y) -> (H - 1 - y, x)
      else i = y * outW + x;
      dst[i] = src[y * width + x];
    }
  }
  return { data: new Uint8ClampedArray(dst.buffer), width: outW, height: outH };
}

/**
 * Reads one page upright: gives it the page's own quarter turn, measures it, levels it, asks the engine which way up
 * it is when the profile allows a further quarter turn, and reads it. The one sequence both the browser and the
 * command line run; they differ only in how pixels are moved (`io`).
 *
 * The page's own /Rotate comes first because it is certain and costs nothing: a scanner or a phone app that stores a
 * page turned and sets /Rotate to show it upright leaves the raster (read, like the text layer, in the page's own
 * unrotated space) on its side or upside down. What the pixels say then corrects only what /Rotate does not.
 *
 * @param {any} raster - the page as scanned, in whatever form `io` and the engine take
 * @param {{width: number, height: number, dpi?: number}} size - the raster's size, and its resolution
 * @param {{load: (image: any, opts?: {dpi?: number}) => Promise<void>, orientation: () => Promise<{rotation: number}>,
 *   words: () => Promise<import('./bundletoolOcr.js').OcrWord[]>}} session - the engine, one page at a time
 * @param {{sample: (image: any) => Promise<{data: Uint8ClampedArray|Uint8Array, width: number, height: number, factor?: number}>,
 *   tilt: (image: any, angle: number, geometry: ReturnType<typeof uprightGeometry>) => Promise<any>,
 *   turn: (image: any, turn: number, size: {width: number, height: number}) => Promise<any>,
 *   pixels?: (image: any) => Promise<{data: Uint8ClampedArray|Uint8Array, width: number, height: number}>,
 *   crop?: (image: any, box: {x0: number, y0: number, x1: number, y1: number}) => Promise<any>}} io - the pixels of an
 *   image to measure, the two rotations, into the sizes given, and (for the second look at print the engine passed
 *   over) an image's full pixels and a region of it
 * @param {{maxPixels?: number, pageTurn?: number}} [opts] - the largest tilted canvas, in pixels (see uprightGeometry);
 *   the page's own quarter turn (displayTurn of its /Rotate)
 * @returns {Promise<{words: import('./bundletoolOcr.js').OcrWord[], toRaw: number[], toLevel: number[], tilt: number,
 *   turn: number, accepted: 0|90|180|270}>}
 *   words in the upright image's pixels; toRaw maps them back onto the raster as scanned, toLevel onto the raster of
 *   the page straightened (see uprightGeometry). tilt: the tilt applied (0 when none was worth applying). turn: the whole
 *   quarter turn the page was read at, its own /Rotate included. accepted: only the further quarter turn the engine
 *   and the ink profile agreed on, beyond the page's own /Rotate (counter-clockwise).
 */
export async function readUpright(raster, size, session, io, { maxPixels = Infinity, pageTurn = 0 } = {}) {
  const shown = quarter(pageTurn);
  const turnSize = (q, w, h) => (q === 90 || q === 270 ? { width: h, height: w } : { width: w, height: h });
  const displayed = shown ? await io.turn(raster, shown, turnSize(shown, size.width, size.height)) : raster;
  const sample = await io.sample(displayed);
  const estimate = estimateLayout(sample.data, sample.width, sample.height, { factor: sample.factor });
  const tilt = shouldStraighten(estimate) ? estimate.tilt : 0;
  let geometry = uprightGeometry(size.width, size.height, tilt, 0, maxPixels, shown);
  // The engine is told each image's resolution: the raster's, times the tilted canvas's scale.
  const dpi = (scale) => (size.dpi ? { dpi: size.dpi * scale } : {});
  let image = tilt ? await io.tilt(displayed, tilt, geometry) : displayed;
  await session.load(image, dpi(geometry.scale));
  const turn = estimate.confident && estimate.axis ? acceptedTurn(estimate, await session.orientation()) : 0;
  if (turn) {
    geometry = uprightGeometry(size.width, size.height, tilt, turn, maxPixels, shown);
    image = await io.turn(image, turn, { width: geometry.width, height: geometry.height });
    await session.load(image, dpi(geometry.scale));
  }
  let words = await session.words();
  // A second look at print the engine passed over (bundletoolOcrGaps.js), on the same upright image.
  if (io.pixels && io.crop) {
    const pixels = await io.pixels(image);
    const regions = uncoveredRegions(pixels.data, pixels.width, pixels.height, words, (size.dpi ?? 200) * geometry.scale);
    for (const region of regions) {
      await session.load(await io.crop(image, region), { ...dpi(geometry.scale), sparse: true });
      words = words.concat(keepFound(await session.words(), region, words));
    }
  }
  return { words, toRaw: geometry.toRaw, toLevel: geometry.toLevel, tilt, turn: quarter(shown + turn), accepted: turn };
}
