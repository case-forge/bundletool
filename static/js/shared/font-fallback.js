/**
 * Two pure helpers for a pdf-lib font's character set, used wherever text may need more than
 * Helvetica's WinAnsi range: BundleTool's watermark and split-part cover titles, and the Envelope
 * Guide's sheet. This is the one copy both tools use.
 * Loading the wider font itself (Liberation Sans) is NOT shared: the two tools fetch it differently
 * enough (one weight at a time and cached per weight in BundleTool, both weights together with a
 * caller-supplied override in the Envelope Guide) that folding them into one function would change
 * how each caches or which requests it makes, so each keeps its own loader.
 */
const FALLBACK_CHAR = '?';

/** Every character of `text` that `font` cannot draw (newlines and other controls are not text). */
export function missingFrom(text, font) {
  const have = new Set(font.getCharacterSet());
  const missing = new Set();
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp < 32 || cp === 127) continue;
    if (!have.has(cp)) missing.add(ch);
  }
  return [...missing];
}

/** Replaces characters a font cannot draw with "?" so the text still draws. */
export function drawable(text, font) {
  const have = new Set(font.getCharacterSet());
  return String(text).replace(/[^\n]/gu, (ch) => {
    const cp = ch.codePointAt(0);
    return cp < 32 || cp === 127 || have.has(cp) ? ch : FALLBACK_CHAR;
  });
}
