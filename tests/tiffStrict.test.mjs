/**
 * Strict TIFF strip checks (public/js/bundletoolTiffStrict.js). utif2 decodes a damaged PackBits, LZW
 * or CCITT fax strip without saying anything, so on its own a scan with a flipped bit or a zeroed run
 * would come out with a black block or garbage. The strips are read the way each compression defines,
 * and a page whose data is not whole is refused with a plain message. A page that decodes cleanly is
 * never refused, blank or not.
 *
 * The valid fixtures in tests/fixtures/tiff/ were written by libtiff through Pillow (see
 * make_fixtures.py there); the damaged files are made here, deterministically, from those.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectTiff, decodeTiffPage, TiffProblem } from '../public/js/bundletoolTiff.js';
import { checkPackBitsStrip, checkFaxStrip, checkDeflateStrip, checkJpegStrip } from '../public/js/bundletoolTiffStrict.js';
import zlib from 'node:zlib';

const { default: UTIF } = await import('../public/js/vendor/utif2.js');
const dir = new URL('./fixtures/tiff/', import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, dir));
const toBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

const VALID = fs.readdirSync(dir).filter((f) => f.endsWith('.tif')).sort();

test('every valid TIFF, in every compression, passes the strict checks and decodes', () => {
  assert.ok(VALID.length >= 15, 'the fixtures are there');
  for (const name of VALID) {
    const buffer = toBuffer(read(name));
    const pages = inspectTiff(UTIF, buffer);
    assert.ok(pages.length >= 1, name);
    for (const ifd of pages) {
      const page = decodeTiffPage(UTIF, buffer, ifd);
      assert.equal(page.rgba.length, page.width * page.height * 4, name);
    }
  }
});

test('a blank page and an all black page are valid scans, not damage', () => {
  for (const name of ['blank_group4.tif', 'blank_lzw.tif', 'black_group4.tif']) {
    const buffer = toBuffer(read(name));
    const [ifd] = inspectTiff(UTIF, buffer);
    const { rgba } = decodeTiffPage(UTIF, buffer, ifd);
    const first = rgba[0];
    assert.ok(rgba.every((v, i) => i % 4 === 3 || v === first), `${name} is one flat colour`);
  }
});

/** A small deterministic random source, so the damage is the same on every run. */
function random(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** Damages one strip of one page of a valid file in place: flip a bit, zero a stretch, or overwrite with noise. */
function damage(file, kind, rnd) {
  const out = Buffer.from(file);
  const ifds = UTIF.decode(toBuffer(out)).filter((i) => i.t256 && i.t257);
  const ifd = ifds[Math.floor(rnd() * ifds.length)];
  const n = Math.floor(rnd() * ifd.t273.length);
  const start = ifd.t273[n];
  const count = ifd.t279[n];
  if (kind === 0) out[start + Math.floor(rnd() * count)] ^= 1 << Math.floor(rnd() * 8);
  else {
    const length = Math.min(count - 1, kind === 1 ? 4 + Math.floor(rnd() * 60) : 8 + Math.floor(rnd() * 40));
    const at = start + Math.floor(rnd() * (count - length));
    if (kind === 1) out.fill(0, at, at + length);
    else for (let i = 0; i < length; i++) out[at + i] = Math.floor(rnd() * 256);
  }
  return out;
}

function refused(buffer) {
  try { inspectTiff(UTIF, buffer); return null; } catch (error) {
    assert.ok(error instanceof TiffProblem, 'a TiffProblem, never another error');
    return error;
  }
}

test('damaged fax strips (Group 4, Group 3, modified Huffman) are caught', () => {
  const rnd = random(11);
  const caught = [0, 0, 0];
  const total = [0, 0, 0];
  for (const name of ['group4_bw.tif', 'multipage_group4.tif', 'group3_bw.tif', 'rle_bw.tif']) {
    const file = read(name);
    for (let i = 0; i < 30; i++) {
      const kind = i % 3;
      const problem = refused(toBuffer(damage(file, kind, rnd)));
      total[kind]++;
      if (problem) {
        caught[kind]++;
        assert.equal(problem.code, 'damaged');
        assert.match(problem.message, /^This scan looks damaged: page \d+ could not be read completely\.$/);
      }
    }
  }
  // A stretch of zeros or noise is never a valid fax stream. One flipped bit can turn one valid code into
  // another, which is a different valid picture that no reader can tell from the original.
  assert.equal(caught[1], total[1], 'zeroed stretches');
  assert.ok(caught[2] / total[2] >= 0.95, `noise: ${caught[2]} of ${total[2]}`);
  assert.ok(caught[0] / total[0] >= 0.5, `flipped bits: ${caught[0]} of ${total[0]}`);
});

test('damaged LZW and PackBits strips are caught when the damage changes the strip\'s length or codes', () => {
  const rnd = random(23);
  let lzw = 0;
  let lzwTotal = 0;
  let packbits = 0;
  let packbitsTotal = 0;
  for (const name of ['lzw_grey.tif', 'lzw_rgb.tif', 'lzw_palette.tif', 'multipage_lzw.tif']) {
    for (let i = 0; i < 30; i++) { lzwTotal++; if (refused(toBuffer(damage(read(name), i % 3, rnd)))) lzw++; }
  }
  for (const name of ['packbits_grey.tif', 'packbits_bw.tif']) {
    for (let i = 0; i < 30; i++) { packbitsTotal++; if (refused(toBuffer(damage(read(name), i % 3, rnd)))) packbits++; }
  }
  // A flipped bit inside a run of literal bytes is a different valid pixel and no format can tell; the rest can.
  assert.ok(lzw / lzwTotal >= 0.8, `LZW: ${lzw} of ${lzwTotal} caught`);
  assert.ok(packbits / packbitsTotal >= 0.5, `PackBits: ${packbits} of ${packbitsTotal} caught`);
});

test('the message names the damaged page of a multi-page scan', () => {
  const file = read('multipage_group4.tif');
  const ifds = UTIF.decode(toBuffer(file)).filter((i) => i.t256 && i.t257);
  const bad = Buffer.from(file);
  bad.fill(0, ifds[1].t273[0], ifds[1].t273[0] + ifds[1].t279[0]);   // page 2 only
  const problem = refused(toBuffer(bad));
  assert.ok(problem);
  assert.match(problem.message, /page 2 /);
});

test('PackBits: runs must fit the strip and inflate to the rows they hold', () => {
  const good = Uint8Array.from([0xfd, 7, 1, 1, 2]);   // repeat 7 four times, then two literal bytes: 6 bytes
  assert.equal(checkPackBitsStrip(good, 0, good.length, 6), null);
  assert.match(checkPackBitsStrip(good, 0, good.length, 9), /fewer/);
  assert.match(checkPackBitsStrip(good, 0, good.length, 2), /more/);
  const cut = Uint8Array.from([5, 1, 2]);              // promises six literal bytes, holds two
  assert.match(checkPackBitsStrip(cut, 0, cut.length, 6), /cut off/);
});

test('fax: a strip that ends before its last row, or uses a code that does not exist, is reported', () => {
  const file = toBuffer(read('group4_bw.tif'));
  const [ifd] = inspectTiff(UTIF, file);
  const bytes = new Uint8Array(file);
  const start = ifd.t273[0];
  const count = ifd.t279[0];
  const width = ifd.t256[0];
  const rows = ifd.t257[0];
  assert.equal(checkFaxStrip(bytes, start, start + count, width, rows, 4), null);
  assert.match(checkFaxStrip(bytes, start, start + Math.floor(count / 2), width, rows, 4), /ends before/);
  assert.match(checkFaxStrip(bytes, start, start + count, width, rows + 5, 4), /ends before|does not exist/);
  const zeros = new Uint8Array(64);
  assert.match(checkFaxStrip(zeros, 0, 64, 300, 10, 4), /does not exist|ends before/);
});

test('damage inside a compressed strip decodes without error in utif2 alone, and the strict check refuses it', () => {
  // The same damage, given to the decoder alone, gives no error: the reason the strict checks exist.
  const file = read('group4_bw.tif');
  const bad = damage(file, 1, random(5));
  const buffer = toBuffer(bad);
  const ifds = UTIF.decode(buffer).filter((i) => i.t256 && i.t257);
  UTIF.decodeImage(buffer, ifds[0]);
  assert.doesNotThrow(() => UTIF.toRGBA8(ifds[0]));
  assert.ok(refused(toBuffer(bad)));
});

const DEFLATE = ['deflate_grey.tif', 'deflate_rgb_strips.tif', 'deflate_predictor.tif', 'deflate_bw_strips.tif'];
const JPEG = ['jpeg_rgb.tif', 'jpeg_grey.tif', 'jpeg_rgb_strips.tif'];

test('damaged Deflate strips are caught: the stream and its checksum must be whole', () => {
  const rnd = random(31);
  let caught = 0;
  let total = 0;
  for (const name of DEFLATE) {
    for (let i = 0; i < 30; i++) {
      total++;
      const problem = refused(toBuffer(damage(read(name), i % 3, rnd)));
      if (problem) {
        caught++;
        assert.equal(problem.code, 'damaged');
        assert.match(problem.message, /^This scan looks damaged: page \d+ could not be read completely\.$/);
      }
    }
  }
  // The checksum at the end of every zlib stream makes any change to the stream show, so nearly all are caught
  // (a zeroed stretch inside a run of zeros is the one change that is not a change).
  assert.ok(caught / total >= 0.95, `Deflate: ${caught} of ${total} caught`);
});

test('Deflate: the stream is checked from header to checksum, and against the rows it must fill', () => {
  const data = Buffer.from('the same paragraph again '.repeat(200));
  const good = zlib.deflateSync(data);
  const u8 = new Uint8Array(good);
  assert.equal(checkDeflateStrip(u8, 0, u8.length, data.length), null);
  assert.match(checkDeflateStrip(u8, 0, u8.length, data.length + 10), /fewer bytes/);
  assert.match(checkDeflateStrip(u8, 0, u8.length, data.length - 10), /more bytes/);
  assert.match(checkDeflateStrip(u8, 0, u8.length - 3, data.length), /cut off|checksum/);
  const badHeader = Uint8Array.from(u8); badHeader[0] = 0x00;
  assert.match(checkDeflateStrip(badHeader, 0, badHeader.length, data.length), /header/);
  const flipped = Uint8Array.from(u8); flipped[Math.floor(u8.length / 2)] ^= 0x10;
  assert.ok(checkDeflateStrip(flipped, 0, flipped.length, data.length));
  const badSum = Uint8Array.from(u8); badSum[badSum.length - 1] ^= 1;
  assert.match(checkDeflateStrip(badSum, 0, badSum.length, data.length), /checksum/);
});

test('Deflate: every valid stream node can write passes, whatever the level or strategy', () => {
  const rnd = random(77);
  for (const size of [0, 1, 300, 20000]) {
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i++) data[i] = (i * 13 + Math.floor(rnd() * 3)) & 255;
    for (const level of [0, 1, 6, 9]) {
      for (const strategy of [0, zlib.constants.Z_FIXED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE]) {
        const z = new Uint8Array(zlib.deflateSync(data, { level, strategy }));
        assert.equal(checkDeflateStrip(z, 0, z.length, size), null, `${size} bytes, level ${level}, strategy ${strategy}`);
      }
    }
  }
});

