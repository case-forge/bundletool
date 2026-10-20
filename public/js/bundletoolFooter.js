/**
 * BundleTool
 * Copyright (c) 2025-2026 Tris Sherliker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * A tool for the creation of legal bundles.
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolFooter.js
 * The bundle page-number footer.
 *
 * The configurable footer text (style, prefix, alignment, colour, font,
 * per-section numbering) comes from BunTool's page-numbering code. Three more
 * things follow BundleToolCLI, CaseForge's Python command line bundle tool
 * (its page_number_box_rect() and overlay_for_page_number()):
 *
 *   1. A WHITE BLANKING RECTANGLE, drawn FIRST. This is the important one.
 *      A bundle gets re-bundled: someone opens last week's bundle, adds two
 *      documents and rebuilds. Without blanking, the new footer prints on top
 *      of the old one and you get two overlapping page numbers in the same
 *      box, and after a third pass, three. Since they disagree about what
 *      page it is, the page is worse than unnumbered. Blanking the zone before
 *      drawing means the newest number is the only number.
 *
 *      The blanking rectangle extends 8pt either side and 4pt above and below
 *      the plate, as in the CLI.
 *
 *      What it cannot cover: a footer left by a DIFFERENT configuration,
 *      such as a much larger font, or right-aligned when this run is centred, or a
 *      previous bundle long enough that its plate was more than 8pt wider each
 *      side. Those are handled by removal instead (see removeTaggedFooters
 *      below and bundletoolRestore.js), which is the path a re-bundle actually
 *      takes. Blanking is the backstop for when removal finds nothing to
 *      remove, and its reach is deliberately bounded by those margins.
 *
 *   2. A GREY PLATE behind the text, so the number stays legible over a scan.
 *
 *   3. A LINK on the footer back to the INDEX page. The index is not
 *      necessarily page 1, with a coversheet it is page 2, so the target is
 *      passed in rather than assumed. See bundletoolMain.js.
 *
 * Geometry follows the CLI: plate width = text width + 20, minimum height 26,
 * at y = 8, centred on the page. The CLI's alpha (0.7 on the plate, 0.88 on
 * the text) is not reproduced because it cannot show: the plate sits on the
 * opaque white blanking rectangle, so the composited result over white is what
 * you see either way. The plate is drawn at the composited value instead
 * (0.7 x 0.94 + 0.3 x 1.0 = 0.958), which needs no ExtGState resource.
 *
 * ONE PLATE SIZE PER DOCUMENT, not one per page. The CLI sizes each page's box
 * from that page's own number, which means the box visibly changes width when a
 * bundle crosses from page 999 to page 1000: 20pt wider, mid-bundle, for no
 * reason the reader can see. Every page here is given the plate the WIDEST
 * label in the document needs, and the label is centred inside it, so the box
 * is identical on every page and only the digits change. That also makes
 * intra-document stacking impossible by construction: any page's plate exactly
 * covers any other page's plate.
 *
 * CENTRING IS MEASURED FROM THE INK, NOT FROM THE FONT'S EM BOX.
 *
 *   Horizontally, the label is centred on its measured width, so it must hold
 *   nothing invisible that still takes up width. fontkit's shaper treats U+200B
 *   ZERO WIDTH SPACE as default-ignorable and gives it a zero advance, but
 *   pdf-lib does not use the shaper's positions:
 *   CustomFontEmbedder.widthOfTextAtSize sums each glyph's own advanceWidth,
 *   and it builds the CIDFont /W array the same way. In Liberation Sans U+200B
 *   maps to the ordinary space glyph, so it would be measured and drawn as
 *   leading whitespace, a visible gap on the left of the label. buildFooterTexts
 *   adds no zero-width characters, and nothing here applies a compensating
 *   offset.
 *
 *   Vertically, the CLI's baseline of 8pt above the plate's bottom edge suits
 *   its own fixed 12pt text in a fixed 26pt box, but not a configurable font
 *   size: at 18pt it would leave the label 2.3pt low. The baseline is derived
 *   so the label's actual ink is centred in the plate. `textInk` carries that
 *   measurement in; applyPageNumbering computes it once for the whole document
 *   so the baseline cannot shift from page to page.
 *
 * Rotation: the footer belongs at the bottom of the page AS DISPLAYED. Rather
 * than four sets of hand-derived coordinates, the whole footer is drawn in
 * visible-page coordinates inside its own content stream, under one
 * transformation matrix that maps visible space to unrotated user space. The
 * four matrices are derived in visibleToUserMatrix() below.
 *
 * Removal: the footer goes into its own content stream tagged
 * /BundleToolFooter, so a re-bundle can drop it exactly rather than pattern-
 * matching bytes. bundletoolRestore.js uses that first, and matches the
 * footer's colours instead only for a bundle whose footer is not tagged.
 */

