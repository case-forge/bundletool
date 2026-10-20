/**
 * EXIF orientation, in one place. A phone photo or a scan can store its pixels sideways and say so in
 * an EXIF tag (1 to 8); pdf-lib embeds the raw pixels and ignores the tag, so a picture put on a page
 * has to be drawn upright by a transform. BundleTool (photo pages, the photo reader) and the Envelope
 * Guide (logos) both use this file, in the browser and under Node; there is no second copy to keep in
 * step. No DOM, no canvas and no PDF library: plain arithmetic on bytes and numbers.
 */

/**
 * The orientation (1 to 8) stored in the TIFF block of an EXIF segment, or 0 when there is none or it
 * cannot be read. `tiff` is the offset of the TIFF header in `bytes`, `end` the end of the segment.
 */
export function exifOrientation(bytes, tiff, end) {
  if (tiff + 8 > end) return 0;
  const little = bytes[tiff] === 0x49;
  if (!little && bytes[tiff] !== 0x4d) return 0;
  const u16 = (p) => (little ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1]);
  const u32 = (p) => (little
    ? (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0
    : ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 0;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) return 0;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 0;
    }
  }
  return 0;
}

/** The EXIF orientation (1 to 8) of a JPEG, or 1 when it has none or the file cannot be read. Never throws. */
export function jpegOrientation(bytes) {
  try {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      if (marker === 0xda || marker === 0xd9) return 1;          // scan or end: no EXIF before the picture data
      const length = (bytes[i + 2] << 8) | bytes[i + 3];
      if (length < 2) return 1;
      const start = i + 4;
      if (marker === 0xe1 && bytes[start] === 0x45 && bytes[start + 1] === 0x78 && bytes[start + 2] === 0x69
        && bytes[start + 3] === 0x66 && bytes[start + 4] === 0 && bytes[start + 5] === 0) {
        return exifOrientation(bytes, start + 6, Math.min(bytes.length, i + 2 + length)) || 1;
      }
      i += 2 + length;
    }
  } catch { /* an unreadable header means no orientation */ }
  return 1;
}

/**
 * Where a stored pixel (column c, row r, row 0 at the top) ends up in the upright picture, for each
 * EXIF orientation value: 1 as stored; 2 mirrored left to right; 3 turned 180; 4 mirrored top to
 * bottom; 5 transposed; 6 turned 90 clockwise; 7 transverse; 8 turned 90 anticlockwise.
 * `w` and `h` are the stored width and height in pixels.
 */
function uprightPosition(orientation, w, h) {
  switch (orientation) {
    case 2: return (c, r) => [w - c, r];
    case 3: return (c, r) => [w - c, h - r];
    case 4: return (c, r) => [c, h - r];
    case 5: return (c, r) => [r, c];
    case 6: return (c, r) => [h - r, c];
    case 7: return (c, r) => [h - r, w - c];
    case 8: return (c, r) => [r, w - c];
    default: return (c, r) => [c, r];
  }
}

/** The size of the upright picture, as [width, height], for a stored width and height. */
export function uprightSize(orientation, w, h) {
  return orientation >= 5 ? [h, w] : [w, h];
}

/**
 * The matrix [a, b, c, d, e, f] that draws an image's unit square (u, v; v up, the image's top row at
 * v = 1) so that the picture shows upright inside a box of `boxW` by `boxH` points whose lower left
 * corner is (x0, y0). Pure arithmetic, so it can be tested without rendering.
 */
export function orientationMatrix(orientation, w, h, x0, y0, boxW, boxH) {
  const [dw, dh] = uprightSize(orientation, w, h);   // the upright picture's size in pixels
  const at = uprightPosition(orientation, w, h);
  const place = (u, v) => {
    const [C, R] = at(u * w, (1 - v) * h);
    return [x0 + (C / dw) * boxW, y0 + (1 - R / dh) * boxH];
  };
  const [e, f] = place(0, 0);
  const [ex, fx] = place(1, 0);
  const [ey, fy] = place(0, 1);
  return [ex - e, fx - f, ey - e, fy - f, e, f];
}
