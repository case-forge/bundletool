/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * cliSmallerPhotos.mjs
 * Smaller photos (pageOptions.smallerPhotos, on by default) on the command line: the same re-encoding the browser
 * does when it builds a bundle (public/js/bundletoolSmallerPhotos.js), with @napi-rs/canvas doing the pixel work
 * the browser's canvas does there. @napi-rs/canvas is an optional dependency (it is OCR's too): when it cannot load,
 * loadNodeCodec() returns null and the build keeps its pictures as they are, with a photo_not_smaller warning.
 *
 * Only the JPEG and PNG files the command line turns into one-page PDFs come here, after OCR has read the full
 * picture, so the text layer is read from every pixel and still lies over the same words afterwards.
 */
import { smallerPicturePdf } from '../public/js/bundletoolSmallerPhotos.js';

/**
 * The codec smallerPicturePdf() needs, on @napi-rs/canvas, or null when that cannot be loaded.
 * @param {{importCanvas?: () => Promise<object>}} [opts] - the import, for a test to make fail
 */
export async function loadNodeCodec({ importCanvas = () => import('@napi-rs/canvas') } = {}) {
  let canvas;
  try { canvas = await importCanvas(); } catch { return null; }
  const { createCanvas, loadImage, ImageData } = canvas;
  if (typeof createCanvas !== 'function' || typeof loadImage !== 'function') return null;
  const draw = (decoded, width, height) => {
    const c = createCanvas(width, height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, width, height);
    return c;
  };
  return {
    async decodeJpeg(bytes) {
      const image = await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return { width: image.width, height: image.height, source: image };
    },
    async fromRgba(rgba, width, height) {
      const c = createCanvas(width, height);
      c.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
      return { width, height, source: c };
    },
    async encodeJpeg(decoded, width, height, quality) {
      return new Uint8Array(await draw(decoded, width, height).encode('jpeg', Math.round(quality * 100)));
    },
    async resizeRgb(decoded, width, height) {
      const data = draw(decoded, width, height).getContext('2d').getImageData(0, 0, width, height).data;
      const rgb = new Uint8Array(width * height * 3);
      for (let s = 0, d = 0; s < data.length; s += 4, d += 3) { rgb[d] = data[s]; rgb[d + 1] = data[s + 1]; rgb[d + 2] = data[s + 2]; }
      return rgb;
    },
    release() {},
  };
}

/**
 * One converted picture's PDF with its picture made smaller.
 * @returns {Promise<{bytes: Uint8Array, before: number, after: number, pictures: Array<object>}>} before and after
 *   are the picture streams' sizes in bytes
 */
export async function smallerPhotoPdf(bytes, codec) {
  const { bytes: out, pictures } = await smallerPicturePdf(bytes, codec);
  const before = pictures.reduce((n, p) => n + p.before, 0);
  const after = pictures.reduce((n, p) => n + p.after, 0);
  return { bytes: out, before, after, pictures };
}