import {
  PDFName, PDFNumber, PDFBool, PDFArray, PDFRef,
  rgb, pdflib,
} from './bundletoolPdfLib.js';
import { addLinkAnnotation } from './bundletoolLinks.js';

const {
  PDFContentStream,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix,
  setFillingGrayscaleColor, setFillingRgbColor, setGraphicsState,
  rectangle, fill,
  beginText, endText, setFontAndSize, moveText, showText,
} = pdflib;

/** Marker key written into the footer's content stream dictionary. */
export const FOOTER_STREAM_KEY = 'BundleToolFooter';

/** Plate geometry, from BundleToolCLI page_number_box_rect(). */
export const PLATE_PADDING = 20;   // added to the text width
export const PLATE_HEIGHT = 26;
export const PLATE_Y = 8;
export const BLANK_MARGIN_X = 8;   // blanking rectangle overhang, each side
export const BLANK_MARGIN_Y = 4;

/**
 * The CLI's baseline: 8pt above the plate's bottom edge. Used only when the ink
 * of the label cannot be measured (see inkBandAtSize()), which means a
 * standard-14 font; every footer font this application offers is embedded.
 */
export const TEXT_BASELINE_OFFSET = 8;

/** Composited equivalent of the CLI's 0.94 grey at 0.7 alpha over white. */
const PLATE_GREY = 0.958;

/**
 * The transformation from visible-page coordinates to unrotated user space.
 *
 * With /Rotate R the viewer turns the page R degrees clockwise. A page that is
 * W x H unrotated is displayed H x W at 90 and 270. Mapping a visible point
 * (vx, vy) back to user space (ux, uy):
 *
 *     R=0     ux = vx           uy = vy
 *     R=90    ux = W - vy       uy = vx
 *     R=180   ux = W - vx       uy = H - vy
 *     R=270   ux = vy           uy = H - vx
 *
 * A PDF `cm` matrix [a b c d e f] computes x' = a.x + c.y + e, y' = b.x + d.y + f,
 * which gives the four matrices below. Checked against page corners: at R=90
 * visible (0,0) maps to user (W,0), which is where the displayed bottom-left
 * corner physically is.
 *
 * The origin arguments carry the page box's own offset. A page box does not
 * have to start at (0, 0), a CropBox frequently does not, and a footer
 * positioned as though it did lands outside the area the reader actually
 * displays. An invisible page number reads as an unnumbered page, which in a
 * court bundle is a defect rather than a cosmetic problem.
 *
 * @param {number} rotation - 0, 90, 180 or 270
 * @param {number} width  - unrotated page width
 * @param {number} height - unrotated page height
 * @param {number} [originX=0] - page box x offset
 * @param {number} [originY=0] - page box y offset
 * @returns {[number, number, number, number, number, number]}
 */
export function visibleToUserMatrix(rotation, width, height, originX = 0, originY = 0) {
  let m;
  switch (((rotation % 360) + 360) % 360) {
    case 90:  m = [0, 1, -1, 0, width, 0]; break;
    case 180: m = [-1, 0, 0, -1, width, height]; break;
    case 270: m = [0, -1, 1, 0, 0, height]; break;
    default:  m = [1, 0, 0, 1, 0, 0];
  }
  m[4] += originX;
  m[5] += originY;
  return m;
}

