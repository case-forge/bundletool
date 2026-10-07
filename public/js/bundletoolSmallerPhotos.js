/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolSmallerPhotos.js
 * Smaller photos (pageOptions.smallerPhotos, on by default): a document BundleTool made from a picture (a photo, a
 * TIFF page, any other image it converts) has each picture re-encoded for the bundle at most SMALLER_PHOTO_EDGE
 * pixels on its long edge, as a JPEG at SMALLER_PHOTO_QUALITY. A phone photo is often 4000 by 3000 pixels and
 * several megabytes; drawn on an A4 page, 2000 pixels is still about 190 pixels to the inch.
 *
 * WHAT IT TOUCHES. Only documents BundleTool itself made from pictures (the caller passes only those), and on their
 * pages only the one image each page draws: a page that draws none, or more than one, is left as it is, as is any
 * picture already within the size, one of a kind BundleTool does not make, or one that would not come out smaller.
 * It never enlarges. A PDF the person added never comes here.
 *
 * WHAT STAYS THE SAME. The image keeps its name and its place on the page: the page's content draws it into the same
 * rectangle, so the page looks the same at its own size, only with fewer pixels behind it. The text layer read from
 * the picture (OCR, when the document was added, from the full picture) is page content, untouched, so it lies over
 * the same words as before.
 *
 * WHEN. While the bundle is built, on a copy: the document held in the Review Table keeps its full picture, so the
 * setting can be switched off (or on) for documents added earlier, and Force OCR always reads the full picture.
 *
 * A PNG picture (a screenshot, a scan BundleTool keeps as PNG) becomes whichever is smaller of a JPEG and the same
 * picture lossless at the smaller size, and only when that is smaller than what the page holds: a photo kept as PNG
 * becomes a JPEG, line art such as a diagram stays lossless, and a phone screenshot of messages, which would grow
 * either way, is left as it is. A picture with transparency is drawn over white, as the page shows it.
 *
 * The pixel work is the codec's: the browser's canvas (browserCodec, below) or, on the command line,
 * @napi-rs/canvas (scripts/cliSmallerPhotos.mjs). A JPEG's EXIF block is taken off before it is decoded, so the
 * decoder sees the pixels as stored, which is how the page draws them (a PDF reader ignores EXIF).
 */
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray, PDFNumber, PDFBool, decodePDFRawStream } from './bundletoolPdfLib.js';

/** Longest edge, in pixels, of a picture in the bundle when the setting is on. */
export const SMALLER_PHOTO_EDGE = 2000;
/** JPEG quality of a picture re-encoded for the bundle. */
export const SMALLER_PHOTO_QUALITY = 0.85;

/** The single filter name of a stream (DCTDecode, FlateDecode), null for none, '' for a chain of several. */
function filterOf(dict) {
  const f = dict.lookup(PDFName.of('Filter'));
  if (!f) return null;
  if (f instanceof PDFName) return f.decodeText();
  if (f instanceof PDFArray) return f.size() === 1 ? f.lookup(0, PDFName)?.decodeText() ?? '' : '';
  return '';
}

const numberOf = (dict, key) => {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
};
const nameOf = (dict, key) => {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFName ? v.decodeText() : null;
};

/** The image XObjects a page's own resources name, as { name, ref, stream }. */
function pageImages(doc, page) {
  const resources = page.node.Resources();
  const xobjects = resources?.lookup(PDFName.of('XObject'));
  if (!(xobjects instanceof PDFDict)) return [];
  const out = [];
  for (const [name, ref] of xobjects.entries()) {
    const stream = doc.context.lookup(ref);
    if (stream instanceof PDFRawStream && nameOf(stream.dict, 'Subtype') === 'Image') out.push({ name, ref, stream });
  }
  return out;
}

/**
 * A JPEG without its EXIF (APP1 "Exif") blocks: every other byte as it was. Only the markers before the image data
 * are read; anything unexpected returns the bytes unchanged.
 */
