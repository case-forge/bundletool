/**
 * Photos: recognising the format from the bytes, reading a JPEG's EXIF rotation and size, and
 * turning pictures into pages. Decoding a picture the browser must open (WEBP, AVIF, HEIC,
 * TIFF pixels) needs a canvas, so that half is exercised in a real browser, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './fixtures.mjs';
import {
  sniffImage, readJpegInfo, readPngSize, isImageFile, stripPhotoExtension, imageToPages, ImageFormatError, PHOTO_EXTENSIONS,
} from '../public/js/bundletoolImages.js';
import { imagesToPdf } from '../public/js/bundletoolPages.js';
import { loadPdf } from '../public/js/bundletoolPdfLoad.js';

/** A minimal JPEG skeleton: SOI, an EXIF block carrying `orientation`, and a SOF0 of width x height. */
function jpegWith({ orientation, width = 640, height = 480, littleEndian = true }) {
  const u16 = (v) => (littleEndian ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v) => (littleEndian ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]
                                   : [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const tiff = [littleEndian ? 0x49 : 0x4d, littleEndian ? 0x49 : 0x4d, ...u16(42), ...u32(8),
    ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif];
  const sof = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  // A start-of-scan header and a few bytes of picture data (with a stuffed FF), so it is a complete file.
  const sos = [0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 0x12, 0x34, 0xff, 0x00, 0x56];
  return new Uint8Array([0xff, 0xd8, ...(orientation ? app1 : []), ...sof, ...sos, 0xff, 0xd9]);
}

test('each format is recognised from its bytes, whatever the file is called', () => {
  assert.equal(sniffImage(jpegWith({ orientation: 1 })), 'jpeg');
  assert.equal(sniffImage(fx.makePng(4, 4)), 'png');
  assert.equal(sniffImage(new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([1, 0, 1, 0, 0, 0, 0]))), 'gif');
  assert.equal(sniffImage(new Uint8Array([0x42, 0x4d, ...new Array(20).fill(0)])), 'bmp');
  assert.equal(sniffImage(new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBPVP8 '].map((c) => c.charCodeAt(0))))), 'webp');
  assert.equal(sniffImage(new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0])), 'tiff');
  assert.equal(sniffImage(new Uint8Array([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0])), 'tiff');
  const ftyp = (brand, more = '') => new Uint8Array([0, 0, 0, 16 + more.length, ...'ftyp'.split('').map((c) => c.charCodeAt(0)),
    ...brand.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...more.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffImage(ftyp('avif')), 'avif');
  assert.equal(sniffImage(ftyp('heic')), 'heic');
  assert.equal(sniffImage(ftyp('mif1', 'avif')), 'avif', 'a mif1 file that lists avif is an AVIF');
  assert.equal(sniffImage(ftyp('mif1', 'heic')), 'heic');
  assert.equal(sniffImage(new TextEncoder().encode('%PDF-1.7 not a picture')), null);
  assert.equal(sniffImage(new Uint8Array([1, 2, 3])), null);
});

test('a JPEG reports its EXIF rotation and its pixel size', () => {
  for (const orientation of [1, 3, 6, 8]) {
    for (const littleEndian of [true, false]) {
      const info = readJpegInfo(jpegWith({ orientation, width: 4032, height: 3024, littleEndian }));
      assert.deepEqual(info, { orientation, width: 4032, height: 3024 }, `orientation ${orientation}, ${littleEndian ? 'II' : 'MM'}`);
    }
  }
  assert.equal(readJpegInfo(jpegWith({ orientation: 0 })).orientation, 1, 'no EXIF block means upright');
  assert.equal(readJpegInfo(jpegWith({ orientation: 9 })).orientation, 1, 'a nonsense value is ignored');
  assert.deepEqual(readJpegInfo(new Uint8Array([0xff, 0xd8, 0xff])), { orientation: 1, width: 0, height: 0 }, 'truncated bytes do not throw');
});

test('a PNG reports its pixel size', () => {
  assert.deepEqual(readPngSize(fx.makePng(40, 60)), { width: 40, height: 60 });
});

test('the file test follows the accepted types and extensions', () => {
  for (const name of ['a.jpg', 'A.JPEG', 'b.png', 'c.webp', 'd.avif', 'e.gif', 'f.bmp', 'g.tif', 'h.TIFF', 'i.heic', 'j.heif']) {
    assert.ok(isImageFile({ name, type: '' }), name);
  }
  assert.ok(isImageFile({ name: 'noextension', type: 'image/webp' }));
  for (const name of ['a.pdf', 'b.docx', 'c.svg', 'd.txt', 'e.doc']) assert.ok(!isImageFile({ name, type: '' }), name);
  assert.ok(!isImageFile({ name: 'x.svg', type: 'image/svg+xml' }));
  assert.equal(stripPhotoExtension('Photo of wall.HEIC'), 'Photo of wall');
  assert.equal(stripPhotoExtension('scan.tif.pdf'), 'scan.tif.pdf');
  assert.equal(PHOTO_EXTENSIONS.length, 11);
});

test('an upright JPEG and a PNG are embedded unchanged', async () => {
  const png = fx.makePng(40, 60);
  const [page] = await imageToPages(png);
  assert.equal(page.kind, 'png');
  assert.equal(page.bytes, png, 'the very same bytes, not a re-encode');
  const jpeg = jpegWith({ orientation: 1 });
  const [jpegPage] = await imageToPages(jpeg);
  assert.equal(jpegPage.kind, 'jpeg');
  assert.equal(jpegPage.bytes, jpeg);
});

test('a file that is not a picture is refused with a plain reason', async () => {
  await assert.rejects(() => imageToPages(new TextEncoder().encode('just some text, not a picture')),
    (error) => error instanceof ImageFormatError && error.code === 'unsupported');
});

test('a HEIC photo in a browser that cannot open one says so, and does not crash', async () => {
  // No createImageBitmap under Node, which is exactly what Chrome, Firefox and Edge on the desktop look like here.
  const heic = new Uint8Array([0, 0, 0, 24, ...'ftypheic'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...'mif1heic'.split('').map((c) => c.charCodeAt(0))]);
  await assert.rejects(() => imageToPages(heic),
    (error) => error instanceof ImageFormatError && error.code === 'heic' && /Most Compatible/.test(error.userMessage));
});

test('a damaged WEBP is a decode error, not an unsupported type', async () => {
  const webp = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0)), [0, 0, 0, 0]));
  await assert.rejects(() => imageToPages(webp), (error) => error instanceof ImageFormatError && error.code === 'decode');
});

test('several pictures become one PDF with one page each, every page the bundle size', async () => {
  const bytes = await imagesToPdf([{ bytes: fx.makePng(40, 60), kind: 'png' }, { bytes: fx.makePng(80, 30), kind: 'png' }, { bytes: fx.makePng(5, 5), kind: 'png' }]);
  const r = await loadPdf(bytes);
  assert.equal(r.pageCount, 3);
  for (let i = 0; i < 3; i++) {
    const { width, height } = r.doc.getPage(i).getSize();
    assert.ok(Math.abs(width - 595.28) < 0.1 && Math.abs(height - 841.89) < 0.1);
  }
  await assert.rejects(() => imagesToPdf([]), /No pictures/);
});
