/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolWatermark.js
 * A diagonal watermark, repeated across every page.
 *
 * LICENCE NOTE, as in bundletoolCover.js: this file is wholly CaseForge's, so
 * it carries no BunTool notice.
 *
 * WHY A SINGLE DIAGONAL LINE OF TEXT, not a tiled/repeated pattern: this is
 * the form a legal document watermark is expected to take (compare Word's
 * own "DRAFT"/"CONFIDENTIAL" built-in watermarks): one large, faint,
 * 45-degree mark through the centre of the page, unmistakable but never
 * obscuring the content underneath or the footer at the foot of the page.
 *
 * WHY A STANDARD FONT, not the embedded index/footer font: the watermark is
 * decorative, not part of the document's typography, and Helvetica-Bold is
 * built into every PDF reader: no fetch, no per-bundle embedding cost
 * across what can be hundreds of pages. The exception is text Helvetica cannot
 * draw (Welsh w and y with a circumflex, Polish, Turkish and so on): that is drawn
 * in a Liberation Sans Bold subset instead, see bundletoolTextFont.js.
 */

import { rgb, degrees } from './bundletoolPdfLib.js';
import { textFontFor } from './bundletoolTextFont.js';
import { visibleSize, visibleToUser } from './bundletoolFooter.js';

const GREY = rgb(0.6, 0.6, 0.6);
const GREY_HEX = '#999999';
// The opacity when nothing is configured. The same convention as the
// footer-plate opacity in bundletoolPages.js: stored as 0-100, clamped,
// converted to a 0-1 fraction here.
const DEFAULT_OPACITY = 28;

/**
 * Converts a stored 0-100 opacity setting to the 0-1 fraction pdf-lib wants,
 * same clamp/fallback shape as the footer-plate opacity in
 * bundletoolPages.js so the two behave identically at their edges.
 *
 * @param {number} [opacity100]
 */
export function watermarkOpacityFraction(opacity100) {
  // == null catches both undefined and null before Number() coerces either
  // into a real number (Number(null) is 0, not NaN, which would otherwise
  // read as "opacity 0" rather than "not configured").
  if (opacity100 == null) return DEFAULT_OPACITY / 100;
  const raw = Number(opacity100);
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw / 100)) : DEFAULT_OPACITY / 100;
}

/**
 * Parses a `#rrggbb` hex string into a pdf-lib rgb() colour, or returns the
 * default grey for anything else (empty, invalid, or the default swatch
 * itself), the same convention as the footer-background plate colour in
 * bundletoolPages.js: the picker's own default value is treated as "no
 * override", not as a real colour choice.
 *
 * @param {string} hex
 */
function watermarkColourFromHex(hex) {
  const value = String(hex ?? '').trim().toLowerCase();
  if (value === GREY_HEX || !/^#[0-9a-f]{6}$/.test(value)) return GREY;
  return rgb(
    parseInt(value.slice(1, 3), 16) / 255,
    parseInt(value.slice(3, 5), 16) / 255,
    parseInt(value.slice(5, 7), 16) / 255,
  );
}

/**
 * Draws one diagonal watermark across a page, centred, rotated bottom-left
 * to top-right. Sized to the page's own diagonal so it reads the same way
 * on A4, Letter and Legal without a separate size table.
 *
 * @param {Object} page - a pdf-lib page
 * @param {Object} font - an embedded/standard pdf-lib font
 * @param {string} text
 * @param {string} [colourHex] - a `#rrggbb` hex string; falls back to grey
 * @param {number} [opacity100] - 0-100; falls back to 28
 */
export function drawWatermarkOnPage(page, font, text, colourHex, opacity100) {
  const value = String(text ?? '').trim();
  if (!value) return;
  // Everything is worked out in the page AS DISPLAYED (the way the footer is), then mapped back
  // to the page's own coordinates, so the mark runs bottom-left to top-right and reads upright on
  // a page turned 90, 180 or 270 degrees as well. Drawn in unrotated coordinates it would be
  // upside down on the last two.
  const box = page.getCropBox();
  const rotation = page.getRotation().angle;
  const { width, height } = visibleSize(rotation, box.width, box.height);
  const angle = Math.atan2(height, width) * (180 / Math.PI);          // as displayed
  const drawAngle = angle + (((rotation % 360) + 360) % 360);         // in the page's own coordinates

  // Start from a size capped relative to the page's short side, then shrink
  // until the rotated text fits within the page's own diagonal minus a small
  // margin, so a long watermark string (a firm's full name, say) never runs
  // off the page. The cap keeps a SHORT word in proportion: starting from 0.9
  // x the short side (about 535pt on A4), only long text would shrink, and
  // "CONFID" would be drawn with letters taller than the page is wide. 0.22
  // gives about 130pt on A4, a heavy mark that still leaves the page readable,
  // and "CONFIDENTIAL" still shrinks to fit the diagonal.
  const diagonal = Math.sqrt(width * width + height * height);
  let size = Math.min(width, height) * 0.22;
  while (size > 6 && font.widthOfTextAtSize(value, size) > diagonal * 0.82) {
    size -= 2;
  }

  const textWidth = font.widthOfTextAtSize(value, size);
  const rad = (drawAngle * Math.PI) / 180;
  // Centre the rotated text block on the page centre: pdf-lib rotates
  // around the text's own origin (bottom-left of the string, pre-rotation),
  // so the origin has to be walked back along the rotation vector by half
  // the string's own length first.
  const [cx, cy] = visibleToUser(rotation, box.width, box.height, width / 2, height / 2, box.x, box.y);
  const x = cx - (textWidth / 2) * Math.cos(rad);
  const y = cy - (textWidth / 2) * Math.sin(rad);

  page.drawText(value, {
    x, y, size, font,
    color: watermarkColourFromHex(colourHex),
    opacity: watermarkOpacityFraction(opacity100),
    rotate: degrees(drawAngle),
  });
}

/**
 * Draws the watermark on every page of a document, once. A single font embed
 * (Helvetica Bold, or a Liberation Sans Bold subset) is shared across the
 * whole document rather than re-embedded per page; see the file header for
 * why a standard font is the first choice here.
 *
 * @param {Object} doc - a pdf-lib PDFDocument
 * @param {string} text
 * @param {string} [colourHex] - a `#rrggbb` hex string; falls back to grey
 * @param {number} [opacity100] - 0-100; falls back to 28
 */
export async function applyWatermarkToDoc(doc, text, colourHex, opacity100) {
  const wanted = String(text ?? '').trim();
  if (!wanted) return;
  // Helvetica Bold when it can draw every character, otherwise a Liberation Sans Bold subset; a
  // character neither has is drawn as "?" (the entry field warns about those as they are typed).
  const { font, text: value } = await textFontFor(doc, wanted, { bold: true });
  for (const page of doc.getPages()) {
    drawWatermarkOnPage(page, font, value, colourHex, opacity100);
  }
}
