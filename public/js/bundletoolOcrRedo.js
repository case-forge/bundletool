/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolOcrRedo.js
 * Taking a page's existing invisible text layer off before a new one is drawn, so reading a page again replaces its text
 * instead of adding a second copy of it. This is what OCRmyPDF's redo mode does ("Invisible text (OCR) is stripped
 * out"), and the rule is the same: invisible text is text drawn in render mode 3 (fill nothing, stroke nothing). Every
 * OCR layer is drawn that way, whichever program made it: BundleTool's own, Tesseract's PDF renderer and OCRmyPDF's.
 *
 * WHAT IS NEVER TOUCHED. Text in any other render mode (filled, stroked, clipping) and everything that is not text.
 * A text object (BT ... ET) loses its showing operators only when every one of them is invisible; one that mixes
 * invisible and other text is left exactly as it is, because taking out a show moves the text after it in the same
 * object. Within a Form XObject, text shown before the form sets its own render mode inherits whatever mode the page
 * had when it drew the form, so it counts as unknown and its text object is left alone. Text state set in a text object
 * (font, spacing, scaling, the render mode itself) carries on after it ends, so only the showing operators go: `'` is
 * replaced by the line move it makes and `"` by the spacing it sets and the line move. A stream that cannot be read
 * with certainty (an unterminated string, an inline image without its end) is left exactly as it is.
 *
 * The page's look cannot change: invisible text draws nothing. tests/ocrRedo.test.mjs checks that a page with visible
 * text, a mixed text object, clipping text and an inline image renders pixel for pixel the same afterwards.
 */

import { PDFName, PDFArray, PDFDict, PDFRef, PDFRawStream, decodePDFRawStream } from './bundletoolPdfLib.js';

const INVISIBLE = 3;
const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const SHOWS = new Set(['Tj', 'TJ', "'", '"']);

/** Where the literal string starting at `i` (its opening parenthesis) ends, just past its closing one; -1 if it never does. */
function endOfString(b, i) {
  let depth = 0;
  for (let j = i; j < b.length; j++) {
    const c = b[j];
    if (c === 0x5c) { j++; continue; }        // a backslash escapes the next byte
    if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) return j + 1;
  }
  return -1;
}

/**
 * Splits a content stream into operations: each operator with the operands before it, as byte ranges. Returns null
 * when the stream cannot be read with certainty.
 *
 * @param {Uint8Array} b
 * @returns {{start: number, end: number, op: string, operands: {start: number, end: number}[]}[] | null}
 */
export function parseContent(b) {
  const ops = [];
  let operands = [];
  let opStart = -1;
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && b[i] !== 0x0a && b[i] !== 0x0d) i++; continue; }   // a comment
    const start = i;
    if (c === 0x28) {
      i = endOfString(b, i);
      if (i < 0) return null;
    } else if (c === 0x3c && b[i + 1] === 0x3c) {                                         // << ... >>, nested
      let depth = 0;
      while (i < n) {
        if (b[i] === 0x28) { i = endOfString(b, i); if (i < 0) return null; continue; }
        if (b[i] === 0x3c && b[i + 1] === 0x3c) { depth++; i += 2; continue; }
        if (b[i] === 0x3e && b[i + 1] === 0x3e) { depth--; i += 2; if (depth === 0) break; continue; }
        i++;
      }
      if (depth !== 0) return null;
    } else if (c === 0x3c) {                                                               // <hex>
      while (i < n && b[i] !== 0x3e) i++;
      if (i >= n) return null;
      i++;
    } else if (c === 0x5b) {                                                               // [ ... ], nested
      let depth = 0;
      while (i < n) {
        if (b[i] === 0x28) { i = endOfString(b, i); if (i < 0) return null; continue; }
        if (b[i] === 0x5b) depth++;
        else if (b[i] === 0x5d && --depth === 0) { i++; break; }
        i++;
      }
      if (depth !== 0) return null;
    } else if (c === 0x2f) {                                                               // /Name
      i++;
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    } else if (c === 0x29 || c === 0x3e || c === 0x5d || c === 0x7b || c === 0x7d) {
      return null;                                                                         // a stray delimiter
    } else {
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      const word = String.fromCharCode(...b.subarray(start, i));
      if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) && word !== 'true' && word !== 'false' && word !== 'null') {
        // An operator. An inline image's data runs from ID to EI and is skipped whole.
        if (word === 'ID') {
          let j = i + 1;
          while (j < n - 1 && !(WS.has(b[j - 1]) && b[j] === 0x45 && b[j + 1] === 0x49 && (j + 2 >= n || WS.has(b[j + 2])))) j++;
          if (j >= n - 1) return null;
          i = j + 2;
          ops.push({ start: opStart < 0 ? start : opStart, end: i, op: 'ID', operands });
        } else {
          ops.push({ start: opStart < 0 ? start : opStart, end: i, op: word, operands });
        }
        operands = [];
        opStart = -1;
        continue;
      }
    }
    if (opStart < 0) opStart = start;
    operands.push({ start, end: i });
  }
  return ops;
}

