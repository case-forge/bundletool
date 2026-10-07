/**
 * A PNG or JPEG is checked before pdf-lib sees it. pdf-lib inflates a PNG on the calling thread and
 * never returns on a damaged stream (a truncated PNG would freeze the tab), and a header can declare
 * hundreds of millions of pixels. Every damaged case below must be refused quickly with a plain
 * reason; the good ones must pass unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import * as fx from './fixtures.mjs';
import { checkPng, checkJpeg, ImageCheckError } from '../public/js/bundletoolImageCheck.js';
import { imageToPages, ImageFormatError } from '../public/js/bundletoolImages.js';
import { imagesToPdf } from '../public/js/bundletoolPages.js';

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w, h, depth = 8, colour = 2, interlace = 0) => {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = depth; b[9] = colour; b[12] = interlace;
  return b;
};
const png = (parts) => new Uint8Array(Buffer.concat([SIG, ...parts]));
const good = () => fx.makeNoisePng(64, 48, 7);

/** Rejects, quickly, with an ImageCheckError of the wanted code. */
async function refused(bytes, code = 'decode', options) {
  const started = Date.now();
  await assert.rejects(() => checkPng(bytes, options), (e) => e instanceof ImageCheckError && e.code === code, `expected a ${code} refusal`);
  assert.ok(Date.now() - started < 5000, 'the refusal was slow');
}

test('an intact PNG passes', async () => { await checkPng(good()); });

test('a PNG cut short anywhere is refused, never left to hang', async () => {
  const bytes = good();
  for (const fraction of [0.3, 0.6, 0.9, 0.99]) await refused(bytes.slice(0, Math.floor(bytes.length * fraction)));
});

test('a PNG whose picture data is scrambled but whose blocks are all intact is refused', async () => {
  const raw = Buffer.alloc(48 * (1 + 64 * 3), 7);
  const compressed = deflateSync(raw);
  compressed.fill(0xa5, 6, compressed.length - 4);   // keep the zlib header and trailer, wreck the middle
  await refused(png([chunk('IHDR', ihdr(64, 48)), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]));
});

test('a PNG whose picture data is shorter than its header says is refused', async () => {
  const short = deflateSync(Buffer.alloc(10 * (1 + 64 * 3), 1));
  await refused(png([chunk('IHDR', ihdr(64, 48)), chunk('IDAT', short), chunk('IEND', Buffer.alloc(0))]));
});

test('a PNG block that fails its checksum, a missing end block and a missing header are refused', async () => {
  const bytes = Buffer.from(good());
  const flipped = Buffer.from(bytes); flipped[40] ^= 0xff;
  await refused(new Uint8Array(flipped));
  await refused(png([chunk('IHDR', ihdr(4, 4)), chunk('IDAT', deflateSync(Buffer.alloc(4 * 13)))]));
  await refused(png([chunk('IDAT', Buffer.alloc(8)), chunk('IEND', Buffer.alloc(0))]));
  await refused(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
});

test('a tiny PNG that declares hundreds of millions of pixels is refused as too large, before anything is inflated', async () => {
  const bomb = png([chunk('IHDR', ihdr(20000, 20000)), chunk('IDAT', deflateSync(Buffer.alloc(64))), chunk('IEND', Buffer.alloc(0))]);
  assert.ok(bomb.length < 200);
  await refused(bomb, 'toolarge');
});

test('a palette PNG with no palette and an impossible colour type or depth are refused', async () => {
  const data = chunk('IDAT', deflateSync(Buffer.alloc(4 * 5)));
  await refused(png([chunk('IHDR', ihdr(4, 4, 8, 3)), data, chunk('IEND', Buffer.alloc(0))]));
  await refused(png([chunk('IHDR', ihdr(4, 4, 7, 2)), data, chunk('IEND', Buffer.alloc(0))]));
  await refused(png([chunk('IHDR', ihdr(4, 4, 8, 5)), data, chunk('IEND', Buffer.alloc(0))]));
});

test('interlaced and palette PNGs that are complete pass', async () => {
  // A 3 x 3 interlaced 8-bit grey image is 7 passes; build the exact inflated size for it.
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  let size = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.ceil((3 - x0) / dx); const h = Math.ceil((3 - y0) / dy);
    if (w > 0 && h > 0) size += h * (1 + w);
  }
  await checkPng(png([chunk('IHDR', ihdr(3, 3, 8, 0, 1)), chunk('IDAT', deflateSync(Buffer.alloc(size))), chunk('IEND', Buffer.alloc(0))]));
  await checkPng(png([chunk('IHDR', ihdr(4, 4, 8, 3)), chunk('PLTE', Buffer.alloc(6)), chunk('IDAT', deflateSync(Buffer.alloc(4 * 5))), chunk('IEND', Buffer.alloc(0))]));
});

test('the picture data may be split over several IDAT blocks', async () => {
  const z = deflateSync(Buffer.alloc(48 * (1 + 64 * 3), 3));
  const mid = Math.floor(z.length / 2);
  await checkPng(png([chunk('IHDR', ihdr(64, 48)), chunk('IDAT', z.subarray(0, mid)), chunk('IDAT', z.subarray(mid)), chunk('IEND', Buffer.alloc(0))]));
});

test('imageToPages refuses a damaged PNG with the app error, quickly, and passes an intact one through unchanged', async () => {
  const intact = good();
  const [page] = await imageToPages(intact);
  assert.equal(page.bytes, intact);
  const started = Date.now();
  await assert.rejects(() => imageToPages(intact.slice(0, Math.floor(intact.length * 0.6))),
    (e) => e instanceof ImageFormatError && e.code === 'decode');
  assert.ok(Date.now() - started < 5000);
  // The intact one still becomes a PDF.
  assert.ok((await imagesToPdf([page])).length > 100);
});

const jpeg = (parts) => new Uint8Array(parts.flat());
const SOF = [0xff, 0xc0, 0, 11, 8, 0, 4, 0, 4, 1, 1, 0x11, 0];
const SOS = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0];

test('a complete JPEG passes and one with no end marker, no scan or no frame header is refused', () => {
  checkJpeg(jpeg([[0xff, 0xd8], SOF, SOS, [0x12, 0xff, 0x00, 0x34, 0xff, 0xd9]]));
  assert.throws(() => checkJpeg(jpeg([[0xff, 0xd8], SOF, SOS, [0x12, 0x34, 0x56]])), (e) => e instanceof ImageCheckError && e.code === 'decode');
  assert.throws(() => checkJpeg(jpeg([[0xff, 0xd8], SOF, [0xff, 0xd9]])), (e) => e instanceof ImageCheckError);
  assert.throws(() => checkJpeg(jpeg([[0xff, 0xd8], SOS, [0x12, 0xff, 0xd9]])), (e) => e instanceof ImageCheckError);
  assert.throws(() => checkJpeg(jpeg([[0xff, 0xd8], [0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0], SOS, [0x12, 0xff, 0xd9]])), (e) => e instanceof ImageCheckError);
  assert.throws(() => checkJpeg(jpeg([[0xff, 0xd8], SOF.slice(0, 6)])), (e) => e instanceof ImageCheckError);
});

test('imageToPages refuses a truncated JPEG with the app error', async () => {
  const whole = jpeg([[0xff, 0xd8], SOF, SOS, [0x12, 0xff, 0x00, 0x34, 0xff, 0xd9]]);
  const [page] = await imageToPages(whole);
  assert.equal(page.kind, 'jpeg');
  await assert.rejects(() => imageToPages(whole.slice(0, whole.length - 2)), (e) => e instanceof ImageFormatError && e.code === 'decode');
});
