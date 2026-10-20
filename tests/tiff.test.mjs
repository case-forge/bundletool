/**
 * TIFF safety: a file is inspected from its tags before any pixel is decoded, so a tiny file that
 * declares a huge page, or one cut short, is refused with a plain reason instead of blanking a
 * page or exhausting memory. (The decode itself runs in a worker in the browser; the checks and
 * the page decode are the same code and are exercised here.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectTiff, decodeTiffPage, TiffProblem, MAX_TIFF_PIXELS } from '../public/js/bundletoolTiff.js';
import { readImageSize, imageToPages, ImageFormatError, MAX_PIXELS } from '../public/js/bundletoolImages.js';

const { default: UTIF } = await import('../public/js/vendor/utif2.js');

/** A little-endian TIFF of one or more uncompressed 8-bit grey pages, strips laid out after the tags. */
function buildTiff(pages) {
  const parts = [];
  const header = new Uint8Array(8);
  header.set([0x49, 0x49, 42, 0]);
  const entries = 9;
  const ifdSize = 2 + entries * 12 + 4;
  let offset = 8;
  const blobs = [header];
  pages.forEach((page, i) => {
    const ifdAt = offset;
    const dataAt = ifdAt + ifdSize;
    const declared = page.strip ?? page.width * page.height;
    const ifd = new DataView(new ArrayBuffer(ifdSize));
    ifd.setUint16(0, entries, true);
    const tag = (k, id, type, value) => {
      const p = 2 + k * 12;
      ifd.setUint16(p, id, true); ifd.setUint16(p + 2, type, true); ifd.setUint32(p + 4, 1, true);
      if (type === 3) ifd.setUint16(p + 8, value, true); else ifd.setUint32(p + 8, value, true);
    };
    tag(0, 256, 4, page.width); tag(1, 257, 4, page.height); tag(2, 258, 3, 8); tag(3, 259, 3, 1);
    tag(4, 262, 3, 1); tag(5, 273, 4, dataAt); tag(6, 277, 3, 1); tag(7, 278, 4, page.height); tag(8, 279, 4, declared);
    const last = i === pages.length - 1;
    const data = page.data ?? new Uint8Array(page.width * page.height).fill(200);
    ifd.setUint32(2 + entries * 12, last ? 0 : dataAt + data.length, true);
    blobs.push(new Uint8Array(ifd.buffer), data);
    offset = dataAt + data.length;
  });
  const out = new Uint8Array(blobs.reduce((n, b) => n + b.length, 0));
  header.set([8, 0, 0, 0], 4);
  let at = 0;
  for (const b of blobs) { out.set(b, at); at += b.length; }
  return out;
}
const asBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

test('a good TIFF is inspected and decoded page by page', () => {
  const file = buildTiff([{ width: 40, height: 30 }, { width: 20, height: 20 }]);
  const buffer = asBuffer(file);
  const pages = inspectTiff(UTIF, buffer);
  assert.equal(pages.length, 2);
  const first = decodeTiffPage(UTIF, buffer, pages[0]);
  assert.equal(first.width, 40);
  assert.equal(first.height, 30);
  assert.equal(first.grey, true);
  assert.equal(first.rgba.length, 40 * 30 * 4);
});

test('a tiny file that declares a huge page is refused before anything is decoded', () => {
  // About 138 bytes of tags claiming 20000 by 20000 pixels would otherwise allocate about 3 GB.
  const bomb = asBuffer(buildTiff([{ width: 20000, height: 20000, data: new Uint8Array(4) }]));
  assert.ok(bomb.byteLength < 400);
  assert.throws(() => inspectTiff(UTIF, bomb), (e) => e instanceof TiffProblem && e.code === 'toolarge');
  assert.ok(20000 * 20000 > MAX_TIFF_PIXELS);
});

test('a file whose picture data runs past its end is refused as damaged, not shown as a blank page', () => {
  const bomb = asBuffer(buildTiff([{ width: 5000, height: 5000, data: new Uint8Array(4) }]));
  assert.throws(() => inspectTiff(UTIF, bomb), (e) => e instanceof TiffProblem && e.code === 'damaged');
  const whole = buildTiff([{ width: 200, height: 200 }]);
  const cut = asBuffer(whole.subarray(0, whole.length - 5000));
  assert.throws(() => inspectTiff(UTIF, cut), (e) => e instanceof TiffProblem && e.code === 'damaged', 'a truncated copy');
});