/**
 * Takes the invisible text out of one content stream (see this file's header comment).
 *
 * @param {Uint8Array} bytes - the decoded content stream
 * @param {{mode?: number|null}} [opts] - the render mode the stream starts in: 0 for a page, null (unknown) for a form
 * @returns {{bytes: Uint8Array, removed: number}} removed: how many showing operators were taken out (0: unchanged)
 */
export function stripInvisibleText(bytes, { mode = 0 } = {}) {
  const ops = parseContent(bytes);
  if (!ops) return { bytes, removed: 0 };
  const replace = new Map();   // op index -> replacement text ('' to drop)
  const stack = [];
  let tr = mode;
  let block = null;
  for (let k = 0; k < ops.length; k++) {
    const { op, operands } = ops[k];
    if (op === 'q') stack.push(tr);
    else if (op === 'Q') tr = stack.length ? stack.pop() : tr;
    else if (op === 'Tr') {
      const v = Number(String.fromCharCode(...bytes.subarray(operands[0]?.start ?? 0, operands[0]?.end ?? 0)));
      tr = Number.isInteger(v) ? v : null;
    } else if (op === 'BT') block = { shows: [], keep: false };
    else if (op === 'ET') {
      if (block && !block.keep) for (const s of block.shows) replace.set(s, replacementFor(ops[s], bytes));
      block = null;
    } else if (SHOWS.has(op)) {
      if (!block) continue;                       // a show outside a text object: malformed, left alone
      if (tr === INVISIBLE) block.shows.push(k);
      else block.keep = true;
    }
  }
  if (!replace.size) return { bytes, removed: 0 };
  const parts = [];
  let at = 0;
  for (const [k, text] of [...replace].sort((a, b) => a[0] - b[0])) {
    parts.push(bytes.subarray(at, ops[k].start), new TextEncoder().encode(text));
    at = ops[k].end;
  }
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { bytes: out, removed: replace.size };
}

/** What a removed show leaves behind: nothing, or the line move and spacing `'` and `"` make besides showing text. */
function replacementFor({ op, operands }, bytes) {
  if (op === "'") return ' T*';
  if (op === '"') {
    const t = (o) => String.fromCharCode(...bytes.subarray(o.start, o.end));
    return ` ${t(operands[0])} Tw ${t(operands[1])} Tc T*`;
  }
  return '';
}

/** The streams a page's /Contents holds, in order: [ref or direct stream]. */
function contentStreams(page) {
  const { context } = page.doc;
  let contents = page.node.get(PDFName.of('Contents'));
  const direct = contents instanceof PDFRef ? context.lookup(contents) : contents;
  if (direct instanceof PDFArray) return direct.asArray();
  return contents ? [contents] : [];
}