/** Applies visibleToUserMatrix to a point. */
export function visibleToUser(rotation, width, height, vx, vy, originX = 0, originY = 0) {
  const [a, b, c, d, e, f] = visibleToUserMatrix(rotation, width, height, originX, originY);
  return [a * vx + c * vy + e, b * vx + d * vy + f];
}

/**
 * The visible-space size of a page once /Rotate is applied.
 * @returns {{width: number, height: number}}
 */
export function visibleSize(rotation, width, height) {
  const r = ((rotation % 360) + 360) % 360;
  return (r === 90 || r === 270) ? { width: height, height: width } : { width, height };
}

/**
 * Plate rectangle in VISIBLE coordinates, from BundleToolCLI's
 * page_number_box_rect(): width is the text width plus 20, height 26, sitting
 * 8pt up from the bottom edge.
 *
 * `align` positions it along the bottom edge; the CLI only ever centres, which
 * is the default here too.
 *
 * @param {number} textWidth
 * @param {number} visibleWidth
 * @param {string} [align='centre'] - 'left' | 'right' | 'centre' | 'center'
 * @param {number} [minHeight=PLATE_HEIGHT] - grows for very large footer fonts
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function plateRect(textWidth, visibleWidth, align = 'centre', minHeight = PLATE_HEIGHT) {
  const width = textWidth + PLATE_PADDING;
  const height = Math.max(PLATE_HEIGHT, minHeight);
  const margin = 30;
  let x;
  if (align === 'left') x = margin;
  else if (align === 'right') x = visibleWidth - width - margin;
  else x = visibleWidth / 2 - width / 2;
  return { x, y: PLATE_Y, width, height };
}

/**
 * The vertical extent of the INK of `texts`: where the drawn glyphs actually
 * start and stop: in points above and below the baseline.
 *
 * Not the font's ascender and descender. Liberation Sans declares an ascender
 * of 1854 units where the tallest glyph in "Bundle Page 1000" reaches 1484, so
 * centring on the declared em box puts the label visibly low in its plate. The
 * glyph bounding box of the actual string does not have that problem.
 *
 * Returns null when the font cannot be measured this way: a standard-14 font
 * has no glyph outlines to consult, and the caller falls back to the CLI's
 * fixed baseline.
 *
 * @param {Object} font - an embedded pdf-lib font
 * @param {string[]} texts - every label this document will draw
 * @param {number} size
 * @returns {{top: number, bottom: number}|null} top > 0, bottom <= 0
 */
export function inkBandAtSize(font, texts, size) {
  // pdf-lib's CustomFontEmbedder keeps the fontkit font on `.font`; the
  // standard-font embedder has no equivalent, which is the case ruled out here.
  const fk = font?.embedder?.font;
  if (typeof fk?.layout !== 'function' || !(fk.unitsPerEm > 0)) return null;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const text of texts) {
    if (!text) continue;
    const bbox = fk.layout(text)?.bbox;
    if (!bbox || !Number.isFinite(bbox.minY) || !Number.isFinite(bbox.maxY)) continue;
    if (bbox.minY < minY) minY = bbox.minY;
    if (bbox.maxY > maxY) maxY = bbox.maxY;
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY <= minY) return null;

  const scale = size / fk.unitsPerEm;
  return { top: maxY * scale, bottom: Math.min(0, minY * scale) };
}

/**
 * The baseline for a label whose ink band is `ink`, so that the ink is centred
 * in a plate of `plateHeight` starting at `plateY`.
 *
 * @param {number} plateY
 * @param {number} plateHeight
 * @param {{top: number, bottom: number}|null} ink
 * @returns {number}
 */
export function baselineFor(plateY, plateHeight, ink) {
  if (!ink) return plateY + TEXT_BASELINE_OFFSET;
  const inkHeight = ink.top - ink.bottom;
  return plateY + (plateHeight - inkHeight) / 2 - ink.bottom;
}