test('a file whose strips are inside the file but hold far less than the picture is refused, not shown as a blank page', () => {
  // 5000 x 5000 grey declares 25 MB; this holds sixteen bytes and says so.
  const thin = asBuffer(buildTiff([{ width: 5000, height: 5000, data: new Uint8Array(16), strip: 16 }]));
  assert.throws(() => inspectTiff(UTIF, thin), (e) => e instanceof TiffProblem && e.code === 'damaged');
  // A complete uncompressed page of the same size class still passes.
  inspectTiff(UTIF, asBuffer(buildTiff([{ width: 300, height: 200 }])));
});

test('a PackBits strip that runs out early or overruns its strip is refused; a good one passes', () => {
  // Encode a row of 20 grey bytes as one PackBits run (-19 => repeat the next byte 20 times).
  const goodRow = [(-19) & 255, 200];
  const rows = (n) => new Uint8Array(Array.from({ length: n }, () => goodRow).flat());
  const make = (width, height, data) => {
    const file = buildTiff([{ width, height, data, strip: data.length }]);
    // Change Compression (tag 259) to PackBits: the value sits in the 4th entry of the first IFD.
    const view = new DataView(file.buffer);
    view.setUint16(8 + 2 + 3 * 12 + 8, 32773, true);
    return asBuffer(file);
  };
  inspectTiff(UTIF, make(20, 10, rows(10)));
  assert.throws(() => inspectTiff(UTIF, make(20, 10, rows(4))), (e) => e instanceof TiffProblem && e.code === 'damaged', 'too few rows');
  const overrun = new Uint8Array([...rows(9), 10]);   // a literal-run header with no bytes after it
  assert.throws(() => inspectTiff(UTIF, make(20, 10, overrun)), (e) => e instanceof TiffProblem && e.code === 'damaged', 'a run that leaves the strip');
});

test('a file that is not a readable TIFF is a damaged file, not a crash', () => {
  const junk = new Uint8Array([0x49, 0x49, 42, 0, 255, 255, 255, 255, 1, 2, 3, 4]);
  assert.throws(() => inspectTiff(UTIF, asBuffer(junk)), (e) => e instanceof TiffProblem);
});

test('a picture header that declares too many pixels is refused before the browser is asked to open it', async () => {
  const gif = (w, h) => new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]));
  assert.deepEqual(readImageSize(gif(300, 200), 'gif'), { width: 300, height: 200 });
  await assert.rejects(() => imageToPages(gif(65535, 65535)), (e) => e instanceof ImageFormatError && e.code === 'toolarge');
  const bmp = new Uint8Array(40); bmp.set([0x42, 0x4d]); new DataView(bmp.buffer).setUint32(14, 40, true);
  new DataView(bmp.buffer).setInt32(18, 40000, true); new DataView(bmp.buffer).setInt32(22, -40000, true);
  assert.deepEqual(readImageSize(bmp, 'bmp'), { width: 40000, height: 40000 });
  await assert.rejects(() => imageToPages(bmp), (e) => e instanceof ImageFormatError && e.code === 'toolarge');
  assert.ok(MAX_PIXELS >= 48e6, 'a 48 megapixel phone photo must still open');
});

test('WEBP and AVIF sizes are read from their headers', () => {
  const vp8x = new Uint8Array(30); vp8x.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0); vp8x.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
  vp8x.set([(9999) & 255, (9999 >> 8) & 255, 0, (7999) & 255, (7999 >> 8) & 255, 0], 24);
  assert.deepEqual(readImageSize(vp8x, 'webp'), { width: 10000, height: 8000 });
  const avif = new Uint8Array(64); avif.set([...'ftypavif'].map((c) => c.charCodeAt(0)), 4);
  avif.set([...'ispe'].map((c) => c.charCodeAt(0)), 20);
  new DataView(avif.buffer).setUint32(28, 12000); new DataView(avif.buffer).setUint32(32, 9000);
  assert.deepEqual(readImageSize(avif, 'avif'), { width: 12000, height: 9000 });
});

test('a CMYK TIFF (a print-shop scan) is read, not refused as damaged', async () => {
  const fs = await import('node:fs');
  const bytes = fs.readFileSync(new URL('./fixtures/tiff/cmyk_lzw.tif', import.meta.url));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const pages = inspectTiff(UTIF, buffer);
  assert.equal(pages.length, 1);
  const page = decodeTiffPage(UTIF, buffer, pages[0]);
  assert.equal(page.width, 300);
  assert.equal(page.height, 180);
  // Paper is light in red and blue (the fixture's green is tinted) with dark text on it: the picture came through.
  assert.ok(page.rgba[0] > 240 && page.rgba[2] > 240 && page.rgba[3] === 255);
  assert.ok(page.rgba.some((v, i) => i % 4 === 0 && v < 100), 'the dark text came through');
});