/** True for a content stream that straightens a page or puts it back (bundletoolOcrReorient.js's markers). */
function isReorientMarker(stream) {
  const dict = stream?.dict;
  return Boolean(dict?.get(PDFName.of('BundleToolStraighten')) || dict?.get(PDFName.of('BundleToolPutBack')));
}

function decode(stream) {
  if (!(stream instanceof PDFRawStream)) return null;
  try { return decodePDFRawStream(stream).decode(); } catch { return null; }
}

/**
 * Takes a page's invisible text off: from its own content and from every Form XObject it draws, at any depth. Run
 * just before a new text layer is drawn on the page (bundletoolOcr.js's replaceOcrLayer).
 *
 * @param {import('@cantoo/pdf-lib').PDFPage} page
 * @returns {number} how many showing operators were taken out
 */
export function removeInvisibleText(page) {
  const { context } = page.doc;
  let removed = 0;

  // The page's own content, read as the one stream it is drawn as (a text object may start in one part and end in
  // the next), and written back as a single stream when anything was taken out. The streams that straighten a page or
  // put it back (bundletoolOcrReorient.js marks them) stay as they are, so a straightened page can still be put back
  // after it is read again: the content between them is taken as one stream of its own. Those streams are a q with a
  // cm and a Q, round content that is itself inside q and Q, so no text state runs from one part into the next. A
  // page with no such streams is one part, written back exactly as before.
  const refs = contentStreams(page);
  const lookup = (r) => (r instanceof PDFRef ? context.lookup(r) : r);
  const parts = [];
  let part = [];
  for (const ref of refs) {
    if (isReorientMarker(lookup(ref))) {
      if (part.length) parts.push(part);
      parts.push({ marker: ref });
      part = [];
    } else part.push(ref);
  }
  if (part.length) parts.push(part);
  const written = [];
  let changed = false;
  for (const p of parts) {
    if (p.marker) { written.push(p.marker); continue; }
    const decoded = p.map((r) => decode(lookup(r)));
    if (!decoded.every(Boolean)) { written.push(...p); continue; }
    const joined = new Uint8Array(decoded.reduce((s, d) => s + d.length + 1, 0));
    let o = 0;
    for (const d of decoded) { joined.set(d, o); o += d.length; joined[o++] = 0x0a; }
    const result = stripInvisibleText(joined, { mode: 0 });
    if (result.removed) {
      written.push(context.register(context.flateStream(result.bytes)));
      removed += result.removed;
      changed = true;
    } else written.push(...p);
  }
  // An array, as pdf-lib keeps a page's contents once it has drawn on it, so a layer drawn next is added to it.
  if (changed) page.node.set(PDFName.of('Contents'), context.obj(written));

  // Forms, each once, wherever they are drawn from.
  const seen = new Set();
  const visit = (resources) => {
    const res = resources instanceof PDFRef ? context.lookup(resources) : resources;
    if (!(res instanceof PDFDict)) return;
    let xobjects = res.get(PDFName.of('XObject'));
    if (xobjects instanceof PDFRef) xobjects = context.lookup(xobjects);
    if (!(xobjects instanceof PDFDict)) return;
    for (const value of xobjects.values()) {
      if (!(value instanceof PDFRef) || seen.has(value.toString())) continue;
      seen.add(value.toString());
      const form = context.lookup(value);
      if (!(form instanceof PDFRawStream) || form.dict.get(PDFName.of('Subtype'))?.toString() !== '/Form') continue;
      const bytes = decode(form);
      if (bytes) {
        const result = stripInvisibleText(bytes, { mode: null });
        if (result.removed) {
          const replacement = context.flateStream(result.bytes);
          for (const [key, v] of form.dict.entries()) {
            const name = key.toString();
            if (name !== '/Length' && name !== '/Filter' && name !== '/DecodeParms') replacement.dict.set(key, v);
          }
          context.assign(value, replacement);
          removed += result.removed;
        }
      }
      visit(form.dict.get(PDFName.of('Resources')));
    }
  };
  visit(page.node.Resources());
  return removed;
}
