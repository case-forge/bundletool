/**
 * Strict checks of TIFF picture data: PackBits, LZW, Deflate and CCITT fax (Group 3, Group 4 and
 * modified Huffman) strips are decoded here only to prove they are whole, and a JPEG strip's structure
 * is checked. The decoder that makes the pixels (utif2) reports nothing when a strip is damaged, so a
 * scan with a flipped bit or a cut strip would come out with a black block or garbage. These functions
 * read the strip the way the format defines it and say what is wrong: an invalid code, a row that
 * overruns its width, data that stops early or that decodes to fewer bytes or rows than the strip
 * should hold.
 *
 * A page that decodes cleanly is never refused, whatever it looks like: a blank scan is a valid scan.
 * Nothing here draws a pixel and there are no imports, so it runs in the TIFF worker and under test.
 *
 * Every validator returns null when the data is whole, or a short reason when it is not.
 */

// Modified Huffman code tables of ITU-T T.4 / T.6, as bit strings in run-length order. Copied from the
// table strings in utif2 (MIT, already recorded in NOTICE); nothing else is taken from it.
const WHITE_TERM = '00110101,000111,0111,1000,1011,1100,1110,1111,10011,10100,00111,01000,001000,000011,110100,110101,101010,101011,0100111,0001100,0001000,0010111,0000011,0000100,0101000,0101011,0010011,0100100,0011000,00000010,00000011,00011010,00011011,00010010,00010011,00010100,00010101,00010110,00010111,00101000,00101001,00101010,00101011,00101100,00101101,00000100,00000101,00001010,00001011,01010010,01010011,01010100,01010101,00100100,00100101,01011000,01011001,01011010,01011011,01001010,01001011,00110010,00110011,00110100'.split(',');
const BLACK_TERM = '0000110111,010,11,10,011,0011,0010,00011,000101,000100,0000100,0000101,0000111,00000100,00000111,000011000,0000010111,0000011000,0000001000,00001100111,00001101000,00001101100,00000110111,00000101000,00000010111,00000011000,000011001010,000011001011,000011001100,000011001101,000001101000,000001101001,000001101010,000001101011,000011010010,000011010011,000011010100,000011010101,000011010110,000011010111,000001101100,000001101101,000011011010,000011011011,000001010100,000001010101,000001010110,000001010111,000001100100,000001100101,000001010010,000001010011,000000100100,000000110111,000000111000,000000100111,000000101000,000001011000,000001011001,000000101011,000000101100,000001011010,000001100110,000001100111'.split(',');
const WHITE_MAKEUP = '11011,10010,010111,0110111,00110110,00110111,01100100,01100101,01101000,01100111,011001100,011001101,011010010,011010011,011010100,011010101,011010110,011010111,011011000,011011001,011011010,011011011,010011000,010011001,010011010,011000,010011011'.split(',');
const BLACK_MAKEUP = '0000001111,000011001000,000011001001,000001011011,000000110011,000000110100,000000110101,0000001101100,0000001101101,0000001001010,0000001001011,0000001001100,0000001001101,0000001110010,0000001110011,0000001110100,0000001110101,0000001110110,0000001110111,0000001010010,0000001010011,0000001010100,0000001010101,0000001011010,0000001011011,0000001100100,0000001100101'.split(',');
const EXT_MAKEUP = '00000001000,00000001100,00000001101,000000010010,000000010011,000000010100,000000010101,000000010110,000000010111,000000011100,000000011101,000000011110,000000011111'.split(',');

/** Lookup arrays indexed by (code length << 13 | code value); the value is the run length or -1. */
function buildLookup(term, makeup, extended) {
  const table = new Int16Array(14 << 13).fill(-1);
  const add = (codes, base, step) => codes.forEach((bits, i) => {
    table[(bits.length << 13) | parseInt(bits, 2)] = base + i * step;
  });
  add(term, 0, 1);
  add(makeup, 64, 64);
  add(extended, 1792, 64);
  return table;
}
const WHITE = buildLookup(WHITE_TERM, WHITE_MAKEUP, EXT_MAKEUP);
const BLACK = buildLookup(BLACK_TERM, BLACK_MAKEUP, EXT_MAKEUP);

