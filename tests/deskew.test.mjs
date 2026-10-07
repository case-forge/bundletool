/**
 * Turning a scanned page upright before it is read (bundletoolDeskew.js): the lines' direction from the ink profile,
 * the tilt, the quarter turn the engine is allowed to make, and the geometry that takes the words back to the page.
 *
 * The pages here are built from plain geometry, not by the module's own rotation, so the tests do not agree with the
 * module by construction: a page whose lines run downhill to the right by `tilt` degrees needs a POSITIVE angle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKEW, estimateLayout, shouldStraighten, acceptedTurn, uprightGeometry, applyAffine, straightenRgba, turnRgba,
  readUpright, displayTurn,
} from '../public/js/bundletoolDeskew.js';

const W = 1240;
const H = 1754; // A4 at 150 dpi

function rng(seed) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

function blankPage(fill = 255, w = W, h = H) {
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  if (fill !== 255) for (let i = 0; i < rgba.length; i += 4) rgba[i] = rgba[i + 1] = rgba[i + 2] = fill;
  return rgba;
}

function paint(rgba, x, y, v = 30, w = W, h = H) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const o = (y * w + x) * 4;
  rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
}

/**
 * Lines of word-like dark bars, 36px apart, drawn about the middle of the page so a large tilt keeps them on it. Each
 * line runs `tilt` degrees downhill to the right (clockwise as seen); `sideways` turns the whole block a quarter turn
 * clockwise, so the lines run down the page.
 */
function textPage(tilt, { lines = 30, seed = 3, sideways = false } = {}) {
  const rgba = blankPage();
  const a = (tilt * Math.PI) / 180;
  const next = rng(seed);
  const cx = W / 2, cy = H / 2;
  for (let i = 0; i < lines; i++) {
    let u = -420;
    const v = (i - lines / 2) * 36;
    while (u < 420) {
      const len = 40 + Math.floor(next() * 70);
      for (let uu = u; uu < Math.min(u + len, 420); uu++) {
        for (let dv = -6; dv <= 6; dv++) {
          // (uu, v + dv) on the level page, turned clockwise by `tilt` about the centre.
          let x = cx + uu * Math.cos(a) - (v + dv) * Math.sin(a);
          let y = cy + uu * Math.sin(a) + (v + dv) * Math.cos(a);
          if (sideways) [x, y] = [cx - (y - cy), cy + (x - cx)];
          paint(rgba, Math.round(x), Math.round(y));
        }
      }
      u += len + 14;
    }
  }
  return rgba;
}

// ── which way the lines run ─────────────────────────────────────────────────────────────────────────────────────────

test('the tilt of a page of text is found, either way, from under a degree to 44 degrees', () => {
  for (const tilt of [-44, -40, -30, -20, -14, -7, -2, -1.4, -0.9, 0.9, 1.4, 2, 5, 9.5, 12, 20, 30, 40, 44]) {
    const e = estimateLayout(textPage(tilt), W, H);
    assert.ok(e.confident, `tilt ${tilt}: confident (prominence ${e.prominence.toFixed(1)})`);
    assert.equal(e.axis, 'rows', `tilt ${tilt}: lines across`);
    assert.ok(Math.abs(e.tilt - tilt) <= 0.15, `tilt ${tilt}: estimated ${e.tilt}`);
    assert.ok(shouldStraighten(e), `tilt ${tilt}: worth straightening`);
  }
});

test('a page on its side reads as lines up and down the page, with its own small tilt', () => {
  for (const tilt of [0, 3, -6]) {
    const e = estimateLayout(textPage(tilt, { sideways: true }), W, H);
    assert.ok(e.confident);
    assert.equal(e.axis, 'columns', `tilt ${tilt}`);
    assert.ok(Math.abs(e.tilt - tilt) <= 0.15, `tilt ${tilt}: estimated ${e.tilt}`);
  }
});