test('damaged JPEG strips inside a TIFF are caught when their start, frame, size or end is wrong', () => {
  let caught = 0;
  let total = 0;
  for (const name of JPEG) {
    for (let kind = 0; kind < 4; kind++) {
      const file = Buffer.from(read(name));
      const ifds = UTIF.decode(toBuffer(file)).filter((i) => i.t256 && i.t257);
      const start = ifds[0].t273[0];
      const end = start + ifds[0].t279[0];
      if (kind === 0) file.fill(0, start, start + 2);                     // the start-of-image marker
      else if (kind === 1) file.fill(0, end - 2, end);                     // the end-of-image marker
      else if (kind === 2) {                                               // the frame's width
        let i = start + 2;
        while (i < end && !(file[i] === 0xff && (file[i + 1] === 0xc0 || file[i + 1] === 0xc1))) i++;
        file[i + 7] ^= 0x01;
      } else file.fill(0, start + 2, start + 40);                          // the segments after the start marker
      total++;
      const problem = refused(toBuffer(file));
      if (problem) { caught++; assert.equal(problem.code, 'damaged'); }
    }
  }
  assert.equal(caught, total, `JPEG structure damage: ${caught} of ${total} caught`);
});

test('damage deep inside a JPEG scan is not caught: it is a different picture, not a broken structure', () => {
  // Stated here so nobody assumes more than the check does: it reads markers, frame and size, not the
  // entropy-coded data. (Deflate, LZW, PackBits and fax strips are read all the way through.)
  const file = Buffer.from(read('jpeg_grey.tif'));
  const [ifd] = UTIF.decode(toBuffer(file)).filter((i) => i.t256 && i.t257);
  file[ifd.t273[0] + Math.floor(ifd.t279[0] / 2)] ^= 0x10;
  assert.equal(refused(toBuffer(file)), null);
});

test('JPEG strip: start, frame, scan, size and end are each checked', () => {
  const file = toBuffer(read('jpeg_grey.tif'));
  const [ifd] = inspectTiff(UTIF, file);
  const bytes = new Uint8Array(file);
  const start = ifd.t273[0];
  const count = ifd.t279[0];
  const width = ifd.t256[0];
  const rows = ifd.t257[0];
  assert.equal(checkJpegStrip(bytes, start, start + count, width, rows), null);
  assert.match(checkJpegStrip(bytes, start, start + count, width + 1, rows), /width/);
  assert.match(checkJpegStrip(bytes, start, start + count, width, rows + 1), /height/);
  assert.match(checkJpegStrip(bytes, start, start + Math.floor(count / 2), width, rows), /cut off|segment/);
  assert.match(checkJpegStrip(bytes, start + 1, start + count, width, rows), /does not start/);
  const noEnd = Uint8Array.from(bytes.subarray(start, start + count)); noEnd[noEnd.length - 1] = 0x00; noEnd[noEnd.length - 2] = 0x00;
  assert.ok(checkJpegStrip(noEnd, 0, noEnd.length, width, rows));
});