/** The two-dimensional mode codes of Group 4: bit string to [kind, offset]. */
const MODES = {
  '1': ['V', 0], '011': ['V', 1], '000011': ['V', 2], '0000011': ['V', 3],
  '010': ['V', -1], '000010': ['V', -2], '0000010': ['V', -3],
  '0001': ['P', 0], '001': ['H', 0],
};

class Ended extends Error {}
class Bad extends Error {}

/** Reads bits from bytes[start, end), most significant bit first, or least first for FillOrder 2. */
class Bits {
  constructor(bytes, start, end, lsbFirst) {
    this.bytes = bytes;
    this.pos = start * 8;
    this.end = end * 8;
    this.lsb = lsbFirst;
  }
  get left() { return this.end - this.pos; }
  bit() {
    if (this.pos >= this.end) throw new Ended();
    const byte = this.bytes[this.pos >> 3];
    const shift = this.lsb ? (this.pos & 7) : 7 - (this.pos & 7);
    this.pos++;
    return (byte >> shift) & 1;
  }
  peek(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const p = this.pos + i;
      if (p >= this.end) return -1;
      const byte = this.bytes[p >> 3];
      v = (v << 1) | ((byte >> (this.lsb ? (p & 7) : 7 - (p & 7))) & 1);
    }
    return v;
  }
  align() { this.pos = Math.min(this.end, (this.pos + 7) & ~7); }
}

/** One run length (make-up codes then a terminating code) of the given colour: 0 white, 1 black. */
function readRun(bits, colour, limit) {
  const table = colour ? BLACK : WHITE;
  let total = 0;
  for (;;) {
    let code = 0;
    let len = 0;
    let run = -1;
    while (len < 13) {
      code = (code << 1) | bits.bit();
      len++;
      run = table[(len << 13) | code];
      if (run >= 0) break;
    }
    if (run < 0) throw new Bad('a fax code that does not exist');
    total += run;
    if (total > limit) throw new Bad('a run longer than the row');
    if (run < 64) return total;
  }
}

/** Reads one row of one-dimensional runs; returns its changing elements. */
function readRow1D(bits, width) {
  const changes = [];
  let at = 0;
  let colour = 0;
  while (at < width) {
    const run = readRun(bits, colour, width - at);
    at += run;
    if (at < width) changes.push(at);
    colour ^= 1;
  }
  return changes;
}

/** Reads one two-dimensional (Group 4 style) row against the row above; returns its changing elements. */
function readRow2D(bits, width, reference) {
  const ref = reference.concat([width, width]);
  const cur = [];
  let a0 = -1;
  let colour = 0;
  let i = 0;
  while (a0 < width) {
    // b1: the first change on the reference row to the right of a0 that is to the opposite colour.
    while (i > 0 && ref[i - 1] > a0) i--;
    while (i < ref.length - 1 && (ref[i] <= a0 || (i & 1) !== colour)) i++;
    const b1 = ref[i];
    const b2 = ref[Math.min(i + 1, ref.length - 1)];
    let code = '';
    let mode = null;
    while (!mode) {
      code += bits.bit();
      mode = MODES[code];
      if (!mode && code.length >= 7) throw new Bad('a fax mode code that does not exist');
    }
    if (mode[0] === 'P') {
      a0 = b2;
    } else if (mode[0] === 'V') {
      const a1 = b1 + mode[1];
      if (a1 < 0 || a1 > width || (a0 >= 0 ? a1 <= a0 : a1 < 0)) throw new Bad('a fax change outside the row');
      if (a1 < width) cur.push(a1);
      a0 = a1;
      colour ^= 1;
    } else {
      const start = Math.max(a0, 0);
      const first = readRun(bits, colour, width - start);
      const second = readRun(bits, colour ^ 1, width - start - first);
      const a1 = start + first;
      const a2 = a1 + second;
      if (a1 < width) cur.push(a1);
      if (a2 < width) cur.push(a2);
      a0 = a2;
    }
  }
  return cur;
}

