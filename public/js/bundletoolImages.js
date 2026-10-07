/**
 * Photos: what BundleTool accepts, and how each one becomes pages a PDF can hold.
 *
 * A PDF can embed a JPEG or a PNG directly. Everything else is decoded here and
 * re-encoded as one of those two:
 *
 *   JPEG, PNG            kept byte for byte, so nothing is recompressed, unless the
 *                        JPEG carries an EXIF rotation (PDF viewers ignore it, so the
 *                        photo would print sideways) or the picture is far larger than
 *                        a page can show, in which case it is redrawn upright and/or
 *                        scaled down.
 *   WEBP, AVIF, GIF,     decoded by the browser itself (createImageBitmap), drawn on a
 *   BMP, HEIC/HEIF       white ground and saved as a JPEG (a PNG for GIF). The first
 *                        frame of an animated file is used. HEIC only opens in Safari;
 *                        any other browser gets ImageFormatError('heic').
 *   TIFF                 decoded by utif2 (MIT, loaded only when a TIFF is added), one
 *                        PDF page per TIFF page. Black and white and grey scans come out
 *                        as PNG (small, sharp text), colour as JPEG.
 *
 * The format is read from the bytes' own magic numbers, never the filename. This module
 * has no PDF code: bundletoolPages.js turns the pages it returns into a document.
 *
 * A picture that is passed through is checked first (bundletoolImageCheck.js): pdf-lib decodes a PNG
 * itself on the calling thread and never returns on a damaged one, and a JPEG cut short would print
 * with its lower part blank.
 */
import { exifOrientation } from '/js/shared/exif-orientation.js';
import { checkPng, checkJpeg, ImageCheckError } from './bundletoolImageCheck.js';
import { raceTimeout } from './bundletoolTimeout.js';
import { lazyImport, startWorker, watchForLazyLoadFailures } from '/js/shared/lazy-load.js';

/** Longest edge, in pixels, of a picture that is redrawn. A4 at 300 dpi is 3508. */
export const MAX_EDGE = 4000;
/** A picture is only redrawn for size when its longest edge is over this. */
export const REDRAW_ABOVE = 4200;
const JPEG_QUALITY = 0.92;
/**
 * Most pixels a picture may have and still be opened here. Opening a picture allocates four bytes
 * per pixel, so 100 million is 400 MB; beyond that a browser tab is likely to run out of memory
 * and lose the person's work. (A 48 megapixel phone photo is well inside it.)
 */
export const MAX_PIXELS = 100e6;
/** How long the browser is given to decode one picture before BundleTool gives up on it. */
const DECODE_TIMEOUT_MS = 60000;
/** Most pixels of a PNG that is embedded as it is when the browser will not redraw it smaller. */
export const PASS_THROUGH_PIXELS = 40e6;
/** How long a TIFF page may take to decode without any progress before BundleTool gives up. */
const TIFF_STALL_MS = 30000;

/** Extensions BundleTool accepts as photos (the Guide lists them). */
export const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif'];
const EXTENSION_RE = new RegExp(`\\.(${PHOTO_EXTENSIONS.join('|')})$`, 'i');
const MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/bmp', 'image/x-ms-bmp',
  'image/tiff', 'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence',
]);

/** Removes a photo extension from a file name. */
export function stripPhotoExtension(name) {
  return String(name).replace(EXTENSION_RE, '');
}

/** True for a file whose type or extension says it is a photo BundleTool accepts. */
export function isImageFile(file) {
  return MIME_TYPES.has(file?.type) || EXTENSION_RE.test(file?.name ?? '');
}

/**
 * A photo BundleTool could not use. `code` says why, `userMessage` is safe to show.
 *   'unsupported'  not a file type BundleTool reads (or a file that is not a picture)
 *   'heic'         a HEIC/HEIF photo in a browser that cannot open them
 *   'decode'       a recognised type that could not be read (damaged, cut short, or taking too long)
 *   'toolarge'     a picture with more pixels than a browser tab can safely open
 *   'load'         the TIFF reader could not be fetched (a connection problem, not the photo)
 */
