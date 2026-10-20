/**
 * TIFF checking and decoding, shared by the TIFF worker (workers/bundletoolTiffWorker.js) and by
 * the fallback that runs on the calling thread where there are no workers (the test suite).
 *
 * A TIFF from a scanner is trusted about nothing. Its header can declare pages of any size, its
 * strips can point past the end of the file, and a damaged compressed strip can make the decoder
 * spin. So a file is inspected first, from its tags alone, and refused before any pixel is
 * decoded if it is too big or does not hold the data it claims. The decode itself runs in a worker
 * (see bundletoolImages.js) so that a strip the decoder cannot get through cannot freeze the tab.
 *
 * The decoder (utif2) is passed in; the strict strip checks are a separate module (bundletoolTiffStrict.js).
 */
import { checkPageData } from './bundletoolTiffStrict.js';

// The TIFF decoder asks `window` whether a colour-management library is loaded before it converts a
// CMYK page (a print-shop scan), and a worker has no `window`, so without this every CMYK TIFF would
// be refused as "damaged". Naming the global lets the decoder fall back to its plain CMYK to RGB
// conversion.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

/** Most pixels one TIFF page may have. A4 at 600 dpi is 35 million; a 48 megapixel photo is 48 million. */
export const MAX_TIFF_PIXELS = 64e6;
/** Most pages one TIFF may have. A scanned bundle is a few hundred at most. */
export const MAX_TIFF_PAGES = 1000;

/** A TIFF that cannot be used. `code` is 'toolarge' or 'damaged'; `message` is safe to show. */
export class TiffProblem extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TiffProblem';
    this.code = code;
  }
}

const first = (tag) => (tag && tag.length ? tag[0] : 0);

/**
 * Checks that every strip or tile of a page lies inside the file. A TIFF cut short (an interrupted
 * copy or download) fails here instead of coming out as a blank page.
 */
function stripsFitInFile(ifd, fileLength) {
  const pairs = [[ifd.t273, ifd.t279], [ifd.t324, ifd.t325]];   // strips, then tiles
  let checked = false;
  for (const [offsets, counts] of pairs) {
    if (!offsets || !offsets.length) continue;
    checked = true;
    if (!counts || counts.length !== offsets.length) return false;
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i] + counts[i] > fileLength) return false;
    }
  }
  return checked;
}

/** How many bytes a PackBits strip inflates to, or -1 when its runs do not fit the strip. */
function packBitsLength(bytes, start, end) {
  let i = start;
  let out = 0;
  while (i < end) {
    const n = (bytes[i++] << 24) >> 24;
    if (n >= 0) {
      if (i + n + 1 > end) return -1;
      i += n + 1;
      out += n + 1;
    } else if (n !== -128) {
      if (i + 1 > end) return -1;
      i += 1;
      out += 1 - n;
    }
  }
  return out;
}

/**
 * Checks that the picture data a page has is as much as its size calls for. A strip that lies inside
 * the file is not enough: a file that declares 5000 by 5000 pixels but holds sixteen bytes of them
 * would decode to a white page. Uncompressed strips must add up to the whole picture, and PackBits
 * strips must run out to exactly the rows they hold. (LZW and fax strips cannot be counted without
 * decoding them; bundletoolTiffStrict.js does that, and the worker's time limit still catches a strip
 * that sends the decoder into a loop.)
 */
function dataCoversPage(ifd, buffer) {
  const compression = first(ifd.t259) || 1;
  if (compression !== 1 && compression !== 32773) return true;
  if (!ifd.t273 || !ifd.t279 || first(ifd.t284) === 2 || ifd.t324) return true;   // tiles and separate planes: not checked
  const width = first(ifd.t256);
  const height = first(ifd.t257);
  const samples = first(ifd.t277) || 1;
  const bits = (ifd.t258 && ifd.t258[0]) || 1;
  const rowBytes = Math.ceil((width * samples * bits) / 8);
  const perStrip = Math.min(first(ifd.t278) || height, height);
  if (compression === 1) {
    return ifd.t279.reduce((sum, count) => sum + count, 0) >= rowBytes * height;
  }
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < ifd.t273.length; i++) {
    const rows = Math.min(perStrip, height - i * perStrip);
    if (rows <= 0) continue;
    const out = packBitsLength(bytes, ifd.t273[i], ifd.t273[i] + ifd.t279[i]);
    if (out < rows * rowBytes) return false;
  }
  return true;
}

