/**
 * A JPEG or PNG as a PDF page without a canvas (bundletoolPhotoPdf.js), which is how the command line
 * takes photos. The eight EXIF orientations are checked twice: as arithmetic on the corners, and (where
 * pdftoppm is installed) by rendering each one and reading the colours back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { photoToPdf, PhotoError } from '../public/js/bundletoolPhotoPdf.js';
import { orientationMatrix } from '/js/shared/exif-orientation.js';
import { loadPdf } from '../public/js/bundletoolPdfLoad.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'photo');
const read = (n) => new Uint8Array(fs.readFileSync(path.join(dir, n)));
const HAVE_PDFTOPPM = spawnSync('pdftoppm', ['-v']).status !== null;

test('the eight EXIF orientations map the stored corners to the right upright corners', () => {
  // stored 300 x 100 picture drawn in a 300 x 100 box (orientations 1 to 4) or a 100 x 300 box (5 to 8);
  // each row lists where the stored top left, top right and bottom left land, upright, y up.
  const apply = (m, u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
  const near = (a, b) => assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9, `${a} vs ${b}`);
  const cases = {
    1: [[0, 100], [300, 100], [0, 0]],
    2: [[300, 100], [0, 100], [300, 0]],
    3: [[300, 0], [0, 0], [300, 100]],
    4: [[0, 0], [300, 0], [0, 100]],
    5: [[0, 300], [0, 0], [100, 300]],
    6: [[100, 300], [100, 0], [0, 300]],
    7: [[100, 0], [100, 300], [0, 0]],
    8: [[0, 0], [0, 300], [100, 0]],
  };
  for (const [o, [tl, tr, bl]] of Object.entries(cases)) {
    const sideways = Number(o) >= 5;
    const m = orientationMatrix(Number(o), 300, 100, 0, 0, sideways ? 100 : 300, sideways ? 300 : 100);
    near(apply(m, 0, 1), tl);   // the stored top left corner is image (u, v) = (0, 1)
    near(apply(m, 1, 1), tr);
    near(apply(m, 0, 0), bl);
  }
});

test('a JPEG and a PNG become one page of the bundle size, embedded as they are', async () => {
  for (const [name, size, key] of [['plain.jpg', [595.28, 841.89], 'a4'], ['upright.png', [595.28, 841.89], undefined], ['plain.jpg', [612, 792], 'letter']]) {
    const pdf = await photoToPdf(read(name), key);
    const { doc } = await loadPdf(pdf);
    assert.equal(doc.getPageCount(), 1);
    const { width, height } = doc.getPage(0).getSize();
    assert.ok(Math.abs(width - size[0]) < 0.5 && Math.abs(height - size[1]) < 0.5, `${name} ${key}: ${width} x ${height}`);
  }
  const jpg = read('orientation-6.jpg');
  const text = Buffer.from(await photoToPdf(jpg, 'a4')).toString('latin1');
  assert.ok(text.includes(Buffer.from(jpg.subarray(0, 4000)).toString('latin1')), 'the JPEG bytes are inside the PDF untouched');
});

test('a damaged picture, a header lying about its size, and something that is not a JPEG or PNG are refused', async () => {
  const jpg = read('plain.jpg');
  await assert.rejects(photoToPdf(jpg.subarray(0, Math.floor(jpg.length * 0.5)), 'a4'), (e) => e instanceof PhotoError && e.code === 'decode');
  const png = read('upright.png');
  await assert.rejects(photoToPdf(png.subarray(0, 60), 'a4'), (e) => e instanceof PhotoError);
  const huge = Uint8Array.from(png);
  new DataView(huge.buffer).setUint32(16, 60000);    // IHDR width
  new DataView(huge.buffer).setUint32(20, 60000);    // IHDR height
  await assert.rejects(photoToPdf(huge, 'a4'), (e) => e instanceof PhotoError);
  await assert.rejects(photoToPdf(read('sample.webp'), 'a4'), /Not a JPG or PNG/);
});

test('every orientation renders upright: red, green, blue, yellow clockwise from the top left, black bar on top', { skip: !HAVE_PDFTOPPM }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-'));
  try {
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const pdf = path.join(tmp, `o${o}.pdf`);
      fs.writeFileSync(pdf, await photoToPdf(read(`orientation-${o}.jpg`), 'a4'));
      const out = path.join(tmp, `o${o}`);
      const r = spawnSync('pdftoppm', ['-r', '72', '-singlefile', pdf, out]);
      assert.equal(r.status, 0);
      const ppm = fs.readFileSync(`${out}.ppm`);
      const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.subarray(0, 40).toString('latin1'));
      const [W, H] = [Number(m[1]), Number(m[2])];
      const px = (x, y) => { const at = m[0].length + (y * W + x) * 3; return [ppm[at], ppm[at + 1], ppm[at + 2]]; };
      // the picture's bounding box: everything that is not white
      let x0 = W; let x1 = 0; let y0 = H; let y1 = 0;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { const p = px(x, y); if (p[0] + p[1] + p[2] < 740) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
      const at = (fx, fy) => px(Math.round(x0 + (x1 - x0) * fx), Math.round(y0 + (y1 - y0) * fy));
      const name = ([r, g, b]) => (r > 180 && g < 90 ? 'R' : g > 140 && r < 90 ? 'G' : b > 170 && r < 90 ? 'B' : r > 200 && g > 180 && b < 100 ? 'Y' : 'K');
      assert.equal([at(0.25, 0.35), at(0.75, 0.35), at(0.75, 0.85), at(0.25, 0.85)].map(name).join(''), 'RGYB', `orientation ${o}`);
      assert.equal(name(at(0.5, 0.02)), 'K', `orientation ${o}: the black bar is on top`);
      assert.ok((x1 - x0) > (y1 - y0), `orientation ${o}: upright the picture is wider than tall`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