/** Skips an end-of-line code (eleven or more zeros then a one) if one is next. Returns true if it did. */
function skipEol(bits) {
  let zeros = 0;
  while (bits.peek(zeros + 1) === 0) zeros++;
  if (bits.peek(zeros + 1) === 1 && zeros >= 11) {
    bits.pos += zeros + 1;
    return true;
  }
  return false;
}

/**
 * CCITT fax strip: compression 2 (modified Huffman, rows byte-aligned), 3 (Group 3, one- or
 * two-dimensional, with or without end-of-line codes) or 4 (Group 4).
 * @returns {string|null}
 */
export function checkFaxStrip(bytes, start, end, width, rows, compression, { lsbFirst = false, t4Options = 0 } = {}) {
  const bits = new Bits(bytes, start, end, lsbFirst);
  let reference = [];
  try {
    for (let row = 0; row < rows; row++) {
      if (compression === 4) {
        reference = readRow2D(bits, width, reference);
      } else if (compression === 2) {
        reference = readRow1D(bits, width);
        bits.align();
      } else {
        const eol = skipEol(bits);
        if (eol && skipEol(bits)) return 'the strip ends before its last row';   // a return-to-control code: no more rows
        let oneD = true;
        if (t4Options & 1) oneD = bits.bit() === 1;
        reference = oneD ? readRow1D(bits, width) : readRow2D(bits, width, reference);
      }
    }
  } catch (error) {
    if (error instanceof Ended) return 'the strip ends before its last row';
    if (error instanceof Bad) return error.message;
    throw error;
  }
  return null;
}

/** PackBits strip: runs must fit the strip exactly and inflate to at least the bytes the rows need. */
export function checkPackBitsStrip(bytes, start, end, expected, slack = 0) {
  let i = start;
  let out = 0;
  while (i < end) {
    const n = (bytes[i++] << 24) >> 24;
    if (n >= 0) {
      if (i + n + 1 > end) return 'a run of literal bytes that is cut off';
      i += n + 1;
      out += n + 1;
    } else if (n !== -128) {
      if (i + 1 > end) return 'a repeat run that is cut off';
      i += 1;
      out += 1 - n;
    }
  }
  if (out < expected) return 'the strip holds fewer bytes than its rows need';
  return out > expected + slack ? 'the strip holds more bytes than its rows need' : null;
}

/** TIFF LZW strip (MSB first, early change): every code must be defined and the output long enough. */
export function checkLzwStrip(bytes, start, end, expected, slack = 0) {
  if (end - start >= 2 && bytes[start] === 0 && (bytes[start + 1] & 1)) return null;   // the obsolete LSB-first form: not checked
  const lengths = new Uint16Array(4096);
  for (let c = 0; c < 256; c++) lengths[c] = 1;
  let width = 9;
  let next = 258;
  let previous = -1;
  let out = 0;
  let acc = 0;
  let have = 0;
  let i = start;
  for (;;) {
    while (have < width && i < end) { acc = ((acc << 8) | bytes[i++]) >>> 0; have += 8; if (have > 24) break; }
    if (have < width) break;   // out of data: fine if the output is already long enough
    const code = (acc >>> (have - width)) & ((1 << width) - 1);
    have -= width;
    acc &= (1 << have) - 1;
    if (code === 256) { width = 9; next = 258; previous = -1; continue; }
    if (code === 257) break;
    let length;
    if (previous < 0) {
      if (code >= 256) return 'a code that is not defined yet at the start of a block';
      length = 1;
    } else if (code < next) {
      length = lengths[code];
      if (next < 4096) lengths[next++] = lengths[previous] + 1;
    } else if (code === next && next < 4096) {
      length = lengths[previous] + 1;
      lengths[next++] = length;
    } else {
      return 'a code that is not in the table';
    }
    out += length;
    previous = code;
    if (next >= 4094) width = 12;
    else if (next >= 2047) width = 12;
    else if (next >= 1023) width = 11;
    else if (next >= 511) width = 10;
  }
  if (out < expected) return 'the strip decodes to fewer bytes than its rows need';
  return out > expected + slack ? 'the strip decodes to more bytes than its rows need' : null;
}