export class ImageFormatError extends Error {
  constructor(code, userMessage) {
    super(userMessage);
    this.name = 'ImageFormatError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));

/**
 * Which picture format the bytes are: 'jpeg' | 'png' | 'gif' | 'bmp' | 'webp' | 'tiff'
 * | 'avif' | 'heic', or null.
 */
export function sniffImage(bytes) {
  const n = bytes.length;
  if (n > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (n > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (n > 6 && ascii(bytes, 0, 4) === 'GIF8') return 'gif';
  if (n > 14 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  if (n > 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (n > 8 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
             || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))) return 'tiff';
  if (n > 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const major = ascii(bytes, 8, 12);
    if (major === 'avif' || major === 'avis') return 'avif';
    const boxEnd = Math.min(n, ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0);
    let compatible = '';
    for (let i = 16; i + 4 <= boxEnd; i += 4) compatible += ascii(bytes, i, i + 4) + ' ';
    if (/\bavif\b/.test(compatible)) return 'avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(major)) return 'heic';
  }
  return null;
}

/**
 * Reads a JPEG's EXIF orientation (1 to 8, 1 when absent) and its pixel size.
 * @returns {{orientation: number, width: number, height: number}}
 */
export function readJpegInfo(bytes) {
  let orientation = 1;
  let width = 0;
  let height = 0;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) break;
    const start = i + 4;
    if (marker === 0xe1 && ascii(bytes, start, start + 6) === 'Exif\0\0') {
      const o = exifOrientation(bytes, start + 6, Math.min(bytes.length, i + 2 + len));
      if (o) orientation = o;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = (bytes[start + 1] << 8) | bytes[start + 2];
      width = (bytes[start + 3] << 8) | bytes[start + 4];
      break;   // the size follows the EXIF block, so there is nothing more to read
    } else if (marker === 0xda) {
      break;
    }
    i += 2 + len;
  }
  return { orientation, width, height };
}

/** A PNG's pixel size from its IHDR. */
export function readPngSize(bytes) {
  const be = (p) => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  return { width: be(16), height: be(20) };
}

/**
 * The pixel size of a picture, read from its header without decoding it, or null when the
 * header cannot be read. Used to refuse a picture that is too large before the browser is
 * asked to open it.
 * @returns {{width: number, height: number} | null}
 */
export function readImageSize(bytes, format) {
  const n = bytes.length;
  const le16 = (p) => bytes[p] | (bytes[p + 1] << 8);
  const le32 = (p) => (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) | 0;
  const be32 = (p) => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  switch (format) {
    case 'png': return n >= 24 ? readPngSize(bytes) : null;
    case 'jpeg': { const { width, height } = readJpegInfo(bytes); return width && height ? { width, height } : null; }
    case 'gif': return n >= 10 ? { width: le16(6), height: le16(8) } : null;
    case 'bmp': {
      if (n < 26) return null;
      if (le32(14) === 12) return { width: le16(18), height: le16(20) };   // the older OS/2 header
      return { width: Math.abs(le32(18)), height: Math.abs(le32(22)) };
    }
    case 'webp': {
      if (n < 30) return null;
      const kind = ascii(bytes, 12, 16);
      if (kind === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
      if (kind === 'VP8L') {
        return { width: 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
                 height: 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)) };
      }
      if (kind === 'VP8X') {
        return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
                 height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
      }
      return null;
    }
    case 'avif': {
      const end = Math.min(n - 16, 65536);
      for (let i = 4; i < end; i++) {
        if (bytes[i] === 0x69 && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x70 && bytes[i + 3] === 0x65) {   // "ispe"
          return { width: be32(i + 8), height: be32(i + 12) };
        }
      }
      return null;
    }
    default: return null;
  }
}

/** Refuses a picture whose header declares more pixels than MAX_PIXELS. */
function assertNotTooLarge(size) {
  if (size && size.width * size.height > MAX_PIXELS) {
    throw new ImageFormatError('toolarge',
      `That picture says it is ${size.width} by ${size.height} pixels, more than a browser can safely open, `
      + 'or the file is damaged. Reduce its size first.');
  }
}

/** Runs a structural check and turns its failure into the ImageFormatError the rest of the app knows. */
async function checked(check) {
  try {
    await check();
  } catch (error) {
    if (error instanceof ImageCheckError) throw new ImageFormatError(error.code === 'toolarge' ? 'toolarge' : 'decode', error.message);
    throw error;
  }
}

/** Rejects with an ImageFormatError if `promise` has not settled within `ms`. The work itself cannot be cancelled. */
function withTimeout(promise, ms, message) {
  return raceTimeout(promise, ms, () => new ImageFormatError('decode', message));
}

// ── Canvas helpers (browser only) ────────────────────────────────────────────

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasBytes(canvas, type, quality) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type, quality })
    : await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be encoded'))), type, quality);
    });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Draws a bitmap-like source on a white ground, scaled so its longest edge is at most MAX_EDGE. */