test('a dark band down the side of a scan (a lid shadow) does not outscore the text on the page', () => {
  for (const tilt of [0, 1.2, -0.8]) {
    const page = textPage(tilt);
    // A shadow 30px wide along the right edge, darkening to black at the edge, the full height of the scan.
    for (let y = 0; y < H; y++) for (let x = W - 30; x < W; x++) paint(page, x, y, Math.round(200 - (x - (W - 30)) * 6.5));
    const e = estimateLayout(page, W, H);
    assert.equal(e.axis, 'rows', `tilt ${tilt}: lines ${e.lines}`);
    assert.ok(Math.abs(e.tilt - tilt) <= 0.15, `tilt ${tilt}: estimated ${e.tilt}`);
    assert.equal(acceptedTurn(e, { rotation: 90 }), 0, 'and it is never given a quarter turn');
  }
});

test('a level page is left alone', () => {
  const e = estimateLayout(textPage(0), W, H);
  assert.equal(e.axis, 'rows');
  assert.ok(Math.abs(e.tilt) < DESKEW.APPLY_MIN);
  assert.equal(shouldStraighten(e), false);
  // Just under the threshold: found, but not worth a rotation.
  assert.equal(shouldStraighten(estimateLayout(textPage(0.15), W, H)), false);
});

test('a page with a few lines of text, tilted a long way, is still measured', () => {
  for (const tilt of [-2, 30]) {
    const e = estimateLayout(textPage(tilt, { lines: 3 }), W, H);
    assert.ok(e.confident, `tilt ${tilt}: prominence ${e.prominence.toFixed(1)}`);
    assert.ok(Math.abs(e.tilt - tilt) <= 0.2, `tilt ${tilt}: estimated ${e.tilt}`);
  }
});

test('pages with nothing to level are not touched: blank with specks, photograph, scribble', () => {
  const noise = rng(9);
  const blank = blankPage();
  for (let n = 0; n < W * H / 60; n++) paint(blank, Math.floor(noise() * W), Math.floor(noise() * H), 255 - Math.floor(noise() * 60));
  // A photograph: smooth light and dark areas with grain, no lines.
  const photo = blankPage();
  const blobs = Array.from({ length: 40 }, () => [noise() * W, noise() * H, 60 + noise() * 160, noise() > 0.5 ? 1 : -1]);
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      let v = 150;
      for (const [bx, by, r, sign] of blobs) v += sign * 90 * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (r * r));
      const grey = Math.max(0, Math.min(255, Math.round(v + (noise() - 0.5) * 30)));
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) paint(photo, x + dx, y + dy, grey);
    }
  }
  const scribble = blankPage();
  let x = 600, y = 800;
  for (let n = 0; n < 4000; n++) {
    x += Math.round((noise() - 0.5) * 6);
    y += Math.round((noise() - 0.5) * 6);
    for (let d = -2; d <= 2; d++) { paint(scribble, x + d, y); paint(scribble, x, y + d); }
  }
  for (const [name, page] of [['blank', blank], ['photograph', photo], ['scribble', scribble]]) {
    const e = estimateLayout(page, W, H);
    assert.equal(e.confident, false, `${name}: prominence ${e.prominence.toFixed(1)}, angle ${e.angle}`);
    assert.equal(shouldStraighten(e), false, name);
    assert.equal(acceptedTurn(e, { rotation: 180 }), 0, `${name} is never turned`);
  }
});

test('a ruled grid is levelled but never given a quarter turn: its rows and columns are alike', () => {
  for (const tilt of [0, 3]) {
    const page = blankPage();
    const a = (tilt * Math.PI) / 180;
    const put = (u, v) => paint(page, Math.round(W / 2 + u * Math.cos(a) - v * Math.sin(a)), Math.round(H / 2 + u * Math.sin(a) + v * Math.cos(a)));
    for (let v = -600; v <= 600; v += 60) for (let u = -400; u <= 400; u++) for (let d = 0; d < 3; d++) put(u, v + d);
    for (let u = -400; u <= 400; u += 200) for (let v = -600; v <= 600; v++) for (let d = 0; d < 3; d++) put(u + d, v);
    const e = estimateLayout(page, W, H);
    assert.equal(e.axis, null, `tilt ${tilt}: ratio ${e.axisRatio.toFixed(2)}`);
    assert.ok(Math.abs(e.tilt - tilt) <= 0.2, `tilt ${tilt}: estimated ${e.tilt}`);
    for (const rotation of [90, 180, 270]) assert.equal(acceptedTurn(e, { rotation }), 0);
  }
});

