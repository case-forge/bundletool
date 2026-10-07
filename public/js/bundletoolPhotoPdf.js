/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0.
 *
 * bundletoolPhotoPdf.js
 * A JPEG or PNG as a one-page PDF, without a canvas: the command line has none. The page is the
 * bundle's page size (imagesToPdf's rule: a 36 point margin, the picture fitted inside it at its own
 * aspect ratio and never enlarged), and the picture's bytes are embedded as they are. A JPEG that
 * carries an EXIF rotation (which PDF viewers ignore) is drawn through a transform instead of being
 * redrawn as pixels, so it comes out the right way up all the same.
 *
 * The browser keeps its own path (bundletoolImages.js redraws on a canvas); this module is what Node
 * uses. Differences, all from having no canvas: a picture whose longest edge is over 4,200 pixels is
 * embedded as it is instead of being scaled down to 4,000 (it prints the same, the file is larger),
 * and only JPEG and PNG are accepted.
 */
import { PDFDocument, pdflib } from './bundletoolPdfLib.js';
import { orientationMatrix, uprightSize } from '/js/shared/exif-orientation.js';
import { sniffImage, readJpegInfo, readPngSize, MAX_PIXELS, PASS_THROUGH_PIXELS } from './bundletoolImages.js';
import { checkPng, checkJpeg, ImageCheckError } from './bundletoolImageCheck.js';
import { pageDimensions } from './bundletoolPageSize.js';

const MARGIN = 36;

/** A picture that cannot be used. `code` is 'decode' (damaged) or 'toolarge'. */
export class PhotoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhotoError';
    this.code = code;
  }
}

/**
 * @param {Uint8Array} bytes  JPEG or PNG bytes (read from the bytes themselves, never a name)
 * @param {string} [pageSizeKey]
 * @returns {Promise<Uint8Array>} a one-page PDF
 * @throws {PhotoError} damaged or too large; a plain Error when the bytes are not a JPEG or PNG
 */
export async function photoToPdf(bytes, pageSizeKey) {
  const format = sniffImage(bytes);
  if (format !== 'jpeg' && format !== 'png') throw new Error('Not a JPG or PNG image');
  let width; let height; let orientation = 1;
  try {
    if (format === 'png') {
      await checkPng(bytes, { maxPixels: MAX_PIXELS });
      ({ width, height } = readPngSize(bytes));
      // The browser redraws a big PNG smaller; here pdf-lib decodes every pixel on the calling thread,
      // which is fine up to a few tens of millions of pixels and not beyond.
      if (width * height > PASS_THROUGH_PIXELS) throw new PhotoError('toolarge', 'That picture is too large to open here.');
    } else {
      checkJpeg(bytes);
      ({ width, height, orientation } = readJpegInfo(bytes));
      if (width * height > MAX_PIXELS) throw new PhotoError('toolarge', 'That picture has too many pixels to open here.');
    }
  } catch (error) {
    if (error instanceof ImageCheckError) throw new PhotoError(error.code === 'toolarge' ? 'toolarge' : 'decode', error.message);
    throw error;
  }
  if (!(width > 0 && height > 0)) throw new PhotoError('decode', 'That picture is damaged: its size could not be read.');

  const doc = await PDFDocument.create();
  const [pageW, pageH] = pageDimensions(pageSizeKey);
  const image = format === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const [upW, upH] = uprightSize(orientation, image.width, image.height);
  const scale = Math.min((pageW - 2 * MARGIN) / upW, (pageH - 2 * MARGIN) / upH, 1);
  const boxW = upW * scale;
  const boxH = upH * scale;
  const page = doc.addPage([pageW, pageH]);
  if (orientation === 1) {
    page.drawImage(image, { x: (pageW - boxW) / 2, y: (pageH - boxH) / 2, width: boxW, height: boxH });
  } else {
    const name = page.node.newXObject('Photo', image.ref);
    const m = orientationMatrix(orientation, image.width, image.height, (pageW - boxW) / 2, (pageH - boxH) / 2, boxW, boxH);
    page.pushOperators(
      pdflib.pushGraphicsState(),
      pdflib.concatTransformationMatrix(...m),
      pdflib.drawObject(name),
      pdflib.popGraphicsState(),
    );
  }
  return doc.save();
}