// --- Deflate ---------------------------------------------------------------------------------

/** Length and distance bases and extra bits, RFC 1951 section 3.2.5. */
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman table from code lengths: [counts per length, symbols in code order], or null if the lengths cannot be a code. */
function huffman(lengths) {
  const counts = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) return null;   // over-subscribed
  }
  const offsets = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len] + counts[len];
  const symbols = new Uint16Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) if (lengths[sym]) symbols[offsets[lengths[sym]]++] = sym;
  let used = 0;
  for (let len = 1; len < 16; len++) used += counts[len];
  return { counts, symbols, incomplete: left > 0, used };
}

const FIXED = (() => {
  const lit = new Uint8Array(288);
  lit.fill(8, 0, 144); lit.fill(9, 144, 256); lit.fill(7, 256, 280); lit.fill(8, 280, 288);
  return { lit: huffman(lit), dist: huffman(new Uint8Array(30).fill(5)) };
})();

/**
 * Deflate (zlib) strip, compression 8 or 32946: the stream must be well formed from header to
 * checksum and inflate to exactly the bytes the rows need. Read with a small inflater of our own that
 * reports what pako and the decoder do not: a truncated or corrupted stream, a bad back reference and
 * a checksum that does not match.
 */
export function checkDeflateStrip(bytes, start, end, expected, slack = 0) {
  if (end - start < 6) return 'the strip is too short to be a compressed stream';
  const cmf = bytes[start];
  const flg = bytes[start + 1];
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20)) return 'the compressed header is not valid';
  const limit = expected + slack;
  const out = new Uint8Array(limit);
  let n = 0;
  let pos = start + 2;
  let bitBuf = 0;
  let bitCnt = 0;
  const need = (bits) => {
    while (bitCnt < bits) {
      if (pos >= end - 4) throw 'the compressed data is cut off';   // the last four bytes are the checksum
      bitBuf |= bytes[pos++] << bitCnt;
      bitCnt += 8;
    }
  };
  const getBits = (bits) => {
    if (bits === 0) return 0;
    need(bits);
    const v = bitBuf & ((1 << bits) - 1);
    bitBuf >>>= bits;
    bitCnt -= bits;
    return v;
  };
  const decode = (table) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= getBits(1);
      const count = table.counts[len];
      if (code - count < first) return table.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw 'a code that is not in the table';
  };
  try {
    let last = 0;
    do {
      last = getBits(1);
      const type = getBits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        if (pos + 4 > end) throw 'the compressed data is cut off';
        const len = bytes[pos] | (bytes[pos + 1] << 8);
        const nlen = bytes[pos + 2] | (bytes[pos + 3] << 8);
        pos += 4;
        if ((len ^ 0xffff) !== nlen) throw 'a stored block with a wrong length';
        if (pos + len > end) throw 'the compressed data is cut off';
        if (n + len > limit) throw 'more bytes than the rows need';
        out.set(bytes.subarray(pos, pos + len), n);
        n += len;
        pos += len;
      } else if (type === 1 || type === 2) {
        let lit = FIXED.lit;
        let dist = FIXED.dist;
        if (type === 2) {
          const nlen = getBits(5) + 257;
          const ndist = getBits(5) + 1;
          const ncode = getBits(4) + 4;
          if (nlen > 286 || ndist > 30) throw 'a block with too many codes';
          const cl = new Uint8Array(19);
          for (let i = 0; i < ncode; i++) cl[CL_ORDER[i]] = getBits(3);
          const clTable = huffman(cl);
          if (!clTable || clTable.incomplete) throw 'a block with a wrong code table';
          const lengths = new Uint8Array(nlen + ndist);
          for (let i = 0; i < nlen + ndist;) {
            const sym = decode(clTable);
            if (sym < 16) { lengths[i++] = sym; continue; }
            let prev = 0;
            let rep;
            if (sym === 16) {
              if (i === 0) throw 'a block with a wrong code table';
              prev = lengths[i - 1];
              rep = 3 + getBits(2);
            } else if (sym === 17) rep = 3 + getBits(3);
            else rep = 11 + getBits(7);
            if (i + rep > nlen + ndist) throw 'a block with a wrong code table';
            while (rep--) lengths[i++] = prev;
          }
          if (lengths[256] === 0) throw 'a block with no end code';
          lit = huffman(lengths.subarray(0, nlen));
          dist = huffman(lengths.subarray(nlen));
          // An incomplete code is only allowed for a single code (or, for distances, none at all).
          if (!lit || !dist || (lit.incomplete && lit.used !== 1) || (dist.incomplete && dist.used > 1)) throw 'a block with a wrong code table';
        }
        for (;;) {
          const sym = decode(lit);
          if (sym < 256) {
            if (n >= limit) throw 'more bytes than the rows need';
            out[n++] = sym;
          } else if (sym === 256) {
            break;
          } else {
            const li = sym - 257;
            if (li >= 29) throw 'a code that is not in the table';
            const len = LEN_BASE[li] + getBits(LEN_EXTRA[li]);
            const di = decode(dist);
            if (di >= 30) throw 'a code that is not in the table';
            const distance = DIST_BASE[di] + getBits(DIST_EXTRA[di]);
            if (distance > n) throw 'a back reference to data that is not there';
            if (n + len > limit) throw 'more bytes than the rows need';
            for (let k = 0; k < len; k++, n++) out[n] = out[n - distance];
          }
        }
      } else {
        throw 'a block of an unknown kind';
      }
    } while (!last);
    // Whole bytes only from here: drop the unused bits of the last byte read.
    bitBuf = 0; bitCnt = 0;
    if (pos + 4 > end) throw 'the checksum is missing';
    const trailer = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    let a = 1;
    let b = 0;
    for (let i = 0; i < n; i++) { a = (a + out[i]) % 65521; b = (b + a) % 65521; }
    if ((((b << 16) | a) >>> 0) !== trailer) throw 'the checksum does not match';
  } catch (reason) {
    if (typeof reason === 'string') return reason;
    return 'the compressed data could not be read';
  }
  return n < expected ? 'the strip inflates to fewer bytes than its rows need' : null;
}

