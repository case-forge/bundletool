/**
 * BundleTool test harness: synthetic PDF fixtures.
 *
 * Everything here is generated. No client material, and nothing read from disk
 * that was not written by this file.
 *
 * Each damaging function VERIFIES it actually damaged the file in the intended
 * way and throws if it did not. A generator that mistakes content-stream object
 * numbers for page object numbers silently produces undamaged "damaged"
 * fixtures, and the tests using them then pass for the wrong reason.
 */
import { PDFDocument, StandardFonts, rgb, degrees } from '@cantoo/pdf-lib';
import { createRequire } from 'node:module';
import { deflateSync as deflateSyncTop } from 'node:zlib';
const require = createRequire(import.meta.url);

const A4 = [595.28, 841.89];

/** A clean n-page PDF with identifiable text on each page. */
export async function makePdf(pageCount, label = 'DOC', { rotations = null, size = A4 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage(size);
    if (rotations) page.setRotation(degrees(rotations[i % rotations.length]));
    page.drawText(`${label} page ${i + 1}`, { x: 60, y: 700, size: 24, font, color: rgb(0, 0, 0) });
  }
  // useObjectStreams:false keeps objects individually addressable in the byte
  // stream, which the damaging functions below rely on.
  return doc.save({ useObjectStreams: false });
}

/** An encrypted PDF. Used only to prove it is refused. */
export async function makeEncryptedPdf(pageCount = 3) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    doc.addPage(A4).drawText(`SECRET page ${i + 1}`, { x: 60, y: 700, size: 24, font });
  }
  await doc.encrypt({ userPassword: 'user-pw', ownerPassword: 'owner-pw' });
  return doc.save();
}

const toStr = (bytes) => Buffer.from(bytes).toString('latin1');
const toBytes = (str) => new Uint8Array(Buffer.from(str, 'latin1'));

/**
 * The object numbers of the real page objects, read from /Kids rather than
 * guessed by scanning for /Type /Page: a non-greedy object regex runs past
 * object boundaries and returns content-stream numbers instead.
 */
export function pageObjectNumbers(bytes) {
  const s = toStr(bytes);
  const kids = s.match(/\/Kids\s*\[([^\]]*)\]/);
  if (!kids) throw new Error('fixture: no /Kids array found');
  return [...kids[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));
}

/** Object numbers of the content streams referenced by each page, in page order. */
export function contentObjectNumbers(bytes) {
  const s = toStr(bytes);
  return pageObjectNumbers(bytes).map((n) => {
    const obj = s.match(new RegExp(`(?:^|[^0-9])${n} 0 obj([\\s\\S]*?)endobj`));
    if (!obj) throw new Error(`fixture: page object ${n} not found`);
    const c = obj[1].match(/\/Contents\s*\[?\s*(\d+)\s+0\s+R/);
    if (!c) throw new Error(`fixture: page object ${n} has no /Contents ref`);
    return Number(c[1]);
  });
}

function deleteObject(s, num) {
  const re = new RegExp(`(?:^|\\n)${num} 0 obj[\\s\\S]*?endobj\\s*`);
  if (!re.test(s)) throw new Error(`fixture: object ${num} not found to delete`);
  return s.replace(re, '\n');
}

/**
 * Deletes the content streams of the given 1-based page numbers, leaving the
 * page objects intact. The pages survive; the ink does not: pdf-lib reports
 * these as ordinary pages, which is exactly why this fixture exists.
 */
export function damageContentStreams(bytes, pageNumbers) {
  const contentNums = contentObjectNumbers(bytes);
  let s = toStr(bytes);
  for (const p of pageNumbers) {
    const num = contentNums[p - 1];
    if (num == null) throw new Error(`fixture: no page ${p}`);
    s = deleteObject(s, num);
  }
  const out = toBytes(s);
  // Self-check: the named objects must really be gone, and the file smaller.
  const after = toStr(out);
  for (const p of pageNumbers) {
    const num = contentNums[p - 1];
    if (new RegExp(`(?:^|\\n)${num} 0 obj`).test(after)) {
      throw new Error(`fixture self-check failed: object ${num} survived deletion`);
    }
  }
  if (out.length >= bytes.length) throw new Error('fixture self-check failed: file did not shrink');
  return out;
}

/**
 * Deletes whole page objects while leaving /Kids pointing at them, so the page
 * tree still claims them.
 */
export function damagePageObjects(bytes, pageNumbers) {
  const pageNums = pageObjectNumbers(bytes);
  let s = toStr(bytes);
  for (const p of pageNumbers) {
    const num = pageNums[p - 1];
    if (num == null) throw new Error(`fixture: no page ${p}`);
    s = deleteObject(s, num);
  }
  const out = toBytes(s);
  const after = toStr(out);
  for (const p of pageNumbers) {
    if (new RegExp(`(?:^|\\n)${pageNums[p - 1]} 0 obj`).test(after)) {
      throw new Error(`fixture self-check failed: page object survived deletion`);
    }
  }
  return out;
}

/** Truncates the file, destroying the trailer and cross-reference table. */
export function truncate(bytes, fraction = 0.7) {
  const out = bytes.slice(0, Math.floor(bytes.length * fraction));
  if (toStr(out).includes('startxref')) {
    throw new Error('fixture self-check failed: truncation left startxref intact');
  }
  return out;
}

/** Points the startxref offset at nonsense, leaving the objects readable. */
export function corruptXrefOffset(bytes) {
  const s = toStr(bytes);
  if (!/startxref\s+\d+/.test(s)) throw new Error('fixture: no startxref to corrupt');
  return toBytes(s.replace(/startxref\s+\d+/, 'startxref\n999999999'));
}

/**
 * An owner-password-only PDF: the user password is BLANK, which is how court
 * seals and "no editing" exports arrive. Ordinary viewers open these without
 * prompting, and so must BundleTool.
 */
export async function makeOwnerOnlyEncryptedPdf(pageCount = 2) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    doc.addPage(A4).drawText(`SEALED page ${i + 1}`, { x: 60, y: 700, size: 24, font });
  }
  await doc.encrypt({ ownerPassword: 'owner-only-pw' });
  return doc.save();
}

/**
 * A tiny valid PNG, built by hand: Node's zlib provides the IDAT deflate and
 * the CRCs are computed here. Enough for embedPng; no image library needed.
 */
export function makePng(width = 4, height = 4) {
  const { deflateSync } = require('node:zlib');
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row[1 + x * 3] = 200; // reddish pixels
    rows.push(row);
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** Deterministic PRNG so the noise (and therefore sizes) is stable per seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A PNG of random pixels: deflate cannot compress noise, so it has weight. */
export function makeNoisePng(width, height, seed) {
  const rand = mulberry32(seed);
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width * 3; x++) row[1 + x] = Math.floor(rand() * 256);
    rows.push(row);
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSyncTop(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

