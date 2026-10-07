/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolOcrReorient.js
 * Two optional changes to a scanned page that OCR has just read, both off by default:
 *
 *   ocr.turnUpright   a page the reader turned a quarter turn to read it (bundletoolDeskew.js's readUpright, only when
 *                     the engine and the ink profile agree) gets that turn in its own /Rotate, so it is shown upright.
 *   ocr.straighten    a page the reader found tilted is turned level: its existing content is wrapped in a rotation
 *                     about the page's centre (q, cm, the content as it was, Q).
 *
 * Both are lossless. /Rotate is one number in the page's dictionary, and the text layer is drawn in the page's own
 * space, so it turns with the page. Straightening adds two small content streams round the page's own and touches
 * nothing inside them: the scan is not drawn again or re-encoded, and the page keeps its size, so the corners of the
 * scan turned past its edges are cut off (on a scan, its outer margin and the scanner's background; the README gives
 * the measured share). The text layer is drawn after the rotation, outside it, level with the now-level page
 * (bundletoolDeskew.js's toLevel).
 *
 * PUTTING A PAGE BACK. A straightened page can be put back as scanned (the document window's button):
 * putBackAsScanned takes the two marked streams out, so the scan draws exactly as it did, and turns the text layer back
 * with it. A page put back is not straightened again by a later reading (settings.keepAsScanned).
 *
 * WHICH PAGES. Only pages OCR read whose own visible text is short of OCR_MIN_CHARS: a scanned page. A page with
 * text of its own (a born-digital page read by Force OCR) is never changed. Straightening also leaves alone a page
 * tilted by more than STRAIGHTEN_MAX degrees, and a page with annotations: a link, a form field or a comment sits at a
 * set place on the page and would no longer line up with what it marks once the content under it turns. Those
 * pages are reported, so the caller can say which were left as scanned.
 *
 * Pure apart from the pdf-lib page it is given; the browser and the command line call the same functions.
 */

import {
  degrees, PDFName, PDFArray, PDFRef, PDFRawStream, decodePDFRawStream, pushGraphicsState, popGraphicsState, concatTransformationMatrix,
} from './bundletoolPdfLib.js';
import { parseContent } from './bundletoolOcrRedo.js';

/** The largest tilt, in degrees either way, a page is straightened by. Measured on the OCR benchmark's witness
 * statement and phone photograph pages, turning a page's content by up to this much about its centre moves none of
 * its printed text off the page (what leaves is the outer margin of the scan); a little past it, the running header
 * and footer of an A4 statement start to leave. */
export const STRAIGHTEN_MAX = 10;

const POINTS_PER_INCH = 72;

/** The settings as booleans, whatever shape they arrive in. */
export function reorientSettings(input) {
  const keep = Array.isArray(input?.keepAsScanned) ? input.keepAsScanned.filter(Number.isInteger) : [];
  return { turnUpright: input?.turnUpright === true, straighten: input?.straighten === true, keepAsScanned: new Set(keep) };
}

/** True when the page carries any annotation (see this file's header comment, "WHICH PAGES"). */
export function hasAnnotations(page) {
  const annots = page.node.lookup(PDFName.of('Annots'));
  return annots instanceof PDFArray && annots.size() > 0;
}

/**
 * What to do to one page, decided from what the reader measured. Pure.
 *
 * @param {{accepted?: number, tilt?: number}} read - readUpright()'s accepted quarter turn and tilt
 * @param {{turnUpright?: boolean, straighten?: boolean}} settings
 * @param {{ownText?: boolean, annotated?: boolean}} page - the page has visible text of its own; it has annotations
 * @returns {{turn: 0|90|180|270, tilt: number, sideways: 0|90|180|270, notStraightened: boolean}}
 *   turn: the quarter turn to show the page with (counter-clockwise), 0 for none. tilt: the rotation to straighten it
 *   by (degrees, counter-clockwise as seen), 0 for none. sideways: the quarter turn the reader found when it is not
 *   applied (the setting is off), for a note on the page. notStraightened: the page was tilted within reach but has
 *   annotations, so it is left as it is.
 */
export function planReorient(read, settings, { ownText = false, annotated = false } = {}) {
  const none = { turn: 0, tilt: 0, sideways: 0, notStraightened: false };
  if (ownText) return none;
  const accepted = [90, 180, 270].includes(read?.accepted) ? read.accepted : 0;
  const tilt = Number.isFinite(read?.tilt) ? read.tilt : 0;
  const reach = tilt !== 0 && Math.abs(tilt) <= STRAIGHTEN_MAX;
  return {
    turn: settings.turnUpright ? accepted : 0,
    tilt: settings.straighten && reach && !annotated ? tilt : 0,
    sideways: settings.turnUpright ? 0 : accepted,
    notStraightened: Boolean(settings.straighten && reach && annotated),
  };
}

/** The page's /Rotate once it is also turned `turn` degrees counter-clockwise (/Rotate turns clockwise). */
export function turnedRotation(rotate, turn) {
  return ((((rotate || 0) - turn) % 360) + 360) % 360;
}

/**
 * Where the centre of a raster of the page lies on the page, in PDF points: the point the rotation turns about, so the
 * text layer, worked out on the raster (bundletoolDeskew.js's toLevel), lands where the turned content does. The
 * raster covers the page's visible box (its CropBox within its MediaBox), as pdf.js draws it.
 *
 * @param {import('@cantoo/pdf-lib').PDFPage} page
 * @param {{width: number, height: number}} raster - the raster OCR read, in pixels
 * @param {number} dpi - its resolution
 */
export function rasterCentre(page, raster, dpi) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  let x0 = Math.max(media.x, crop.x);
  let y1 = Math.min(media.y + media.height, crop.y + crop.height);
  if (!(x0 < Math.min(media.x + media.width, crop.x + crop.width)) || !(Math.max(media.y, crop.y) < y1)) {
    x0 = media.x;
    y1 = media.y + media.height;
  }
  const s = dpi / POINTS_PER_INCH;
  return { x: x0 + raster.width / 2 / s, y: y1 - raster.height / 2 / s };
}

/** The cosine and sine a straightening by `tilt` degrees is written with. */
function cosSin(tilt) {
  const t = (tilt * Math.PI) / 180;
  return { cos: Math.cos(t), sin: Math.sin(t) };
}

/** The two content streams that wrap content in a rotation about `centre` (a q with a cm, then a Q), each marked in
 * its dictionary with `key` (BundleToolStraighten or BundleToolPutBack): the start with [tilt, centre x, centre y],
 * the end with /End. Readers ignore the key; bundletoolOcrRedo.js keeps marked streams apart when it rewrites a page's
 * content, and putBackAsScanned finds a straightening by them. */
function rotationStreams(page, key, tilt, cos, sin, centre) {
  const { context } = page.doc;
  const start = context.register(context.contentStream([
    pushGraphicsState(),
    concatTransformationMatrix(cos, sin, -sin, cos, centre.x - cos * centre.x + sin * centre.y, centre.y - sin * centre.x - cos * centre.y),
  ], { [key]: [tilt, centre.x, centre.y] }));
  const end = context.register(context.contentStream([popGraphicsState()], { [key]: 'End' }));
  return { start, end };
}

/**
 * Turns the page's existing content by `tilt` degrees (counter-clockwise as seen) about `centre`: one content stream
 * before it (q, cm) and one after it (Q), both marked (rotationStreams). Anything drawn on the page afterwards goes in
 * a new stream after those, so it is not turned.
 *
 * @param {import('@cantoo/pdf-lib').PDFPage} page
 * @param {number} tilt - degrees
 * @param {{x: number, y: number}} centre - PDF points
 * @returns {boolean} false when the page has no content to turn (nothing was changed)
 */
export function straightenContent(page, tilt, centre) {
  const { cos, sin } = cosSin(tilt);
  page.node.normalize();
  if (!(page.node.Contents() instanceof PDFArray)) return false;
  const { start, end } = rotationStreams(page, 'BundleToolStraighten', tilt, cos, sin, centre);
  page.node.wrapContentStreams(start, end);
  // A fresh stream for whatever is drawn next (the text layer), after the closing Q.
  page.resetPosition();
  return true;
}

/** What a content stream marks: { straighten: true, end, turn: [tilt, x, y] } for a straightening's streams, null
 * otherwise. */
function straightenMarker(stream) {
  const value = stream?.dict?.get(PDFName.of('BundleToolStraighten'));
  if (!value) return null;
  if (value instanceof PDFArray) {
    const turn = value.asArray().map((n) => Number(n?.asNumber?.()));
    return turn.length === 3 && turn.every(Number.isFinite) ? { end: false, turn } : null;
  }
  return value.toString() === '/End' ? { end: true } : null;
}

/**
 * Puts a straightened page back as it was scanned, exactly: the two streams each straightening added are taken out,
 * so the scan is drawn by its own content streams again, with no transform round them, exactly as before it was
 * straightened (bundletoolOcrRedo.js keeps those streams apart when Force OCR reads the page again, so they are still
 * there). Undoing by wrapping the page in the opposite rotation instead is not exact: a viewer composes the two
 * rotations with its own page transform in floating point, the result keeps a cross term of about 1e-16, and poppler
 * then draws the scan through its rotated-image path, which samples it differently (measured: 2.5% of the pixels of a
 * page drawn at 60 dpi changed).
 *
 * The text layer drawn after a straightening lies level over the level page, so it alone is wrapped in the opposite
 * rotation (streams marked BundleToolPutBack), latest straightening innermost, and goes back to lying along the tilted
 * print. Each such stream is wrapped on its own, and only when its own q and Q balance: a lone q or Q pdf-lib wrote
 * round a page it drew on is left where it is, so the page's q and Q still pair as they did. Every stream is kept,
 * nothing is redrawn.
 *
 * @param {import('@cantoo/pdf-lib').PDFPage} page
 * @returns {boolean} false when the page carries no straightening to take out, or a stream after one cannot be read
 *   or draws while its q and Q do not balance (nothing is changed)
 */
export function putBackAsScanned(page) {
  const { context } = page.doc;
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) return false;
  const lookup = (ref) => (ref instanceof PDFRef ? context.lookup(ref) : ref);
  const operators = (stream) => {
    let bytes = null;
    try {
      bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream?.getUnencodedContents?.();
    } catch { return null; }
    return bytes ? parseContent(bytes) : null;
  };
  const out = [];
  const open = [];
  let ended = [];
  let found = false;
  for (const ref of contents.asArray()) {
    const marker = straightenMarker(lookup(ref));
    if (marker) {
      found = true;
      if (!marker.end) open.push(marker.turn);
      else if (open.length) ended = [...ended, open.pop()];
      else return false;
      continue;
    }
    if (!ended.length) { out.push(ref); continue; }
    const ops = operators(lookup(ref));
    if (!ops) return false;
    let depth = 0;
    let lowest = 0;
    for (const { op } of ops) {
      if (op === 'q') depth++;
      else if (op === 'Q') lowest = Math.min(lowest, --depth);
    }
    if (depth === 0 && lowest === 0) {
      const wraps = ended.map(([tilt, x, y]) => {
        const { cos, sin } = cosSin(tilt);
        return rotationStreams(page, 'BundleToolPutBack', tilt, cos, -sin, { x, y });
      });
      out.push(...wraps.map((w) => w.start), ref, ...wraps.map((w) => w.end).reverse());
    } else if (ops.every(({ op }) => op === 'q' || op === 'Q')) out.push(ref);
    else return false;
  }
  if (!found || open.length) return false;
  page.node.set(PDFName.of('Contents'), context.obj(out));
  return true;
}

