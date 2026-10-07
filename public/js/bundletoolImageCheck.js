/**
 * Structural checks for the two picture types a PDF embeds byte for byte, run BEFORE the bytes reach
 * pdf-lib.
 *
 * pdf-lib decodes a PNG itself, on the calling thread, and its inflate never returns on a damaged
 * deflate stream, so one truncated or scrambled PNG would freeze the tab for good (and a header
 * declaring hundreds of millions of pixels can take four gigabytes). A JPEG is not decoded by pdf-lib, but one cut
 * short still embeds and then prints as a grey or blank lower part. So a picture is checked here
 * first: its structure, its declared size, and (for a PNG) that its compressed data really inflates
 * to the picture it describes, within a time budget, in a way that yields to the page.
 *
 * No DOM, and the one import (crc32) is a plain function with no DOM of its own either: this file
 * runs in the page, in a worker and under Node.
 */

/** A picture that cannot be used. `code` is 'decode' (damaged, cut short, too slow) or 'toolarge'. */
export class ImageCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageCheckError';
    this.code = code;
  }
}

import { crc32 } from './bundletoolCrc32.js';

const damaged = (what) => new ImageCheckError('decode', `That picture is damaged: ${what}.`);
const cutShort = (what) => new ImageCheckError('decode', `That picture is cut short or damaged: ${what}.`);

const be32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const ascii4 = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** Bits per pixel for a PNG colour type and bit depth, or 0 when the pair is not allowed. */
function pngBitsPerPixel(colourType, depth) {
  const samples = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  const allowed = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[colourType];
  return samples && allowed.includes(depth) ? samples * depth : 0;
}

/** The size in bytes of a PNG's inflated picture data, filter bytes included. */
function pngRawSize(width, height, bitsPerPixel, interlaced) {
  const rowBytes = (w) => Math.ceil((w * bitsPerPixel) / 8);
  if (!interlaced) return height * (1 + rowBytes(width));
  // Adam7: seven passes, each a sub-image of its own.
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  let total = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.ceil((width - x0) / dx);
    const h = Math.ceil((height - y0) / dy);
    if (w > 0 && h > 0) total += h * (1 + rowBytes(w));
  }
  return total;
}

/**
 * Checks a PNG: signature, chunk structure and the checksums of the chunks that matter, a picture size
 * within `maxPixels`, and that the compressed picture data inflates to exactly what the header says.
 * The inflate is streamed, so the page stays responsive, and is given up on after `budgetMs`.
 *
 * @throws {ImageCheckError}
 */
export async function checkPng(bytes, { maxPixels = 100e6, budgetMs = 20000 } = {}) {
  const n = bytes.length;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (n < 33 || signature.some((v, i) => bytes[i] !== v)) throw damaged('it is not a complete PNG');

  let pos = 8;
  let header = null;
  let sawPalette = false;
  let sawEnd = false;
  const data = [];
  while (pos + 12 <= n) {
    const length = be32(bytes, pos);
    const type = ascii4(bytes, pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > n) throw cutShort('the file ends inside a block');
    const critical = bytes[pos + 4] >= 0x41 && bytes[pos + 4] <= 0x5a;
    if (pos === 8 && type !== 'IHDR') throw damaged('the header is missing');
    // The checksum of the headers and data that matter; a scrambled block fails it.
    if (critical && crc32(bytes, pos + 4, dataEnd) !== be32(bytes, dataEnd)) throw damaged('a block failed its checksum');
    if (type === 'IHDR') {
      if (length !== 13 || header) throw damaged('the header is malformed');
      header = {
        width: be32(bytes, dataStart), height: be32(bytes, dataStart + 4),
        depth: bytes[dataStart + 8], colourType: bytes[dataStart + 9],
        compression: bytes[dataStart + 10], filter: bytes[dataStart + 11], interlace: bytes[dataStart + 12],
      };
    } else if (type === 'PLTE') {
      sawPalette = true;
    } else if (type === 'IDAT') {
      data.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    pos = dataEnd + 4;
  }
  if (!header) throw damaged('the header is missing');
  if (!sawEnd) throw cutShort('the end of the file is missing');
  if (data.length === 0) throw damaged('it holds no picture data');

  const { width, height } = header;
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw damaged('its size is not valid');
  if (width * height > maxPixels) {
    throw new ImageCheckError('toolarge',
      `That picture is ${width} by ${height} pixels, which is too large to open in a browser. Reduce its size first.`);
  }
  const bitsPerPixel = pngBitsPerPixel(header.colourType, header.depth);
  if (!bitsPerPixel || header.compression !== 0 || header.filter !== 0 || header.interlace > 1) throw damaged('its header is not valid');
  if (header.colourType === 3 && !sawPalette) throw damaged('its colour table is missing');

  const expected = pngRawSize(width, height, bitsPerPixel, header.interlace === 1);
  if (typeof DecompressionStream === 'undefined') return;   // no stream API: the structure checks above are all there is
  const reader = new Blob(data).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const started = Date.now();
  let total = 0;
  try {
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch {
        throw damaged('its picture data does not decompress');
      }
      if (step.done) break;
      total += step.value.length;
      if (total >= expected) break;   // all of the picture is there; nothing after it matters
      if (Date.now() - started > budgetMs) throw new ImageCheckError('decode', 'That picture took too long to check and may be damaged.');
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (total < expected) throw cutShort('its picture data is incomplete');
}

/**
 * Checks a JPEG: a start marker, a frame header with a size, a scan, and the end-of-image marker that a
 * complete file carries. A file copied or downloaded only in part has no end marker, and the missing
 * part of the picture would print blank.
 *
 * @throws {ImageCheckError}
 */
export function checkJpeg(bytes) {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw damaged('it is not a complete JPEG');
  let i = 2;
  let sawFrame = false;
  let scanStart = -1;
  while (i + 4 <= n) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9) break;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > n) throw cutShort('the file ends inside a header');
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      if (!width || !height) throw damaged('its size is not valid');
      sawFrame = true;
    } else if (marker === 0xda) {
      scanStart = i + 2 + length;
      break;
    }
    i += 2 + length;
  }
  if (!sawFrame) throw damaged('its header is missing');
  if (scanStart < 0) throw cutShort('it holds no picture data');
  // Inside picture data an FF byte is always followed by 00 (a stuffed byte), a restart marker or the
  // next header, so FF D9 can only be the end of the image.
  for (let j = bytes.indexOf(0xff, scanStart); j !== -1 && j + 1 < n; j = bytes.indexOf(0xff, j + 1)) {
    if (bytes[j + 1] === 0xd9) return;
  }
  throw cutShort('the end of the file is missing');
}
