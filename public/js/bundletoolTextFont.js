/**
 * Which font draws a piece of text that is not part of the document's own typography (the watermark,
 * a split part's cover title).
 *
 * The built-in Helvetica covers Western European text (WinAnsi) and nothing more: Welsh w and y with
 * a circumflex, Polish, Turkish and other letters would print as "?" with no warning. So when the
 * text needs more than that, it is drawn in Liberation Sans (SIL OFL, the metric match for Arial,
 * already shipped for the footers under public/fonts), embedded as a subset of just the glyphs used
 * and fetched only then, so ordinary text still costs nothing extra. A character no font here has
 * (Chinese, Japanese, emoji) is replaced by "?" and reported to the caller.
 */
import { StandardFonts, getFontkit } from './bundletoolPdfLib.js';
import { withBase } from './bundletoolFontSettings.js';
import { missingFrom, drawable } from '/js/shared/font-fallback.js';

export { missingFrom, drawable };

const LIBERATION = {
  regular: '/fonts/arialalt/liberation-sans/LiberationSans-Regular.ttf',
  bold: '/fonts/arialalt/liberation-sans/LiberationSans-Bold.ttf',
};
const fontBytes = new Map();

async function loadLiberation(weight) {
  if (!fontBytes.has(weight)) {
    const url = withBase(LIBERATION[weight]);
    fontBytes.set(weight, fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load ${url}`);
      return new Uint8Array(await response.arrayBuffer());
    }).catch((error) => { fontBytes.delete(weight); throw error; }));
  }
  return fontBytes.get(weight);
}

/**
 * The font to draw `text` in on `doc`: Helvetica (or Helvetica Bold) when it can draw every
 * character, otherwise a Liberation Sans subset.
 *
 * @returns {Promise<{font: object, text: string, unprintable: string[], unicode: boolean}>}
 *   `text` is the text with any character no font can draw replaced by "?", and `unprintable` lists
 *   those characters.
 */
export async function textFontFor(doc, text, { bold = false } = {}) {
  const helvetica = await doc.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  if (missingFrom(text, helvetica).length === 0) {
    return { font: helvetica, text: String(text), unprintable: [], unicode: false };
  }
  try {
    const bytes = await loadLiberation(bold ? 'bold' : 'regular');
    doc.registerFontkit(await getFontkit());
    const wide = await doc.embedFont(bytes, { subset: true });
    return { font: wide, text: drawable(text, wide), unprintable: missingFrom(text, wide), unicode: true };
  } catch {
    // The wider font could not be loaded (offline, blocked): keep Helvetica and say what it cannot draw.
    return { font: helvetica, text: drawable(text, helvetica), unprintable: missingFrom(text, helvetica), unicode: false };
  }
}

export { unlikelyToPrint } from './bundletoolGlyphs.js';