/**
 * Applies the plan for one page (planReorient): sets its /Rotate and returns how its text layer is to be drawn.
 * Straightening itself happens in bundletoolOcr.js's replaceOcrLayer, after the page's old invisible text is taken off
 * and before the new layer is drawn.
 *
 * @param {import('@cantoo/pdf-lib').PDFPage} page
 * @param {{toRaw: number[], toLevel?: number[], accepted?: number, tilt?: number}} read - from readUpright()
 * @param {{turnUpright?: boolean, straighten?: boolean}} settings
 * @param {{ownText?: boolean, raster: {width: number, height: number}, dpi: number, pageNumber?: number}} info - a
 *   page whose number is in settings.keepAsScanned (put back as scanned by the person) is never straightened again
 * @returns {{plan: ReturnType<typeof planReorient> & {rotate: number, centre?: {x: number, y: number}}, layer: {toRaw: number[],
 *   straighten?: {tilt: number, centre: {x: number, y: number}, toLevel: number[]}}}}
 *   plan.rotate: the page's own /Rotate as it was read; plan.centre: the point a straightened page turns about.
 *   layer: the options for replaceOcrLayer.
 */
export function reorientPage(page, read, settings, { ownText = false, raster, dpi, pageNumber }) {
  const rotate = turnedRotation(page.getRotation().angle, 0);
  const own = settings.keepAsScanned?.has(pageNumber) ? { ...settings, straighten: false } : settings;
  const plan = { ...planReorient(read, own, { ownText, annotated: own.straighten ? hasAnnotations(page) : false }), rotate };
  if (plan.turn) page.setRotation(degrees(turnedRotation(rotate, plan.turn)));
  if (!plan.tilt || !read.toLevel) return { plan: { ...plan, tilt: 0 }, layer: { toRaw: read.toRaw } };
  const centre = rasterCentre(page, raster, dpi);
  return {
    plan: { ...plan, centre },
    layer: { toRaw: read.toRaw, straighten: { tilt: plan.tilt, centre, toLevel: read.toLevel } },
  };
}

/** An empty record of what was changed in one document, filled by recordReorient. */
export function reorientRecord() {
  return { turned: [], straightened: [], notStraightened: [], sideways: [] };
}

/**
 * Notes one page's plan in a document's record: [page number, degrees] for a page turned, [page number, degrees,
 * centre x, centre y] for one straightened (what putting it back needs), page numbers for one left tilted, and for a
 * page found sideways, [page number, the quarter turn it needs (counter-clockwise), its /Rotate when it was read], so a
 * note can tell later whether the page has been turned since.
 */
export function recordReorient(record, pageNumber, plan) {
  if (plan.turn) record.turned.push([pageNumber, plan.turn]);
  if (plan.tilt) record.straightened.push([pageNumber, plan.tilt, plan.centre?.x ?? NaN, plan.centre?.y ?? NaN]);
  if (plan.notStraightened) record.notStraightened.push(pageNumber);
  if (plan.sideways) record.sideways.push([pageNumber, plan.sideways, plan.rotate ?? 0]);
  return record;
}