// --- JPEG in TIFF ------------------------------------------------------------------------------

/**
 * JPEG strip (compression 7): starts with a start-of-image marker, carries a frame header whose size is
 * the strip's, walks its segments to the scan, and ends with an end-of-image marker. A strip written
 * with shared tables (tag 347) leaves the tables out; the frame and scan are still in the strip.
 */
export function checkJpegStrip(bytes, start, end, width, rows) {
  if (end - start < 4 || bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) return 'the picture data does not start as a JPEG';
  let i = start + 2;
  let frame = null;
  let scan = false;
  while (i + 4 <= end) {
    if (bytes[i] !== 0xff) return 'the JPEG data has a stray byte where a marker should be';
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > end) return 'a JPEG segment that is cut off';
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) return 'a JPEG frame header that is cut short';
      frame = { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    if (marker === 0xda) {
      scan = true;
      i += 2 + length;
      // Entropy-coded data: byte stuffing and restart markers, until the next real marker.
      while (i + 1 < end) {
        if (bytes[i] === 0xff && bytes[i + 1] !== 0x00 && !(bytes[i + 1] >= 0xd0 && bytes[i + 1] <= 0xd7) && bytes[i + 1] !== 0xff) break;
        i++;
      }
      continue;
    }
    i += 2 + length;
  }
  if (!frame) return 'the JPEG data has no frame header';
  if (!scan) return 'the JPEG data has no picture scan';
  if (frame.width !== width) return 'the JPEG width is not the strip width';
  if (frame.height !== 0 && frame.height !== rows) return 'the JPEG height is not the strip height';
  // Ends with an end-of-image marker (a few zero pad bytes after it are tolerated).
  let tail = end;
  while (tail > start + 2 && bytes[tail - 1] === 0) tail--;
  if (!(bytes[tail - 2] === 0xff && bytes[tail - 1] === 0xd9)) return 'the JPEG data is cut off before its end';
  return null;
}

