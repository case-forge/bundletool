/**
 * What a file really is, decided from its own bytes and never from its name.
 *
 * A name is chosen by whoever saved the file (or renamed it), so it says nothing reliable: a photo
 * called scan.pdf, a PDF called scan.jpg and a program called scan.pdf all reach the page. This module
 * reads the first bytes (and, for a zip, its directory) and returns a kind that the rest of the
 * intake routes on.
 *
 * Nothing here opens, decodes or runs the file. A zip is only inspected through its directory, so a
 * zip bomb (a small file that would expand to gigabytes) is recognised before anything inflates it.
 */

/** Bytes read from the start of a file to decide what it is. */
export const HEAD_BYTES = 4096;

const ascii = (bytes, from, to) => {
  let s = '';
  for (let i = from; i < Math.min(to, bytes.length); i++) s += String.fromCharCode(bytes[i]);
  return s;
};

/**
 * Kinds returned by sniffHead:
 *   'pdf' | 'jpeg' | 'png' | 'gif' | 'bmp' | 'webp' | 'tiff' | 'avif' | 'heic'
 *   'zip'      a zip container (its directory decides whether it is a Word document, see inspectZip)
 *   'ole'      an older Office file, or an Office file with a password (a compound document)
 *   'exe'      a program (Windows or Linux) or a script with a shebang
 *   'shortcut' a Windows shortcut
 *   'html' | 'svg' | 'text'
 *   'empty'    no bytes at all
 *   'unknown'  anything else
 *
 * @param {Uint8Array} head the first bytes of the file (HEAD_BYTES is enough)
 * @returns {string}
 */
export function sniffHead(head) {
  const n = head.length;
  if (n === 0) return 'empty';
  // A PDF header may sit anywhere in the first 1,024 bytes (the PDF specification allows leading junk).
  if (ascii(head, 0, 1024).includes('%PDF-')) return 'pdf';
  if (n > 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (n > 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (n > 6 && ascii(head, 0, 4) === 'GIF8') return 'gif';
  if (n > 14 && head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
  if (n > 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'webp';
  if (n > 8 && ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00)
             || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a))) return 'tiff';
  if (n > 12 && ascii(head, 4, 8) === 'ftyp') {
    const major = ascii(head, 8, 12);
    if (major === 'avif' || major === 'avis') return 'avif';
    const boxEnd = Math.min(n, ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0);
    let compatible = '';
    for (let i = 16; i + 4 <= boxEnd; i += 4) compatible += ascii(head, i, i + 4) + ' ';
    if (/\bavif\b/.test(compatible)) return 'avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(major)) return 'heic';
  }
  if (n > 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)) return 'zip';
  if (n > 8 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0
      && head[4] === 0xa1 && head[5] === 0xb1 && head[6] === 0x1a && head[7] === 0xe1) return 'ole';
  if (n > 4 && head[0] === 0x4d && head[1] === 0x5a) return 'exe';                                 // MZ
  if (n > 4 && head[0] === 0x7f && ascii(head, 1, 4) === 'ELF') return 'exe';
  if (n > 4 && head[0] === 0xcf && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe) return 'exe';   // Mach-O
  if (n > 2 && head[0] === 0x23 && head[1] === 0x21) return 'exe';                                 // #! script
  if (n > 8 && head[0] === 0x4c && head[1] === 0 && head[2] === 0 && head[3] === 0 && head[4] === 0x01 && head[5] === 0x14 && head[6] === 0x02) return 'shortcut';

  // Text kinds. Skip a byte-order mark and leading whitespace, then look at what it opens with.
  let start = 0;
  if (n > 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) start = 3;
  const text = ascii(head, start, Math.min(n, start + 600)).replace(/^\s+/, '').toLowerCase();
  if (/^<\?xml[^>]*\?>\s*<svg[\s>]|^<svg[\s>]/.test(text) || (text.startsWith('<?xml') && text.includes('<svg'))) return 'svg';
  if (/^<!doctype html|^<html|^<head|^<body|^<script/.test(text)) return 'html';
  // Mostly printable ASCII and no NUL bytes: plain text (a .txt, .csv, .eml, .rtf ...).
  let printable = 0;
  const sample = Math.min(n, 1024);
  for (let i = 0; i < sample; i++) {
    const b = head[i];
    if (b === 0) return 'unknown';
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc2) printable++;
  }
  return printable / sample > 0.95 ? 'text' : 'unknown';
}