function drawScaled(source, width, height) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

async function decodeWithBrowser(bytes) {
  const blob = new Blob([bytes]);
  try {
    // "from-image" applies the EXIF rotation, so the bitmap comes out the way the photo was taken.
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(blob);
  }
}

/** Any format the browser can open: redrawn upright, within MAX_EDGE, as JPEG (PNG for a GIF). */
async function redraw(bytes, asPng) {
  const bitmap = await decodeWithBrowser(bytes);
  try {
    const canvas = drawScaled(bitmap, bitmap.width, bitmap.height);
    return asPng
      ? { bytes: await canvasBytes(canvas, 'image/png'), kind: 'png' }
      : { bytes: await canvasBytes(canvas, 'image/jpeg', JPEG_QUALITY), kind: 'jpeg' };
  } finally {
    bitmap.close?.();
  }
}

/** Encodes one decoded TIFF page as a PNG (grey and black and white scans) or a JPEG. */
async function encodeTiffPage({ rgba, width, height, grey, orientation = 1 }) {
  let source = makeCanvas(width, height);
  const sctx = source.getContext('2d', { alpha: false });
  sctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
  // The TIFF Orientation tag: a scan stored on its side (6 or 8) or upside down (3) is turned upright,
  // as a viewer of the file would show it. The mirrored values (2, 4, 5, 7) do not occur in scans.
  if (orientation === 3 || orientation === 6 || orientation === 8) {
    const sideways = orientation !== 3;
    const turned = makeCanvas(sideways ? height : width, sideways ? width : height);
    const tctx = turned.getContext('2d', { alpha: false });
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, turned.width, turned.height);
    if (orientation === 6) { tctx.translate(height, 0); tctx.rotate(Math.PI / 2); }
    else if (orientation === 8) { tctx.translate(0, width); tctx.rotate(-Math.PI / 2); }
    else { tctx.translate(width, height); tctx.rotate(Math.PI); }
    tctx.drawImage(source, 0, 0);
    source = turned;
    [width, height] = [turned.width, turned.height];
  }
  const canvas = Math.max(width, height) > MAX_EDGE ? drawScaled(source, width, height) : source;
  return grey
    ? { bytes: await canvasBytes(canvas, 'image/png'), kind: 'png' }
    : { bytes: await canvasBytes(canvas, 'image/jpeg', JPEG_QUALITY), kind: 'jpeg' };
}

function tiffFailure(code, message) {
  return new ImageFormatError(code === 'toolarge' || code === 'load' ? code : 'decode', message);
}

/** Decodes a TIFF in a worker, one page at a time, and gives up if a page stalls. */
function tiffPagesInWorker(bytes) {
  return new Promise((resolve, reject) => {
    const worker = startWorker(new URL('./workers/bundletoolTiffWorker.js', import.meta.url), { type: 'module' });
    watchForLazyLoadFailures(worker);
    const pages = [];
    let count = 0;
    let timer = null;
    let finished = false;
    let heard = false;   // has the worker said anything yet? if not, it never started
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };
    // The clock restarts every time the worker reports something, so a long but healthy scan is
    // never cut off: only a page that stops making progress is.
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(reject, new ImageFormatError('decode',
        'That TIFF took too long to read and may be damaged, so it was stopped.')), TIFF_STALL_MS);
    };
    // A worker that fails before it has said anything could not be loaded (a connection or a blocked
    // script): that is not the photo's fault, so it is not blamed on the file.
    worker.onerror = () => finish(reject, heard
      ? new ImageFormatError('decode', 'That TIFF could not be read. It may be damaged.')
      : new ImageFormatError('load', 'The TIFF reader could not be loaded. Check your connection and try again.'));
    worker.onmessage = async (event) => {
      heard = true;
      const m = event.data;
      try {
        if (m.type === 'error') return finish(reject, tiffFailure(m.code, m.message));
        arm();
        if (m.type === 'pages') {
          count = m.count;
          worker.postMessage({ cmd: 'next' });
        } else if (m.type === 'page') {
          pages.push(await encodeTiffPage({ ...m, rgba: m.rgba }));
          arm();
          if (pages.length === count) return finish(resolve, pages);
          worker.postMessage({ cmd: 'next' });
        }
      } catch (error) {
        finish(reject, new ImageFormatError('decode', 'A page of that TIFF could not be turned into a picture.'));
      }
    };
    arm();
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    worker.postMessage({ cmd: 'open', buffer }, [buffer]);
  });
}