// ── the quarter turn ────────────────────────────────────────────────────────────────────────────────────────────────

test('the engine\'s quarter turn is taken only when the ink profile agrees with it', () => {
  const rows = { confident: true, axis: 'rows' };
  const columns = { confident: true, axis: 'columns' };
  const expect = [
    [rows, 0, 0], [rows, 180, 180], [rows, 90, 0], [rows, 270, 0],
    [columns, 90, 90], [columns, 270, 270], [columns, 0, 0], [columns, 180, 0],
    [{ confident: true, axis: null }, 180, 0], [{ confident: false, axis: 'rows' }, 180, 0],
    [rows, -180, 180], [columns, -90, 270], [columns, 450, 90],
  ];
  for (const [estimate, rotation, turn] of expect) {
    assert.equal(acceptedTurn(estimate, { rotation, confidence: 1 }), turn, `${estimate.axis} ${rotation}`);
  }
  assert.equal(acceptedTurn(rows, undefined), 0);
  assert.equal(acceptedTurn(rows, { rotation: NaN }), 0);
});

// ── geometry ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('an untouched page maps onto itself; a quarter turn swaps the sides; a tilt makes room for the corners', () => {
  const g0 = uprightGeometry(800, 1200);
  assert.deepEqual([g0.width, g0.height, g0.scale], [800, 1200, 1]);
  const p = applyAffine(g0.toRaw, 123, 456);
  assert.ok(Math.abs(p.x - 123) < 1e-9 && Math.abs(p.y - 456) < 1e-9);
  for (const turn of [90, 270]) {
    const g = uprightGeometry(800, 1200, 0, turn);
    assert.deepEqual([g.width, g.height], [1200, 800], `turn ${turn}`);
  }
  const g30 = uprightGeometry(800, 1200, 30);
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  assert.equal(g30.tiltWidth, Math.round(800 * c + 1200 * s));
  assert.equal(g30.tiltHeight, Math.round(800 * s + 1200 * c));
});

test('a tilted canvas over the pixel limit is scaled to fit; a page that is not tilted never is', () => {
  const g = uprightGeometry(4000, 5000, 40, 0, 25e6);
  assert.ok(g.scale < 1);
  assert.ok(g.tiltWidth * g.tiltHeight <= 25e6 * 1.001, `${g.tiltWidth} x ${g.tiltHeight}`);
  const big = uprightGeometry(6000, 6000, 0, 90, 25e6);
  assert.equal(big.scale, 1);
  assert.deepEqual([big.width, big.height], [6000, 6000]);
  // A raster already over the limit is never made smaller by a tilt than it was.
  const over = uprightGeometry(6000, 6000, 2, 0, 25e6);
  assert.ok(over.tiltWidth * over.tiltHeight >= 6000 * 6000 * 0.999);
});

/** Centre of the dark pixels of an image, and how many there are. */
function inkCentre(rgba, w, h) {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rgba[(y * w + x) * 4] < 128) { sx += x + 0.5; sy += y + 0.5; n++; }
  return { x: sx / n, y: sy / n, n };
}