// ─── Zip directory ───────────────────────────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const utf8 = new TextDecoder('utf-8', { fatal: false });

/**
 * Reads a zip's directory from its last bytes and the directory itself, without inflating anything.
 *
 * @param {Uint8Array} tail the last bytes of the file (up to 65,557 are needed to hold the end record)
 * @param {(offset: number, length: number) => Promise<Uint8Array>} readAt reads the directory
 * @param {number} fileSize
 * @param {number} tailStart the file offset at which `tail` begins
 * @param {{maxDirectoryBytes?: number}} [opts]
 * @returns {Promise<{entries: Array<{name: string, compressed: number, size: number, method: number, offset: number}>, count: number}
 *                  | {error: 'notzip'|'zip64'|'toomany'|'baddirectory'}>}
 */
export async function readZipDirectory(tail, readAt, fileSize, tailStart, opts = {}) {
  const maxDirectoryBytes = opts.maxDirectoryBytes ?? 8 * 1024 * 1024;
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return { error: 'notzip' };
  const count = dv.getUint16(eocd + 10, true);
  const dirSize = dv.getUint32(eocd + 12, true);
  const dirOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) return { error: 'zip64' };
  if (dirSize > maxDirectoryBytes || dirOffset + dirSize > fileSize) return { error: 'baddirectory' };
  const dir = dirOffset >= tailStart && dirOffset + dirSize <= tailStart + tail.length
    ? tail.subarray(dirOffset - tailStart, dirOffset - tailStart + dirSize)
    : await readAt(dirOffset, dirSize);
  const d = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries = [];
  let p = 0;
  while (p + 46 <= dir.length && d.getUint32(p, true) === CD_SIG) {
    const method = d.getUint16(p + 10, true);
    const compressed = d.getUint32(p + 20, true);
    const size = d.getUint32(p + 24, true);
    const nameLen = d.getUint16(p + 28, true);
    const extraLen = d.getUint16(p + 30, true);
    const commentLen = d.getUint16(p + 32, true);
    const offset = d.getUint32(p + 42, true);
    if (p + 46 + nameLen > dir.length) return { error: 'baddirectory' };
    entries.push({ name: utf8.decode(dir.subarray(p + 46, p + 46 + nameLen)), compressed, size, method, offset });
    p += 46 + nameLen + extraLen + commentLen;
    if (entries.length > 200000) return { error: 'toomany' };
  }
  if (entries.length !== count) return { error: 'baddirectory' };
  return { entries, count };
}

/**
 * What a zip container is, from its directory alone.
 *
 * @param {Array<{name: string, size: number}>} entries
 * @returns {'docx'|'docm'|'xlsx'|'pptx'|'odf'|'pages'|'zip'}
 */
export function zipFlavour(entries) {
  const names = new Set(entries.map((e) => e.name));
  if (names.has('word/document.xml') && names.has('[Content_Types].xml')) {
    return names.has('word/vbaProject.bin') ? 'docm' : 'docx';
  }
  if (names.has('xl/workbook.xml')) return 'xlsx';
  if (names.has('ppt/presentation.xml')) return 'pptx';
  if (names.has('mimetype') && names.has('content.xml')) return 'odf';
  if ([...names].some((n) => n.startsWith('Index/') && n.endsWith('.iwa'))) return 'pages';
  return 'zip';
}

