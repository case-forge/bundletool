/**
 * Scans drawn for the OCR page-change tests (ocrReorient.test.mjs, ocrSettings.test.mjs): six lines of print in the
 * middle of a US Letter page at 200 dpi, turned or tilted about the page's centre as a crooked or sideways scan is.
 */
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, degrees } from '../public/js/bundletoolPdfLib.js';

export const LINES = [
  'The court made the following order on the first day',
  'Both parties shall file and serve a short statement',
  'The matter is listed for a further directions hearing',
  'Each party must comply with this order by four pm',
  'Any application to vary this order must be on notice',
  'The respondent shall not remove the child from England',
];
export const W = 1700, H = 2200;   // a US Letter page at 200 dpi

/** The level print: six lines in the middle of the page. */
export function levelCanvas() {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'black';
  ctx.textBaseline = 'top';
  ctx.font = '38px "DejaVu Sans"';
  LINES.forEach((line, i) => ctx.fillText(line, 260, 760 + i * 92));
  return canvas;
}

/** The level print turned about the page's centre: `tilt` degrees clockwise as seen (a scan put crooked on the glass),
 * then `turn` degrees anticlockwise (stored on its side). The page keeps its size; corners turned out are lost. */
export function scanCanvas({ tilt = 0, turn = 0 } = {}) {
  const side = turn === 90 || turn === 270;
  const w = side ? H : W, h = side ? W : H;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(((tilt - turn) * Math.PI) / 180);
  ctx.drawImage(levelCanvas(), -W / 2, -H / 2);
  return canvas;
}

/** An image-only PDF of a canvas scanned at 200 dpi, optionally with /Rotate set and a link on it. */
export async function scanPdf(canvas, { rotate = 0, link = false } = {}) {
  const doc = await PDFDocument.create();
  const pw = (canvas.width * 72) / 200, ph = (canvas.height * 72) / 200;
  const page = doc.addPage([pw, ph]);
  page.drawImage(await doc.embedPng(canvas.toBuffer('image/png')), { x: 0, y: 0, width: pw, height: ph });
  if (rotate) page.setRotation(degrees(rotate));
  if (link) addLink(doc, page);
  return doc.save();
}


/** Adds a link annotation to a page. */
export function addLink(doc, page) {
  const link = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [100, 600, 300, 620], Border: [0, 0, 0],
    A: { S: 'URI', URI: doc.context.obj('https://example.org') },
  }));
  page.node.addAnnot(link);
}

/** An image-only PDF with one page per canvas, each scanned at 200 dpi. */
export async function scanPdfPages(canvases) {
  const doc = await PDFDocument.create();
  for (const canvas of canvases) {
    const pw = (canvas.width * 72) / 200, ph = (canvas.height * 72) / 200;
    const page = doc.addPage([pw, ph]);
    page.drawImage(await doc.embedPng(canvas.toBuffer('image/png')), { x: 0, y: 0, width: pw, height: ph });
  }
  return doc.save();
}
