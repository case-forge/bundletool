/**
 * The second look at print the engine passed over (bundletoolOcrGaps.js): which regions are read again, and which of
 * the words found there are kept. The pages are plain geometry at 200 dpi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAPS, uncoveredRegions, keepFound } from '../public/js/bundletoolOcrGaps.js';
import { readUpright } from '../public/js/bundletoolDeskew.js';

const W = 1654;
const H = 2339;

function blank() { return new Uint8ClampedArray(W * H * 4).fill(255); }
function box(rgba, x0, y0, x1, y1, v = 20) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * W + x) * 4; rgba[o] = rgba[o + 1] = rgba[o + 2] = v; }
}
/** A word-like blob of print: letters 14px wide, 26px tall, 6px apart. */
function word(rgba, x, y, letters) {
  for (let i = 0; i < letters; i++) box(rgba, x + i * 20, y, x + i * 20 + 14, y + 26);
}

test('print that a first-pass word covers is not read again', () => {
  const page = blank();
  word(page, 200, 300, 6);
  word(page, 360, 300, 4);
  const found = [{ x0: 198, y0: 298, x1: 316, y1: 328 }, { x0: 358, y0: 298, x1: 436, y1: 328 }];
  assert.deepEqual(uncoveredRegions(page, W, H, found), []);
});

test('ruled lines, a page border and a ruled table on their own are not read again', () => {
  const page = blank();
  for (let y = 300; y <= 1500; y += 60) box(page, 150, y, 1500, y + 3);
  for (let x = 150; x <= 1500; x += 270) box(page, x, 300, x + 3, 1503);
  box(page, 40, 40, W - 40, 46);
  assert.deepEqual(uncoveredRegions(page, W, H, []), []);
});

test('a label beside a checkbox that no word covers is one region, with a margin round it', () => {
  const page = blank();
  // The checkbox: a 40px square outline, too short to be a ruled line. The label to its right.
  box(page, 200, 1000, 240, 1003); box(page, 200, 1037, 240, 1040); box(page, 200, 1000, 203, 1040); box(page, 237, 1000, 240, 1040);
  word(page, 260, 1007, 3);
  const regions = uncoveredRegions(page, W, H, []);
  assert.equal(regions.length, 1);
  const [r] = regions;
  assert.ok(r.x0 <= 200 - 8 && r.y0 <= 1000 - 8 && r.x1 >= 314 + 8 && r.y1 >= 1040 + 8, JSON.stringify(r));
  assert.ok(r.x1 - r.x0 < 200 && r.y1 - r.y0 < 100, `a tight region: ${JSON.stringify(r)}`);
});

test('specks, a photograph-sized dark area and print taller than a line are not read again', () => {
  const page = blank();
  for (let i = 0; i < 40; i++) box(page, 100 + i * 37, 200 + (i % 7) * 50, 102 + i * 37, 202 + (i % 7) * 50);   // specks
  box(page, 300, 700, 1300, 1500, 90);                                                                         // a photograph
  box(page, 1400, 1600, 1440, 2000);                                                                           // a tall bar
  assert.deepEqual(uncoveredRegions(page, W, H, []), []);
});

test('regions are given top first, at most MAX_REGIONS of them', () => {
  const page = blank();
  for (let i = 0; i < GAPS.MAX_REGIONS + 5; i++) word(page, 200 + (i % 2) * 700, 2200 - i * 60, 3);
  const regions = uncoveredRegions(page, W, H, []);
  assert.equal(regions.length, GAPS.MAX_REGIONS);
  for (let i = 1; i < regions.length; i++) assert.ok(regions[i].y0 >= regions[i - 1].y0);
});

test('the sizes scale with the resolution: the same label at 100 dpi is still found', () => {
  const half = new Uint8ClampedArray((W / 2) * (Math.ceil(H / 2)) * 4).fill(255);
  const w2 = W / 2;
  const put = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * w2 + x) * 4; half[o] = half[o + 1] = half[o + 2] = 20; } };
  for (let i = 0; i < 3; i++) put(130 + i * 10, 500, 137 + i * 10, 513);
  assert.equal(uncoveredRegions(half, w2, Math.ceil(H / 2), [], 100).length, 1);
});

test('only confident words of two letters or more, not over a word already found, are kept, moved onto the page', () => {
  const region = { x0: 500, y0: 900 };
  const already = [{ text: 'Name', x0: 400, y0: 905, x1: 560, y1: 930 }];
  const kept = keepFound([
    { text: 'Yes', confidence: 0.97, x0: 120, y0: 10, x1: 170, y1: 36 },
    { text: 'No', confidence: 0.85, x0: 200, y0: 10, x1: 240, y1: 36 },     // not sure enough
    { text: '|', confidence: 0.99, x0: 260, y0: 10, x1: 264, y1: 36 },      // a box edge, not a word
    { text: 'ame', confidence: 0.95, x0: 20, y0: 8, x1: 60, y1: 30 },       // over "Name", found already
  ], region, already);
  assert.deepEqual(kept, [{ text: 'Yes', confidence: 0.97, x0: 620, y0: 910, x1: 670, y1: 936 }]);
});

test('readUpright reads each region again in sparse mode, at the page\'s resolution, and adds what it keeps', async () => {
  const page = blank();
  word(page, 200, 300, 6);
  word(page, 800, 1200, 3);   // passed over by the first pass
  const calls = [];
  let load = 0;
  const session = {
    load: async (image, opts) => { calls.push(['load', image.width, opts]); load++; },
    orientation: async () => ({ rotation: 0 }),
    words: async () => (load === 1
      ? [{ text: 'first', confidence: 0.96, x0: 198, y0: 298, x1: 316, y1: 328 }]
      : [{ text: 'again', confidence: 0.95, x0: 15, y0: 14, x1: 70, y1: 40 }]),
  };
  const raster = { data: page, width: W, height: H };
  const io = {
    sample: async (image) => image,
    tilt: async () => { throw new Error('not tilted'); },
    turn: async () => { throw new Error('not turned'); },
    pixels: async (image) => image,
    crop: async (image, b) => ({ width: b.x1 - b.x0, height: b.y1 - b.y0, box: b }),
  };
  const r = await readUpright(raster, { width: W, height: H, dpi: 200 }, session, io);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][2], { dpi: 200, sparse: true });
  assert.equal(r.words.length, 2);
  assert.equal(r.words[1].text, 'again');
  assert.ok(r.words[1].x0 > 780 && r.words[1].y0 > 1180, JSON.stringify(r.words[1]));
});

test('without pixels and crops to work on, there is no second look', async () => {
  const page = blank();
  word(page, 800, 1200, 3);
  let loads = 0;
  const session = { load: async () => { loads++; }, orientation: async () => ({ rotation: 0 }), words: async () => [] };
  const raster = { data: page, width: W, height: H };
  await readUpright(raster, { width: W, height: H }, session, { sample: async (i) => i, tilt: null, turn: null });
  assert.equal(loads, 1);
});