/**
 * Reads the page list of a TIFF and refuses anything that is too large or cut short. No pixel is
 * decoded here.
 *
 * @param {object} UTIF the decoder
 * @param {ArrayBuffer} buffer
 * @returns {object[]} the IFDs of the full-size pages, in order
 * @throws {TiffProblem}
 */
export function inspectTiff(UTIF, buffer) {
  let ifds;
  try {
    ifds = UTIF.decode(buffer);
  } catch {
    throw new TiffProblem('damaged', 'That TIFF could not be read. It may be damaged.');
  }
  // Thumbnails and other sub-images share the file with the pages: keep the full-size ones.
  const pages = ifds.filter((ifd) => first(ifd.t256) > 0 && first(ifd.t257) > 0
    && (!ifd.t254 || (ifd.t254[0] & 5) === 0));   // not a reduced-size copy or a mask
  if (pages.length === 0) throw new TiffProblem('damaged', 'That TIFF has no pages that can be read.');
  if (pages.length > MAX_TIFF_PAGES) {
    throw new TiffProblem('toolarge', `That TIFF has ${pages.length} pages, more than BundleTool will open at once.`);
  }
  for (const [index, ifd] of pages.entries()) {
    const width = first(ifd.t256);
    const height = first(ifd.t257);
    if (width * height > MAX_TIFF_PIXELS) {
      throw new TiffProblem('toolarge',
        `That TIFF has a page of ${width} by ${height} pixels, which is too large to open in a browser.`);
    }
    if (!stripsFitInFile(ifd, buffer.byteLength)) {
      throw new TiffProblem('damaged', 'That TIFF is incomplete or damaged: its picture data runs past the end of the file.');
    }
    if (!dataCoversPage(ifd, buffer)) {
      throw new TiffProblem('damaged', 'That TIFF is incomplete or damaged: it holds less picture data than its size calls for.');
    }
    // The strips are read the way their compression defines, so a flipped bit or a cut strip is caught
    // here instead of coming out as a black block. (A page that decodes cleanly is never refused.)
    const broken = checkPageData(ifd, buffer);
    if (broken) {
      throw new TiffProblem('damaged', `This scan looks damaged: page ${index + 1} could not be read completely.`);
    }
  }
  return pages;
}

/**
 * Decodes one page to RGBA, and says whether it is a black and white or grey scan.
 * The caller should drop the returned pixels as soon as it has encoded them.
 *
 * @returns {{rgba: Uint8Array, width: number, height: number, grey: boolean, orientation: number}}
 *   orientation is the TIFF Orientation tag (1 when absent): 3, 6 and 8 mean the scan is stored turned
 */
export function decodeTiffPage(UTIF, buffer, ifd) {
  UTIF.decodeImage(buffer, ifd);
  const width = ifd.width;
  const height = ifd.height;
  const rgba = UTIF.toRGBA8(ifd);
  ifd.data = null;   // the raw decoded strips are not needed after this
  if (!width || !height || rgba.length < width * height * 4) {
    throw new TiffProblem('damaged', 'That TIFF is damaged: a page did not decode to a full picture.');
  }
  return { rgba, width, height, grey: looksLikeGreyScan(rgba), orientation: first(ifd.t274) || 1 };
}

/** Black and white or grey pages read best as PNG; anything with many colours as JPEG. */
export function looksLikeGreyScan(rgba) {
  const seen = new Set();
  for (let i = 0; i < rgba.length; i += 4 * 97) {
    if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) return false;
    seen.add(rgba[i] >> 3);
    if (seen.size > 32) return false;
  }
  return true;
}