test('a word found on the upright image maps back onto the printed word, for every quarter turn and tilt', () => {
  const w = 600, h = 800;
  for (const turn of [0, 90, 180, 270]) {
    for (const tilt of [0, 3, -7, 25, -40]) {
      // One dark word placed well off the centre, so a wrong rotation or offset would move it a long way.
      const page = blankPage(255, w, h);
      for (let y = 120; y < 140; y++) for (let x = 420; x < 520; x++) paint(page, x, y, 30, w, h);
      const g = uprightGeometry(w, h, tilt, turn, 300_000);
      const tilted = tilt ? straightenRgba(page, w, h, tilt, { width: g.tiltWidth, height: g.tiltHeight, scale: g.scale }) : page;
      const upright = turn ? turnRgba(tilted, g.tiltWidth, g.tiltHeight, turn) : { data: tilted, width: g.tiltWidth, height: g.tiltHeight };
      assert.deepEqual([upright.width, upright.height], [g.width, g.height]);
      const c = inkCentre(upright.data, upright.width, upright.height);
      assert.ok(c.n > 0, `turn ${turn}, tilt ${tilt}: the word is still on the image`);
      const back = applyAffine(g.toRaw, c.x, c.y);
      const tolerance = 1.5 / g.scale;
      assert.ok(Math.abs(back.x - 470) < tolerance && Math.abs(back.y - 130) < tolerance,
        `turn ${turn}, tilt ${tilt}: mapped back to (${back.x.toFixed(1)}, ${back.y.toFixed(1)})`);
      // And the other way: the printed word's centre, carried forward, is where the ink is on the upright image.
      const inv = invert(g.toRaw);
      const fwd = applyAffine(inv, 470, 130);
      assert.ok(Math.abs(fwd.x - c.x) < 1.5 && Math.abs(fwd.y - c.y) < 1.5, `turn ${turn}, tilt ${tilt}: forward`);
    }
  }
});

/** The inverse of an affine map [a, b, c, d, e, f]. */
function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

test('the corners of a page tilted 40 degrees are kept, not cut off', () => {
  const w = 600, h = 800;
  const page = blankPage(255, w, h);
  for (const [x0, y0] of [[0, 0], [w - 20, 0], [0, h - 20], [w - 20, h - 20]]) {
    for (let y = y0; y < y0 + 20; y++) for (let x = x0; x < x0 + 20; x++) paint(page, x, y, 0, w, h);
  }
  const g = uprightGeometry(w, h, 40);
  const out = straightenRgba(page, w, h, 40, { width: g.tiltWidth, height: g.tiltHeight });
  const before = inkCentre(page, w, h).n;
  const after = inkCentre(out, g.tiltWidth, g.tiltHeight).n;
  assert.ok(Math.abs(after - before) / before < 0.1, `${before} dark pixels before, ${after} after`);
});

test('a quarter turn moves whole pixels: four of them give the page back unchanged', () => {
  const w = 7, h = 5;
  const page = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < page.length; i++) page[i] = (i * 37) % 256;
  let img = { data: page, width: w, height: h };
  for (let k = 0; k < 4; k++) img = turnRgba(img.data, img.width, img.height, 90);
  assert.deepEqual([img.width, img.height], [w, h]);
  assert.deepEqual(img.data, page);
  // Counter-clockwise: the top-right pixel of the page becomes the top-left one.
  const once = turnRgba(page, w, h, 90);
  assert.deepEqual([...once.data.slice(0, 4)], [...page.slice((w - 1) * 4, w * 4)]);
});

test('straightening does not touch the input; by default it keeps the size', () => {
  const page = textPage(2);
  const copy = Uint8ClampedArray.from(page);
  const out = straightenRgba(page, W, H, 2);
  assert.deepEqual(page, copy);
  assert.equal(out.length, page.length);
  assert.equal(out[3], 255, 'a corner is filled opaque white');
  assert.equal(out[0], 255);
});

test('a page straightened by its estimate measures level', () => {
  for (const tilt of [-4, 1.4, 33]) {
    const page = textPage(tilt);
    const e = estimateLayout(page, W, H);
    const g = uprightGeometry(W, H, e.tilt);
    const again = estimateLayout(straightenRgba(page, W, H, e.tilt, { width: g.tiltWidth, height: g.tiltHeight }), g.tiltWidth, g.tiltHeight);
    assert.ok(Math.abs(again.tilt) <= 0.3, `tilt ${tilt}: still ${again.tilt} after straightening`);
  }
});