/** A strip may hold a few bytes more than its rows need (padding some writers add); a corrupt one usually holds many more. */
const SLACK = 3;

const first = (tag) => (tag && tag.length ? tag[0] : 0);

/**
 * Checks every strip or tile of one page whose compression can be checked. Returns null when all
 * are whole, or a short reason.
 */
export function checkPageData(ifd, buffer) {
  const compression = first(ifd.t259) || 1;
  if (![2, 3, 4, 5, 7, 8, 32773, 32946].includes(compression)) return null;
  const bytes = new Uint8Array(buffer);
  const width = first(ifd.t256);
  const height = first(ifd.t257);
  const samples = first(ifd.t277) || 1;
  const bitsPer = (ifd.t258 && ifd.t258[0]) || 1;
  const planar = first(ifd.t284) === 2;
  const lsbFirst = first(ifd.t266) === 2;
  const t4Options = first(ifd.t292);
  const tiled = !!(ifd.t324 && ifd.t324.length);
  const offsets = tiled ? ifd.t324 : ifd.t273;
  const counts = tiled ? ifd.t325 : ifd.t279;
  if (!offsets || !counts) return null;
  const stripWidth = tiled ? first(ifd.t322) : width;
  const rowsPerStrip = tiled ? first(ifd.t323) : Math.min(first(ifd.t278) || height, height);
  if (!stripWidth || !rowsPerStrip) return null;
  const perPlane = planar ? samples : 1;
  const unitSamples = planar ? 1 : samples;
  const rowBytes = Math.ceil((stripWidth * unitSamples * bitsPer) / 8);
  const across = tiled ? Math.ceil(width / stripWidth) : 1;
  const down = Math.ceil(height / rowsPerStrip);
  const perImagePlane = tiled ? across * down : down;
  for (let n = 0; n < offsets.length; n++) {
    const inPlane = n % Math.max(perImagePlane, 1);
    const rows = tiled ? rowsPerStrip : Math.min(rowsPerStrip, height - Math.floor(inPlane) * rowsPerStrip);
    if (rows <= 0 || n >= perImagePlane * perPlane) continue;
    const start = offsets[n];
    const end = start + counts[n];
    let problem = null;
    if (compression === 32773) problem = checkPackBitsStrip(bytes, start, end, rows * rowBytes, SLACK);
    else if (compression === 5) problem = checkLzwStrip(bytes, start, end, rows * rowBytes, SLACK);
    else if (compression === 8 || compression === 32946) problem = checkDeflateStrip(bytes, start, end, rows * rowBytes, SLACK);
    else if (compression === 7) problem = checkJpegStrip(bytes, start, end, stripWidth, rows);
    else problem = checkFaxStrip(bytes, start, end, stripWidth, rows, compression, { lsbFirst, t4Options });
    if (problem) return problem;
  }
  return null;
}