/** The same work on the calling thread, for where there are no workers (the test suite). */
async function tiffPagesInline(bytes) {
  const { inspectTiff, decodeTiffPage, TiffProblem } = await lazyImport(new URL('./bundletoolTiff.js', import.meta.url));
  let UTIF;
  try {
    ({ default: UTIF } = await lazyImport(new URL('./vendor/utif2.js', import.meta.url)));
  } catch {
    throw new ImageFormatError('load', 'The TIFF reader could not be loaded. Check your connection and try again.');
  }
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try {
    const ifds = inspectTiff(UTIF, buffer);
    const pages = [];
    for (const ifd of ifds) pages.push(await encodeTiffPage(decodeTiffPage(UTIF, buffer, ifd)));
    return pages;
  } catch (error) {
    if (error instanceof TiffProblem) throw tiffFailure(error.code, error.message);
    throw error;
  }
}

async function tiffPages(bytes) {
  return typeof Worker === 'undefined' ? tiffPagesInline(bytes) : tiffPagesInWorker(bytes);
}

/**
 * Turns picture bytes into embeddable pages.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Array<{bytes: Uint8Array, kind: 'jpeg'|'png'}>>} one entry per page
 * @throws {ImageFormatError}
 */
export async function imageToPages(bytes) {
  const format = sniffImage(bytes);
  if (!format) {
    throw new ImageFormatError('unsupported', 'That file is not a picture BundleTool can read.');
  }

  const size = readImageSize(bytes, format);

  if (format === 'png') {
    // Checked before pdf-lib or the browser sees it: a damaged PNG would freeze the tab, a huge one exhaust memory.
    await checked(() => checkPng(bytes, { maxPixels: MAX_PIXELS }));
    const { width, height } = readPngSize(bytes);
    if (Math.max(width, height) <= REDRAW_ABOVE) return [{ bytes, kind: 'png' }];
    try {
      return [await withTimeout(redraw(bytes, true), DECODE_TIMEOUT_MS, 'That picture took too long to open.')];
    } catch {
      // A big but intact PNG the browser would not redraw: embedding it as it is means pdf-lib decodes
      // every pixel on this thread, which is fine up to a few tens of millions and not beyond.
      if (width * height <= PASS_THROUGH_PIXELS) return [{ bytes, kind: 'png' }];
      throw new ImageFormatError('decode', 'That picture is too large for this browser to open.');
    }
  }

  if (format === 'jpeg') {
    await checked(() => checkJpeg(bytes));
    const { orientation, width, height } = readJpegInfo(bytes);
    if (orientation === 1 && Math.max(width, height) <= REDRAW_ABOVE) return [{ bytes, kind: 'jpeg' }];
    // Too many pixels to open safely: a photo that needs no turning is embedded as it is (a PDF
    // reader draws it at page size), one that does need turning cannot be.
    if (size && size.width * size.height > MAX_PIXELS) {
      if (orientation === 1) return [{ bytes, kind: 'jpeg' }];
      assertNotTooLarge(size);
    }
    try {
      return [await withTimeout(redraw(bytes, false), DECODE_TIMEOUT_MS, 'That photo took too long to open.')];
    } catch (error) {
      // A huge photo the browser will not decode is still a valid JPEG: embed it as it is
      // rather than refuse it, unless that would print it sideways.
      if (orientation === 1) return [{ bytes, kind: 'jpeg' }];
      throw new ImageFormatError('decode', 'That photo is too large for this browser to rotate.');
    }
  }

  if (format === 'tiff') return tiffPages(bytes);

  assertNotTooLarge(size);
  try {
    return [await withTimeout(redraw(bytes, format === 'gif'), DECODE_TIMEOUT_MS, `That ${format.toUpperCase()} picture took too long to open.`)];
  } catch (error) {
    if (format === 'heic') {
      throw new ImageFormatError('heic',
        'This browser cannot open HEIC photos. Open the photo on an iPhone or Mac and share it as a JPG, '
        + 'or choose "Most Compatible" in the camera settings.');
    }
    if (error instanceof ImageFormatError) throw error;   // for example "took too long"
    throw new ImageFormatError('decode', `That ${format.toUpperCase()} picture could not be read.`);
  }
}