// ── the sequence ────────────────────────────────────────────────────────────────────────────────────────────────────

/** An engine and a pixel mover that record what they are asked to do; images carry their own pixels. */
function fakes(page, orientation) {
  const calls = [];
  const raster = { data: page, width: W, height: H };
  const session = {
    load: async (image) => { calls.push(['load', image.width, image.height]); },
    orientation: async () => { calls.push(['orientation']); return orientation; },
    words: async () => { calls.push(['words']); return [{ text: 'w', x0: 1, y0: 2, x1: 3, y1: 4 }]; },
  };
  const io = {
    sample: async (image) => image,
    tilt: async (image, angle, g) => {
      calls.push(['tilt', angle]);
      return { data: straightenRgba(image.data, image.width, image.height, angle, { width: g.tiltWidth, height: g.tiltHeight }), width: g.tiltWidth, height: g.tiltHeight };
    },
    turn: async (image, turn, size) => {
      calls.push(['turn', turn]);
      const t = turnRgba(image.data, image.width, image.height, turn);
      assert.deepEqual([t.width, t.height], [size.width, size.height]);
      return t;
    },
  };
  return { calls, raster, session, io };
}

test('a level, upright page is loaded once, asked which way up it is, and read', async () => {
  const { calls, raster, session, io } = fakes(textPage(0), { rotation: 0 });
  const r = await readUpright(raster, raster, session, io);
  assert.deepEqual(calls, [['load', W, H], ['orientation'], ['words']]);
  assert.deepEqual([r.tilt, r.turn], [0, 0]);
  assert.deepEqual(r.words, [{ text: 'w', x0: 1, y0: 2, x1: 3, y1: 4 }]);
});

test('an upside-down page is turned once the engine says so, and a sideways answer for it is ignored', async () => {
  let f = fakes(textPage(0), { rotation: 180 });
  let r = await readUpright(f.raster, f.raster, f.session, f.io);
  assert.deepEqual(f.calls, [['load', W, H], ['orientation'], ['turn', 180], ['load', W, H], ['words']]);
  assert.equal(r.turn, 180);
  f = fakes(textPage(0), { rotation: 90 });
  r = await readUpright(f.raster, f.raster, f.session, f.io);
  assert.equal(r.turn, 0);
  assert.deepEqual(f.calls.map((c) => c[0]), ['load', 'orientation', 'words']);
});

test('a tilted page on its side is levelled, then turned, and its words map back through both', async () => {
  const { calls, raster, session, io } = fakes(textPage(-5, { sideways: true }), { rotation: 270 });
  const r = await readUpright(raster, raster, session, io);
  assert.equal(calls[0][0], 'tilt');
  assert.ok(Math.abs(calls[0][1] + 5) <= 0.15, `tilt ${calls[0][1]}`);
  assert.deepEqual(calls.slice(1).map((c) => c[0]), ['load', 'orientation', 'turn', 'load', 'words']);
  assert.equal(r.turn, 270);
  assert.deepEqual(r.toRaw, uprightGeometry(W, H, r.tilt, 270).toRaw);
});

test('a page with nothing to measure is read as it is, without asking the engine which way up it is', async () => {
  const { calls, raster, session, io } = fakes(blankPage(), { rotation: 180 });
  const r = await readUpright(raster, raster, session, io);
  assert.deepEqual(calls, [['load', W, H], ['words']]);
  assert.deepEqual([r.tilt, r.turn], [0, 0]);
});

// ── the page's own /Rotate ──────────────────────────────────────────────────────────────────────────────────────────

test('a page\'s /Rotate (clockwise, as displayed) becomes the counter-clockwise turn that shows its raster upright', () => {
  for (const [rotate, turn] of [[0, 0], [90, 270], [180, 180], [270, 90], [-90, 90], [450, 270], [undefined, 0]]) {
    assert.equal(displayTurn(rotate), turn, `/Rotate ${rotate}`);
  }
});

