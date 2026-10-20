/**
 * A quick judgement, from Unicode ranges alone and with no import, of which typed characters a PDF
 * font shipped here is unlikely to have. It lets the entry field warn while the person types without
 * loading the PDF library; the real decision is made at build time from the font itself
 * (bundletoolTextFont.js).
 */
/**
 * The characters of `text` that Liberation Sans is unlikely to have, judged from Unicode ranges
 * alone (no font needed), for a warning at the point of typing. Latin, Greek and Cyrillic and the
 * usual punctuation pass; Chinese, Japanese, Korean, Arabic, Hebrew, emoji and the like do not.
 */
export function unlikelyToPrint(text) {
  const ok = (cp) => cp < 0x0250 || (cp >= 0x0250 && cp <= 0x036f) || (cp >= 0x0370 && cp <= 0x052f)
    || (cp >= 0x1e00 && cp <= 0x1eff) || (cp >= 0x2000 && cp <= 0x206f) || (cp >= 0x20a0 && cp <= 0x20cf)
    || (cp >= 0x2100 && cp <= 0x218f);
  const bad = new Set();
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (!ok(cp)) bad.add(ch);
  }
  return [...bad];
}