/**
 * Draws the footer on one page: blanking rectangle, plate, text, and the link
 * back to the index.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} pdfDoc
 * @param {import('./bundletoolPdfLib.js').PDFPage} page
 * @param {Object} opts
 * @param {string} opts.text
 * @param {Object} opts.font        - an embedded pdf-lib font
 * @param {import('./bundletoolPdfLib.js').PDFName|string} opts.fontKey
 * @param {number} opts.fontSize
 * @param {Object} opts.colour      - pdf-lib rgb() colour for the text
 * @param {string} [opts.align]
 * @param {number} [opts.maxTextWidth] - width of the widest footer text in this
 *        document. The plate and the blanking rectangle are both sized from
 *        this rather than from `text`, so the box is the same on every page and
 *        the label is centred inside it. Defaults to this page's own text width.
 * @param {{top: number, bottom: number}|null} [opts.textInk] - ink band of the
 *        document's labels, from inkBandAtSize(); positions the baseline. Null
 *        falls back to the CLI's fixed 8pt baseline.
 * @param {number|null} [opts.indexPageIndex] - link target; null for no link
 * @param {boolean} [opts.drawBlanking=true]  - false only for the negative-control test
 * @param {Object|null} [opts.plateColour] - pdf-lib rgb() colour for the plate;
 *        null keeps the CLI's composited grey
 * @param {number} [opts.plateOpacity=1] - 0..1. At 0 neither the plate NOR the
 *        blanking rectangle is drawn: the user asked for no box, and a white
 *        box is still a box. Below 1 the plate is drawn through a real
 *        ExtGState alpha and the blanking is skipped too, because an opaque
 *        white rectangle under a translucent plate would composite back to a
 *        box. Either way the re-bundle backstop the blanking provides is
 *        given up knowingly; the tagged-stream removal still handles bundles
 *        this tool made.
 */