export function withoutExif(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const keep = [bytes.subarray(0, 2)];
  let i = 2;
  let removed = false;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return bytes;
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) break;   // the image data (or the end) follows: nothing more to look at
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return bytes;
    const isExif = marker === 0xe1 && len >= 8 && String.fromCharCode(...bytes.subarray(i + 4, i + 8)) === 'Exif';
    if (isExif) removed = true;
    else keep.push(bytes.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (!removed) return bytes;
  keep.push(bytes.subarray(i));
  const out = new Uint8Array(keep.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of keep) { out.set(part, at); at += part.length; }
  return out;
}

/** The size a picture is brought down to: at most `maxEdge` on its long edge, its shape kept, never enlarged. */
export function smallerSize(width, height, maxEdge = SMALLER_PHOTO_EDGE) {
  const long = Math.max(width, height);
  if (!(long > maxEdge)) return null;
  const scale = maxEdge / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The pixels of a FlateDecode RGB or grey picture, 8 bits a channel, as RGBA over white (its soft mask, when it has
 * one, as the alpha): the shape pdf-lib writes a PNG in. Null for any other shape.
 */
function flatePixels(doc, stream, width, height) {
  if (stream.dict.has(PDFName.of('DecodeParms')) || numberOf(stream.dict, 'BitsPerComponent') !== 8) return null;
  const space = nameOf(stream.dict, 'ColorSpace');
  const channels = space === 'DeviceRGB' ? 3 : space === 'DeviceGray' ? 1 : 0;
  if (!channels) return null;
  const raw = decodePDFRawStream(stream).decode();
  if (raw.length < width * height * channels) return null;
  let alpha = null;
  const maskRef = stream.dict.get(PDFName.of('SMask'));
  if (maskRef) {
    const mask = doc.context.lookup(maskRef);
    if (!(mask instanceof PDFRawStream) || filterOf(mask.dict) !== 'FlateDecode' || mask.dict.has(PDFName.of('DecodeParms'))
      || numberOf(mask.dict, 'Width') !== width || numberOf(mask.dict, 'Height') !== height || numberOf(mask.dict, 'BitsPerComponent') !== 8) return null;
    alpha = decodePDFRawStream(mask).decode();
    if (alpha.length < width * height) return null;
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, s = 0, d = 0; p < width * height; p++, s += channels, d += 4) {
    const a = alpha ? alpha[p] / 255 : 1;
    const r = raw[s], g = channels === 3 ? raw[s + 1] : r, b = channels === 3 ? raw[s + 2] : r;
    rgba[d] = r * a + 255 * (1 - a);
    rgba[d + 1] = g * a + 255 * (1 - a);
    rgba[d + 2] = b * a + 255 * (1 - a);
    rgba[d + 3] = 255;
  }
  return { rgba, maskRef };
}

/**
 * Re-encodes the pictures of a document BundleTool made from pictures, for the bundle. Never throws for a picture it
 * cannot handle: that picture is left as it is.
 *
 * @param {Uint8Array} bytes - the document
 * @param {object} codec - browserCodec, or the command line's (decodeJpeg, fromRgba, encodeJpeg, resizeRgb, release)
 * @param {{maxEdge?: number, quality?: number}} [opts]
 * @returns {Promise<{bytes: Uint8Array, pictures: Array<{page: number, kind: 'jpeg'|'png', from: number[], to: number[],
 *   before: number, after: number, as: 'jpeg'|'png'|null}>}>} `bytes` is the input itself when no picture changed;
 *   `pictures` lists every picture looked at, `as` null for one left as it was
 */
export async function smallerPicturePdf(bytes, codec, { maxEdge = SMALLER_PHOTO_EDGE, quality = SMALLER_PHOTO_QUALITY } = {}) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pictures = [];
  let changed = false;
  for (const [index, page] of doc.getPages().entries()) {
    const images = pageImages(doc, page);
    if (images.length !== 1) continue;
    const { ref, stream } = images[0];
    const width = numberOf(stream.dict, 'Width');
    const height = numberOf(stream.dict, 'Height');
    if (!(width > 0 && height > 0) || stream.dict.lookup(PDFName.of('ImageMask')) === PDFBool.True) continue;
    const filter = filterOf(stream.dict);
    const kind = filter === 'DCTDecode' ? 'jpeg' : filter === 'FlateDecode' ? 'png' : null;
    if (!kind) continue;
    const target = smallerSize(width, height, maxEdge);
    const record = { page: index + 1, kind, from: [width, height], to: [width, height], before: stream.contents.length, after: stream.contents.length, as: null };
    pictures.push(record);
    if (!target) continue;

    let decoded = null;
    let maskRef = null;
    try {
      if (kind === 'jpeg') {
        if (numberOf(stream.dict, 'BitsPerComponent') !== 8) continue;
        decoded = await codec.decodeJpeg(withoutExif(stream.contents));
      } else {
        const pixels = flatePixels(doc, stream, width, height);
        if (!pixels) continue;
        maskRef = pixels.maskRef;
        decoded = await codec.fromRgba(pixels.rgba, width, height);
      }
      // Pixels that are not the picture the page holds (a decoder that turned it by its EXIF, say) are left alone.
      if (decoded.width !== width || decoded.height !== height) continue;
      // A JPEG; for a PNG, also the same picture lossless at the smaller size. The smallest wins, and only when it is
      // smaller than what the page holds now: measured, a phone screenshot of messages grows either way (so it is
      // left as it is) and a diagram or flat colour is smallest lossless, while a photo kept as PNG is smallest as a
      // JPEG by far. Streams made here and not chosen are never registered, so they are not saved.
      const candidates = [{ as: 'jpeg', stream: doc.context.stream(await codec.encodeJpeg(decoded, target.width, target.height, quality), {
        Type: 'XObject', Subtype: 'Image', Width: target.width, Height: target.height,
        ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode',
      }) }];
      if (kind === 'png') {
        candidates.push({ as: 'png', stream: doc.context.flateStream(await codec.resizeRgb(decoded, target.width, target.height), {
          Type: 'XObject', Subtype: 'Image', Width: target.width, Height: target.height,
          ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
        }) });
      }
      const out = candidates.filter((c) => c.stream.contents.length < stream.contents.length)
        .sort((a, b) => a.stream.contents.length - b.stream.contents.length)[0];
      if (!out) continue;
      doc.context.assign(ref, out.stream);
      if (maskRef) doc.context.delete(maskRef);
      record.to = [target.width, target.height];
      record.after = out.stream.contents.length;
      record.as = out.as;
      changed = true;
    } catch (error) {
      console.warn('[smaller photos] a picture was left as it was:', error?.message ?? error);
    } finally {
      if (decoded) codec.release?.(decoded);
    }
  }
  return { bytes: changed ? await doc.save() : bytes, pictures };
}

/** The browser's codec: createImageBitmap to decode, an OffscreenCanvas (or a canvas) to scale and encode. */
export const browserCodec = {
  async decodeJpeg(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  },
  async fromRgba(rgba, width, height) {
    const bitmap = await createImageBitmap(new ImageData(rgba, width, height));
    return { width, height, source: bitmap };
  },
  draw(decoded, width, height) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, width, height);
    return canvas;
  },
  async encodeJpeg(decoded, width, height, quality) {
    const canvas = this.draw(decoded, width, height);
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
      : await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be encoded'))), 'image/jpeg', quality));
    return new Uint8Array(await blob.arrayBuffer());
  },
  async resizeRgb(decoded, width, height) {
    const data = this.draw(decoded, width, height).getContext('2d').getImageData(0, 0, width, height).data;
    const rgb = new Uint8Array(width * height * 3);
    for (let s = 0, d = 0; s < data.length; s += 4, d += 3) { rgb[d] = data[s]; rgb[d + 1] = data[s + 1]; rgb[d + 2] = data[s + 2]; }
    return rgb;
  },
  release(decoded) { decoded.source?.close?.(); },
};