test('a page stored turned, with /Rotate to show it upright, is turned by its /Rotate before anything else, so the engine sees it upright', async () => {
  for (const rotate of [90, 180, 270]) {
    // The raster as stored: the upright page turned the other way from its /Rotate.
    const stored = turnRgba(textPage(0), W, H, rotate);
    const { calls, session, io } = fakes(null, { rotation: 0 });
    const raster = { data: stored.data, width: stored.width, height: stored.height };
    const r = await readUpright(raster, raster, session, io, { pageTurn: displayTurn(rotate) });
    assert.deepEqual(calls.map((c) => c[0]), ['turn', 'load', 'orientation', 'words'], `/Rotate ${rotate}`);
    assert.deepEqual(calls[1].slice(1), [W, H], `/Rotate ${rotate}: the engine reads the page upright`);
    assert.equal(r.turn, displayTurn(rotate));
    // A point of the upright page maps to where that point is stored.
    const g = uprightGeometry(stored.width, stored.height, 0, 0, Infinity, displayTurn(rotate));
    assert.deepEqual(r.toRaw, g.toRaw);
  }
});

test('a word found on a page turned by its /Rotate, then tilted and turned again, maps back onto the stored word', () => {
  const w = 600, h = 800;
  for (const pageTurn of [90, 180, 270]) {
    for (const [tilt, turn] of [[0, 0], [4, 0], [-12, 180]]) {
      const page = blankPage(255, w, h);
      for (let y = 120; y < 140; y++) for (let x = 420; x < 520; x++) paint(page, x, y, 30, w, h);
      const shown = turnRgba(page, w, h, pageTurn);
      const g = uprightGeometry(w, h, tilt, turn, Infinity, pageTurn);
      const tilted = tilt ? straightenRgba(shown.data, shown.width, shown.height, tilt, { width: g.tiltWidth, height: g.tiltHeight }) : shown.data;
      const upright = turn ? turnRgba(tilted, g.tiltWidth, g.tiltHeight, turn) : { data: tilted, width: g.tiltWidth, height: g.tiltHeight };
      assert.deepEqual([upright.width, upright.height], [g.width, g.height]);
      const c = inkCentre(upright.data, upright.width, upright.height);
      const back = applyAffine(g.toRaw, c.x, c.y);
      assert.ok(Math.abs(back.x - 470) < 1.5 && Math.abs(back.y - 130) < 1.5,
        `page turn ${pageTurn}, tilt ${tilt}, turn ${turn}: mapped back to (${back.x.toFixed(1)}, ${back.y.toFixed(1)})`);
    }
  }
});

test('the engine is told each image\'s resolution: the raster\'s, times the tilted canvas\'s scale', async () => {
  const seen = [];
  const raster = { data: textPage(-5, { sideways: true }), width: W, height: H };
  const session = {
    load: async (image, opts) => { seen.push(opts?.dpi); },
    orientation: async () => ({ rotation: 270 }),
    words: async () => [],
  };
  const io = {
    sample: async (image) => image,
    tilt: async (image, angle, g) => ({ width: g.tiltWidth, height: g.tiltHeight, data: new Uint8ClampedArray(g.tiltWidth * g.tiltHeight * 4) }),
    turn: async (image, turn, size) => ({ ...size, data: new Uint8ClampedArray(size.width * size.height * 4) }),
  };
  // Held to the raster's own area, so the tilted canvas is scaled down to fit.
  const r = await readUpright(raster, { width: W, height: H, dpi: 150 }, session, io, { maxPixels: W * H });
  const g = uprightGeometry(W, H, r.tilt, 270, W * H);
  assert.ok(g.scale < 1);
  assert.equal(seen.length, 2, 'loaded levelled, then turned');
  for (const dpi of seen) assert.ok(Math.abs(dpi - 150 * g.scale) < 1e-9, `told ${dpi}`);
  // Without a resolution nothing is passed.
  seen.length = 0;
  await readUpright(raster, { width: W, height: H }, session, io);
  assert.deepEqual(seen, [undefined, undefined]);
});