export function drawFooterOnPage(pdfDoc, page, {
  text, font, fontKey, fontSize, colour, align = 'centre',
  maxTextWidth = null, textInk = null, indexPageIndex = null, drawBlanking = true,
  plateColour = null, plateOpacity = 1, offset = 0,
}) {
  const context = pdfDoc.context;
  // CropBox, not MediaBox: the CropBox is the region a reader displays, and
  // pdf-lib falls back to the MediaBox when no CropBox is set. Positioning
  // against the MediaBox on a cropped page puts the footer outside the visible
  // area entirely.
  const box = page.getCropBox();
  const width = box.width;
  const height = box.height;
  const rotation = page.getRotation().angle;
  const visible = visibleSize(rotation, width, height);

  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const textHeight = font.heightAtSize(fontSize);

  // One plate size for the whole document: page 7 and page 1017 get the same
  // box, and the shorter label is centred inside it. See the file header.
  const plateTextWidth = Math.max(textWidth, maxTextWidth ?? textWidth);
  const plate = plateRect(plateTextWidth, visible.width, align, textHeight + 10);
  // The vertical nudge (pageNumbering.footerOffset). Applied to the plate as a
  // whole, AFTER it is built, so the blanking rectangle, the plate and the
  // baseline all move together: the geometry between them must not be
  // re-derived per element.
  // Validation bounds it to -30..+60pt; beyond that it leaves the page.
  if (offset) plate.y += offset;

  const ops = [
    pushGraphicsState(),
    concatTransformationMatrix(...visibleToUserMatrix(rotation, width, height, box.x, box.y)),
  ];

  // 1. Blanking rectangle FIRST: the whole reason this function exists.
  //    Skipping it is what the negative-control test does. Also skipped for
  //    any non-opaque plate: a white box under a translucent (or absent)
  //    plate is still a box, which is exactly what the user turned off.
  if (drawBlanking && plateOpacity >= 1) {
    ops.push(
      setFillingGrayscaleColor(1),
      rectangle(
        plate.x - BLANK_MARGIN_X,
        plate.y - BLANK_MARGIN_Y,
        plate.width + BLANK_MARGIN_X * 2,
        plate.height + BLANK_MARGIN_Y * 2,
      ),
      fill(),
    );
  }

  // 2. The plate. Colour and opacity are the user's settings; the defaults
  //    reproduce the CLI's composited grey exactly.
  if (plateOpacity > 0) {
    if (plateOpacity < 1) {
      const gs = context.obj({ Type: 'ExtGState', ca: plateOpacity });
      ops.push(setGraphicsState(page.node.newExtGState('GS', context.register(gs))));
    }
    ops.push(
      plateColour
        ? setFillingRgbColor(plateColour.red, plateColour.green, plateColour.blue)
        : setFillingGrayscaleColor(PLATE_GREY),
      rectangle(plate.x, plate.y, plate.width, plate.height),
      fill(),
    );
    if (plateOpacity < 1) {
      // Back to full opacity for the text: only the plate is translucent.
      const gs = context.obj({ Type: 'ExtGState', ca: 1 });
      ops.push(setGraphicsState(page.node.newExtGState('GS', context.register(gs))));
    }
  }

  // 3. The number itself, centred on the plate on BOTH axes.
  //    Horizontally: textWidth is the width of the string that is about to be
  //    drawn, measured with the font it is drawn in, so the two cannot drift.
  //    Vertically: from the ink band, not the em box. See the file header.
  const key = fontKey instanceof PDFName ? fontKey : PDFName.of(String(fontKey));
  ops.push(
    beginText(),
    setFillingRgbColor(colour.red, colour.green, colour.blue),
    setFontAndSize(key, fontSize),
    moveText(
      plate.x + (plate.width - textWidth) / 2,
      baselineFor(plate.y, plate.height, textInk),
    ),
    showText(font.encodeText(text)),
    endText(),
    popGraphicsState(),
  );

  // The footer lives in its own tagged stream so it can be removed exactly.
  const dict = context.obj({});
  dict.set(PDFName.of(FOOTER_STREAM_KEY), PDFBool.True);
  const stream = PDFContentStream.of(dict, ops);
  page.node.addContentStream(context.register(stream));

  // 4. Link back to the index, over the plate. The annotation rectangle is in
  //    unrotated user space, so map both plate corners out of visible space and
  //    normalise: after a 90 or 270 rotation the corners swap order.
  if (indexPageIndex != null) {
    const [ax, ay] = visibleToUser(rotation, width, height, plate.x, plate.y, box.x, box.y);
    const [bx, by] = visibleToUser(
      rotation, width, height, plate.x + plate.width, plate.y + plate.height, box.x, box.y,
    );
    addLinkAnnotation(pdfDoc, page, [
      Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by),
    ], indexPageIndex);
  }
}

/**
 * Removes footer content streams this module wrote.
 *
 * Exact, not heuristic: it drops the streams carrying the /BundleToolFooter
 * marker. A footer without the marker is handled by the colour-matching
 * fallback in bundletoolRestore.js.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} pdfDoc
 * @returns {number} number of footer streams removed
 */
export function removeTaggedFooters(pdfDoc) {
  const context = pdfDoc.context;
  let removed = 0;

  for (const page of pdfDoc.getPages()) {
    let contents = page.node.get(PDFName.of('Contents'));
    if (contents instanceof PDFRef) contents = context.lookup(contents);
    if (!(contents instanceof PDFArray)) continue;

    const keep = [];
    for (let i = 0; i < contents.size(); i++) {
      const ref = contents.get(i);
      const stream = context.lookup(ref);
      const isFooter = stream?.dict?.get?.(PDFName.of(FOOTER_STREAM_KEY)) != null;
      if (isFooter) removed++;
      else keep.push(ref);
    }
    if (keep.length === contents.size()) continue;

    const replacement = PDFArray.withContext(context);
    for (const ref of keep) replacement.push(ref);
    page.node.set(PDFName.of('Contents'), replacement);
  }

  return removed;
}

/**
 * Fetches an embedded font and registers it in a page's resource dictionary,
 * returning the key the content stream should use.
 *
 * @returns {import('./bundletoolPdfLib.js').PDFName}
 */
export function registerPageFont(page, font) {
  return page.node.newFontDictionary(font.name, font.ref);
}