/**
 * Totals for a Word document's directory, and the reasons (if any) it is too big to convert safely.
 *
 * @param {Array<{name: string, size: number, compressed: number}>} entries
 * @param {{maxEntries: number, maxTotalBytes: number, maxXmlBytes: number, maxMediaBytes: number}} limits
 * @returns {{total: number, xml: number, largestMedia: number, problem: null|'entries'|'total'|'xml'|'media'}}
 */
export function docxTotals(entries, limits) {
  let total = 0;
  let xml = 0;
  let largestMedia = 0;
  for (const e of entries) {
    total += e.size;
    if (e.name === 'word/document.xml') xml = e.size;
    if (e.name.startsWith('word/media/')) largestMedia = Math.max(largestMedia, e.size);
  }
  let problem = null;
  if (entries.length > limits.maxEntries) problem = 'entries';
  else if (total > limits.maxTotalBytes) problem = 'total';
  else if (xml > limits.maxXmlBytes) problem = 'xml';
  else if (largestMedia > limits.maxMediaBytes) problem = 'media';
  return { total, xml, largestMedia, problem };
}

/**
 * Reads the first `limit` bytes of one entry of a zip, inflating only as much as that needs.
 * Used to read a picture's size out of a Word document without expanding the picture.
 *
 * @param {Blob} blob the zip
 * @param {{offset: number, compressed: number, method: number}} entry
 * @param {number} limit
 * @returns {Promise<Uint8Array|null>} null when the entry cannot be read
 */
export async function readEntryHead(blob, entry, limit = 65536) {
  try {
    const local = new DataView(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer());
    if (local.getUint32(0, true) !== 0x04034b50) return null;
    const dataStart = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (entry.method === 0) return new Uint8Array(await blob.slice(dataStart, dataStart + Math.min(limit, entry.compressed)).arrayBuffer());
    if (entry.method !== 8) return null;
    // Input is capped well above what `limit` output bytes need for any real picture header.
    const compressed = blob.slice(dataStart, dataStart + Math.min(entry.compressed, 1 << 20));
    const reader = compressed.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const out = [];
    let got = 0;
    while (got < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
      got += value.length;
    }
    await reader.cancel().catch(() => {});
    const merged = new Uint8Array(Math.min(got, limit));
    let at = 0;
    for (const chunk of out) {
      const take = Math.min(chunk.length, merged.length - at);
      merged.set(chunk.subarray(0, take), at);
      at += take;
      if (at >= merged.length) break;
    }
    return merged;
  } catch {
    return null;
  }
}

/**
 * Reads a file's kind from ranges of its bytes: the first bytes, and for a zip its directory. `read(start,
 * end)` returns those bytes; nothing else of the file is touched.
 *
 * @param {number} size
 * @param {(start: number, end: number) => Promise<Uint8Array>} read
 * @returns {Promise<{kind: string, zip?: {flavour: string, entries: Array<object>} | {error: string}}>}
 */
async function classifyRanges(size, read) {
  const kind = sniffHead(await read(0, HEAD_BYTES));
  if (kind !== 'zip') return { kind };
  const tailStart = Math.max(0, size - 65557);
  const tail = await read(tailStart, size);
  const dir = await readZipDirectory(
    tail,
    (offset, length) => read(offset, offset + length),
    size,
    tailStart,
  );
  if (dir.error) return { kind, zip: { error: dir.error } };
  return { kind, zip: { flavour: zipFlavour(dir.entries), entries: dir.entries } };
}

/**
 * Reads a Blob or File's kind: its first bytes, and for a zip its directory.
 *
 * @param {Blob} blob
 * @returns {Promise<{kind: string, zip?: {flavour: string, entries: Array<object>} | {error: string}}>}
 */
export function classifyBlob(blob) {
  return classifyRanges(blob.size, async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()));
}

/**
 * The same as classifyBlob() for bytes already in memory, without copying them: wrapping a whole file in
 * `new Blob([bytes])` copies all of it, and the command line holds files of up to 200 MB.
 *
 * @param {Uint8Array} bytes
 */
export function classifyBytes(bytes) {
  return classifyRanges(bytes.length, async (start, end) => bytes.subarray(start, end));
}
