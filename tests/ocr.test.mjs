/**
 * bundletoolOcr.js's two pure functions, without a browser or a live OCR engine: needsOcr() against
 * synthetic pdf.js-shaped text items, embedOcrLayer() against a real pdf-lib page, read back through
 * pdf-lib's own low-level object model to confirm what was actually written (render mode, position,
 * that the page's own pre-existing content is untouched) rather than trusting drawText() did the
 * right thing unread.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, TextRenderingMode, PDFName } from '../public/js/bundletoolPdfLib.js';
import { needsOcr, embedOcrLayer, groupIntoLines, wordShape, OCR_MIN_CHARS, OCR_RASTER_DPI } from '../public/js/bundletoolOcr.js';
import { uprightGeometry, applyAffine } from '../public/js/bundletoolDeskew.js';

test('a page with a real text layer at or over the threshold does not need OCR', () => {
  assert.equal(needsOcr([{ str: 'x'.repeat(OCR_MIN_CHARS) }]), false);
  assert.equal(needsOcr([{ str: 'x'.repeat(OCR_MIN_CHARS - 1) }]), true, 'one short of the threshold still needs it');
});

test('an empty or missing text layer needs OCR', () => {
  assert.equal(needsOcr([]), true);
  assert.equal(needsOcr(null), true);
  assert.equal(needsOcr(undefined), true);
});

test('several short items are summed, not judged one at a time', () => {
  const items = Array.from({ length: 10 }, () => ({ str: 'abcd' })); // 40 chars total
  assert.equal(needsOcr(items), false, '40 chars across 10 items still clears the threshold');
  assert.equal(needsOcr(items.slice(0, 9)), true, '36 chars does not');
});

test('an item with no str, or an empty str, contributes nothing and does not throw', () => {
  assert.equal(needsOcr([{}, { str: '' }, { str: null }]), true);
});

async function pageWithFont() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4 in points
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, page, font };
}

/** The operators actually written to the page's content stream(s), decoded as text. Empty when
 * nothing was ever drawn, since drawText() is what creates the content stream in the first place. */
function contentOps(page) {
  const refs = page.node.Contents();
  if (!refs) return '';
  const arr = refs.array ? refs.array : [refs];
  return arr
    .map((ref) => page.doc.context.lookup(ref).getContentsString())
    .join('\n');
}

/** Decodes a pdf-lib hex string operand, e.g. "<5245414C>", back to text (Latin-1/WinAnsi range). */
function hexToText(hex) {
  return Buffer.from(hex, 'hex').toString('latin1');
}

test('embedOcrLayer writes an invisible text render mode, not a visible one', async () => {
  const { page, font } = await pageWithFont();
  embedOcrLayer(page, font, [{ text: 'HELLO', x0: 100, y0: 100, x1: 300, y1: 130 }], OCR_RASTER_DPI);
  const ops = contentOps(page);
  assert.match(ops, /\b3\s+Tr\b/, 'the invisible render mode operator (3 Tr) is present');
  assert.doesNotMatch(ops, /\b0\s+Tr\b/, 'no fill (visible) render mode was also written');
  assert.equal(TextRenderingMode.Invisible, 3, 'sanity: the enum this file relies on is still 3');
});

test('a word positions inside the page, converted from raster pixels to PDF points at the given DPI', async () => {
  const { page, font } = await pageWithFont();
  const dpi = 200;
  const scale = 72 / dpi;
  // A box near the top-left of a 200dpi raster of this A4 page.
  const box = { text: 'Test', x0: 200, y0: 200, x1: 400, y1: 230 };
  embedOcrLayer(page, font, [box], dpi);
  const ops = contentOps(page);
  // pdf-lib positions drawText with a full text matrix (Tm: a b c d e f), not Td; e and f are the
  // translation, at index 5 and 6.
  const m = ops.match(/1\s+0\s+0\s+1\s+([\d.]+)\s+([\d.]+)\s+Tm/);
  assert.ok(m, 'a text-matrix (Tm) operator was written');
  const [, xStr, yStr] = m;
  const x = parseFloat(xStr);
  const y = parseFloat(yStr);
  const expectedX = box.x0 * scale;
  const { height: pageHeightPt } = page.getSize();
  const expectedYTop = pageHeightPt - box.y0 * scale;
  assert.ok(Math.abs(x - expectedX) < 1, `x ${x} within 1pt of expected ${expectedX}`);
  // y is the baseline, dropped below the box's own top by some fraction of the drawn size, so
  // check it lands strictly below the top and strictly above the box's own bottom edge in point
  // space, rather than asserting one exact baseline offset formula the test would just restate.
  const expectedYBottom = pageHeightPt - box.y1 * scale;
  assert.ok(y < expectedYTop && y > expectedYBottom - 20, `y ${y} plausible between the box's edges`);
});

test('blank or whitespace-only recognised words are skipped, not drawn as empty text objects', async () => {
  const { page, font } = await pageWithFont();
  embedOcrLayer(page, font, [
    { text: '   ', x0: 0, y0: 0, x1: 50, y1: 20 },
    { text: '', x0: 0, y0: 0, x1: 50, y1: 20 },
  ], OCR_RASTER_DPI);
  const ops = contentOps(page);
  assert.doesNotMatch(ops, /\bTj\b/, 'no text-show operator for either blank word');
});

test('a zero-area box (a degenerate OCR result) is skipped rather than producing a NaN/Infinity size', async () => {
  const { page, font } = await pageWithFont();
  embedOcrLayer(page, font, [{ text: 'X', x0: 100, y0: 100, x1: 100, y1: 100 }], OCR_RASTER_DPI);
  const ops = contentOps(page);
  assert.doesNotMatch(ops, /\bTj\b/);
});

/** The squeeze (Tz, percent) and font size written for each drawn word, in order. */
function drawnWords(page) {
  return [...contentOps(page).matchAll(/([\d.]+)\s+Tz[\s\S]*?\/[\w-]+\s+([\d.]+)\s+Tf[\s\S]*?<([0-9A-Fa-f]+)>\s*Tj/g)]
    .map((m) => ({ squeeze: parseFloat(m[1]), size: parseFloat(m[2]), text: hexToText(m[3]) }));
}

test('a word is stretched to its own box with horizontal scaling, so it fills the box it was found in', async () => {
  const { page, font } = await pageWithFont();
  embedOcrLayer(page, font, [{ text: 'quick', x0: 100, y0: 100, x1: 300, y1: 143 }], OCR_RASTER_DPI);
  const [w] = drawnWords(page);
  assert.ok(w, 'a word was drawn with a Tz');
  const drawn = (font.widthOfTextAtSize('quick', w.size) * w.squeeze) / 100;
  assert.ok(Math.abs(drawn - 200 * (72 / OCR_RASTER_DPI)) < 0.5, `drawn width ${drawn} matches the box width`);
});

test('a word wider than its own box is squeezed, then shrunk, never drawn wider than the box it was found in', async () => {
  const { page, font } = await pageWithFont();
  const text = 'a much longer recognised phrase than the box below it';
  // A box far too narrow for this much text at any sane starting size.
  embedOcrLayer(page, font, [{ text, x0: 100, y0: 100, x1: 140, y1: 118 }], OCR_RASTER_DPI);
  const [w] = drawnWords(page);
  assert.ok(w, 'a word was drawn');
  const boxWidthPt = (140 - 100) * (72 / OCR_RASTER_DPI);
  const drawn = (font.widthOfTextAtSize(text, w.size) * w.squeeze) / 100;
  assert.ok(drawn <= boxWidthPt + 0.5, `drawn width ${drawn} fits the box width ${boxWidthPt}`);
  assert.ok(w.squeeze >= 25, `and no thinner than the minimum squeeze (${w.squeeze}%)`);
});

test('a character the standard font cannot encode does not abort the rest of the page', async () => {
  const { page, font } = await pageWithFont();
  // U+FFFD is outside WinAnsi; pdf-lib substitutes rather than throwing for a standard font, but
  // the word after it must still be drawn either way: a bad OCR character on one word must never
  // cost the whole page its invisible text layer.
  embedOcrLayer(page, font, [
    { text: '��', x0: 0, y0: 0, x1: 50, y1: 20 },
    { text: 'REAL', x0: 60, y0: 0, x1: 150, y1: 20 },
  ], OCR_RASTER_DPI);
  const ops = contentOps(page);
  const hexStrings = [...ops.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => hexToText(m[1]));
  assert.ok(hexStrings.includes('REAL'), 'the word after the unencodable one still made it onto the page');
});

// ── Reading order. Tesseract measures each word box on its own, so words on one printed line differ
// by a pixel or two; drawn raw they have different baselines and sizes, and readers rebuild the lines wrongly.

const SENTENCE = 'the quick brown fox jumps over the lazy dog and pack my box with five dozen liquor jugs while sphinx of black quartz judge my vow'.split(' ');

/**
 * The ink box Tesseract would report for `text` printed at `fontPx` with its baseline at `baseline`: its height
 * follows the letters (a word of short letters is about half as tall as one with an ascender and a descender),
 * a trailing comma dips below the baseline, and a pixel or two of `jitter` is added to each edge. Real boxes
 * look like this; boxes of one height whatever the letters would hide what the reading-order tests below check.
 */
function inkBox(text, baseline, x0, { fontPx = 40, jitter = 0, rnd = () => 0.5 } = {}) {
  const tall = /[A-Z0-9bdfhijklt]/.test(text);
  const down = /[gjpqy]/.test(text) ? 0.21 : /[,;]/.test(text) ? 0.12 : 0;
  return {
    text, x0, x1: x0 + text.length * 20,
    y0: baseline - (tall ? 0.72 : 0.52) * fontPx + (rnd() - 0.5) * jitter,
    y1: baseline + down * fontPx + (rnd() - 0.5) * jitter,
  };
}

/** Four words a line, lines 38px apart at 200dpi, every box nudged up to `jitter` px by a seeded generator. */
function jitteredWords(jitter, seed0) {
  let seed = seed0;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let line = 0, x = 200;
  return SENTENCE.map((text, i) => {
    if (i % 4 === 0 && i) { line++; x = 200; }
    const w = inkBox(text, 330 + line * 60, x, { jitter, rnd });
    x += text.length * 20 + 12;
    return w;
  });
}

test('words are grouped into lines without being reordered, each flat line on one baseline', () => {
  const words = jitteredWords(4, 7919);
  const lines = groupIntoLines(words);
  assert.equal(lines.length, 7, 'seven lines of four words (the last has three)');
  assert.deepEqual(lines.flatMap((l) => l.words.map((w) => w.word.text)), SENTENCE, "Tesseract's own order is kept");
  for (const line of lines) {
    assert.ok(line.flat);
    assert.equal(new Set(line.words.map((w) => w.baseline)).size, 1, 'one baseline per line');
  }
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].words[0].baseline > lines[i - 1].words[0].baseline, 'baselines go down the page');
});

// Fixtures for a page that is not level, and for two columns.
function linesOfWords({ n, perLine, x0, y0, spacing, slope = 0, start = 0 }) {
  const words = [];
  let k = start;
  for (let l = 0; l < n; l++) {
    let x = x0;
    for (let i = 0; i < perLine; i++) {
      const text = SENTENCE[k++ % SENTENCE.length];
      words.push(inkBox(text, y0 + l * spacing + (x - x0) * slope, x));
      x += text.length * 20 + 14;
    }
  }
  return words;
}

test('a page about a degree off level still groups into its lines, each flattened onto one baseline', () => {
  const skewed = linesOfWords({ n: 5, perLine: 14, x0: 150, y0: 300, spacing: 45, slope: Math.tan(Math.PI / 180) });
  const lines = groupIntoLines(skewed);
  assert.equal(lines.length, 5, 'five lines, none split or merged by the drift');
  assert.ok(lines.every((l) => l.words.length === 14));
  // About 23px of drift across a 30px line: well inside FLATTEN_LIMIT line heights, so each line is one baseline.
  assert.ok(lines.every((l) => l.flat));
  for (const line of lines) assert.equal(new Set(line.words.map((w) => w.baseline)).size, 1, 'one baseline per line');
});

test('a badly skewed page keeps each word on the picture, not flattened', () => {
  // Five degrees off level: well over FLATTEN_LIMIT line heights of drift across a line.
  const skewed = linesOfWords({ n: 3, perLine: 14, x0: 150, y0: 300, spacing: 160, slope: Math.tan(5 * Math.PI / 180) });
  const lines = groupIntoLines(skewed);
  assert.equal(lines.length, 3, 'three lines');
  assert.ok(lines.every((l) => !l.flat));
  for (const line of lines) for (const { word, baseline } of line.words) {
    const { descent } = wordShape(word.text, word.y1 - word.y0);
    assert.ok(Math.abs(baseline - (word.y1 - descent)) < 1e-9, 'own baseline kept');
  }
});

test('a lightly skewed line is flattened', () => {
  const lines = groupIntoLines(linesOfWords({ n: 2, perLine: 5, x0: 150, y0: 300, spacing: 45, slope: Math.tan(Math.PI / 180) }));
  assert.ok(lines.every((l) => l.flat), 'five words span about 8px of drift');
});

test('on a two-column page no line runs across the gutter, and the column-by-column order is kept', () => {
  const left = linesOfWords({ n: 6, perLine: 5, x0: 150, y0: 300, spacing: 45 });
  const right = linesOfWords({ n: 6, perLine: 5, x0: 900, y0: 300, spacing: 45, start: 30 });
  const page = [...left, ...right];                       // Tesseract: all of column 1, then column 2
  const lines = groupIntoLines(page);
  assert.equal(lines.length, 12, 'six lines per column, never one line across both');
  for (const line of lines) {
    const xs = line.words.map((w) => w.word.x0);
    assert.ok(Math.max(...xs) < 800 || Math.min(...xs) > 800, 'a line stays in one column');
  }
  assert.deepEqual(lines.flatMap((l) => l.words.map((w) => w.word)), page, 'input order unchanged');
});

test('every word of a line is drawn at the same baseline and size, in the order given', async () => {
  const { page, font } = await pageWithFont();
  embedOcrLayer(page, font, jitteredWords(4, 7919), OCR_RASTER_DPI);
  const ops = contentOps(page);
  const placed = [...ops.matchAll(/\/[\w-]+\s+([\d.]+)\s+Tf[\s\S]*?1\s+0\s+0\s+1\s+([\d.]+)\s+([\d.]+)\s+Tm\s+<([0-9A-Fa-f]+)>\s*Tj/g)]
    .map((m) => ({ y: parseFloat(m[3]), size: parseFloat(m[1]), text: hexToText(m[4]) }));
  assert.deepEqual(placed.map((p) => p.text.trim()), SENTENCE, 'drawn in the order given');
  for (let i = 0; i < SENTENCE.length; i += 4) {
    const line = placed.slice(i, i + 4);
    assert.equal(new Set(line.map((p) => p.y)).size, 1, `line ${i / 4 + 1} shares one baseline: ${line.map((p) => p.y)}`);
    assert.ok(Math.max(...line.map((p) => p.size)) - Math.min(...line.map((p) => p.size)) < 0.01, 'and one size');
  }
});

test('a clearly different size on the same line is kept, not flattened to the line\'s', async () => {
  const { page, font } = await pageWithFont();
  embedOcrLayer(page, font, [
    { text: 'small', x0: 100, y0: 100, x1: 220, y1: 130 },
    { text: 'BIG', x0: 240, y0: 80, x1: 400, y1: 138 },
    { text: 'small', x0: 420, y0: 100, x1: 540, y1: 130 },
  ], OCR_RASTER_DPI);
  const sizes = [...contentOps(page).matchAll(/\/[\w-]+\s+([\d.]+)\s+Tf/g)].map((m) => parseFloat(m[1]));
  assert.equal(sizes.length, 3);
  assert.ok(sizes[1] > sizes[0] * 1.3, `the large word keeps a larger size (${sizes})`);
});

test('read back by poppler, a jittered page comes out mostly in order', async (t) => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  if (spawnSync('pdftotext', ['-v']).error) return t.skip('pdftotext (poppler) is not installed');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-order-'));
  let inPosition = 0, total = 0;
  for (let n = 1; n <= 12; n++) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    embedOcrLayer(page, await doc.embedFont(StandardFonts.Helvetica), jitteredWords(2, n * 7919), OCR_RASTER_DPI);
    const file = path.join(dir, `p${n}.pdf`);
    fs.writeFileSync(file, await doc.save());
    const out = execFileSync('pdftotext', [file, '-']).toString().split(/\s+/).filter(Boolean);
    SENTENCE.forEach((w, i) => { total++; if (out[i] === w) inPosition++; });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // At 2px of jitter about 92% of words come back in position with the line grouping, and about a third
  // without it. 80% leaves room for another poppler version's own heuristics and still fails without it.
  assert.ok(inPosition / total >= 0.8, `only ${(100 * inPosition / total).toFixed(1)}% of words came back in position`);
});

// ── Reading order with real OCR boxes. Tesseract's box height follows the letters in a word, which the jitter-only
// fixtures above (boxes of one height) do not show; drawn from raw boxes, one printed line can look like several.

test('a word\'s size and baseline are recovered from its characters, not from how tall its box happens to be', () => {
  // The same 40px font: a short-letter word, a capital, and a word with an ascender and a descender.
  const over = wordShape('over', 0.52 * 40), the = wordShape('The', 0.72 * 40), quick = wordShape('quick', 0.93 * 40);
  for (const s of [over, the, quick]) assert.ok(Math.abs(s.size - 40) < 0.5, `size ${s.size}`);
  assert.equal(over.descent, 0, 'nothing below the baseline');
  assert.ok(Math.abs(quick.descent - 0.21 * 40) < 0.5, 'a descender reaches below it');
  // A trailing comma dips below the baseline and is allowed for, not read as a larger font.
  const smith = wordShape('Smith,', (0.72 + 0.12) * 40);
  assert.ok(Math.abs(smith.size - 40) < 0.5 && Math.abs(smith.descent - 0.12 * 40) < 0.5);
});

test('punctuation on its own and other scripts have no shape to go by', () => {
  for (const t of ['.', '---', '(', '£', '中文', 'Ж']) assert.equal(wordShape(t, 20), null, t);
});

test('words of every letter shape on a line share one size and one baseline, and so do lines of one printed size', () => {
  const rnd = (() => { let seed = 5; return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; })();
  const lines = [];
  for (let l = 0; l < 6; l++) {
    let x = 150;
    lines.push(...SENTENCE.slice(l * 4, l * 4 + 6).map((text) => {
      const w = inkBox(text, 300 + l * 90, x, { jitter: 2, rnd });
      x += text.length * 20 + 14;
      return w;
    }));
  }
  const grouped = groupIntoLines(lines);
  assert.equal(grouped.length, 6);
  assert.ok(grouped.every((l) => l.flat));
  const sizes = new Set(grouped.flatMap((l) => l.words.map((w) => Math.round(l.fontSize * 100))));
  assert.equal(sizes.size, 1, `every flat line takes one common size: ${[...sizes]}`);
  for (const line of grouped) {
    assert.ok(Math.max(...line.words.map((w) => w.baseline)) - Math.min(...line.words.map((w) => w.baseline)) < 1e-9, 'one baseline');
  }
});

test('a heading much larger than the body text keeps its own size', () => {
  const body = [];
  let x = 150;
  for (const t of SENTENCE.slice(0, 5)) { body.push(inkBox(t, 600, x, { fontPx: 40 })); x += t.length * 20 + 14; }
  x = 150;
  const heading = [];
  for (const t of ['Witness', 'Statement']) { heading.push(inkBox(t, 300, x, { fontPx: 90 })); x += t.length * 45 + 30; }
  const [h, b] = groupIntoLines([...heading, ...body]);
  assert.ok(h.fontSize > b.fontSize * 2, `heading ${h.fontSize} against body ${b.fontSize}`);
});

test('a word followed by another on its line is drawn with a space after it; the last is not, nor is one before a wide gap', async () => {
  const { page, font } = await pageWithFont();
  embedOcrLayer(page, font, [
    inkBox('one', 300, 200), inkBox('two', 300, 300), inkBox('three', 300, 400),
    inkBox('far', 300, 1400),
  ], OCR_RASTER_DPI);
  assert.deepEqual(drawnWords(page).map((w) => w.text), ['one ', 'two ', 'three', 'far']);
});

test('each word is drawn inside its own graphics state, so one word\'s squeeze never reaches the next', async () => {
  const { page, font } = await pageWithFont();
  embedOcrLayer(page, font, jitteredWords(2, 7919), OCR_RASTER_DPI);
  const ops = contentOps(page);
  const count = (re) => (ops.match(re) || []).length;
  // drawText() wraps each word in a q ... Q of its own as well, so there are two pairs a word.
  assert.equal(count(/^q$/gm), count(/^Q$/gm), 'every q is closed');
  assert.equal(count(/^q$/gm), 2 * SENTENCE.length);
  assert.equal(count(/\bTz\b/g), SENTENCE.length, 'every word has its own squeeze');
});

test('a word the font cannot draw still closes its graphics state', async () => {
  const { page, font } = await pageWithFont();
  embedOcrLayer(page, font, [
    { text: '中文', x0: 0, y0: 0, x1: 50, y1: 20 },
    { text: 'REAL', x0: 60, y0: 0, x1: 150, y1: 20 },
  ], OCR_RASTER_DPI);
  const ops = contentOps(page);
  assert.equal((ops.match(/^q$/gm) || []).length, (ops.match(/^Q$/gm) || []).length);
});

test('read back by poppler, boxes shaped like real OCR output come out in order', async (t) => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  if (spawnSync('pdftotext', ['-v']).error) return t.skip('pdftotext (poppler) is not installed');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-shape-'));
  let inPosition = 0, total = 0;
  for (let n = 1; n <= 8; n++) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    embedOcrLayer(page, await doc.embedFont(StandardFonts.Helvetica), jitteredWords(3, n * 104729), OCR_RASTER_DPI);
    const file = path.join(dir, `p${n}.pdf`);
    fs.writeFileSync(file, await doc.save());
    const out = execFileSync('pdftotext', [file, '-']).toString().split(/\s+/).filter(Boolean);
    SENTENCE.forEach((w, i) => { total++; if (out[i] === w) inPosition++; });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(inPosition / total >= 0.95, `only ${(100 * inPosition / total).toFixed(1)}% of words came back in position`);
});

// ── Dense text read back by poppler. A real printed page has many words to a line, boxes a little
// narrower than the stand-in font's natural width, and a scan that is never quite level. Drawn at its
// natural width, each word would leave a gap to the next that poppler reads as a column gap, taking each
// word for its own column: only about a quarter of a dense page would come back in order (on a 12-page
// scan, against 95% for Tesseract's own PDF output of the same pages).
//
// The fixture is the geometry of two real OCR'd pages (word length and box), one slightly and one more off
// level, with placeholder words of the same length: it keeps the shape of the page and none of its text.
import { readFileSync } from 'node:fs';

const PLACEHOLDERS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');

/** A placeholder word of exactly `length` letters, so the box and the stand-in font's width keep their real relation. */
function placeholder(length, index) {
  const base = PLACEHOLDERS[index % PLACEHOLDERS.length];
  return (base.repeat(Math.ceil(length / base.length)).slice(0, length) || 'x') + '';
}

/** Length of the longest common subsequence of two word lists, as a share of the first. */
function lcsShare(truth, got) {
  let prev = new Array(got.length + 1).fill(0);
  for (let i = 1; i <= truth.length; i++) {
    const cur = new Array(got.length + 1).fill(0);
    for (let j = 1; j <= got.length; j++) cur[j] = truth[i - 1] === got[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[got.length] / truth.length;
}

test('read back by poppler, a dense scanned page comes out in order, whether level or a little off', async (t) => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  if (spawnSync('pdftotext', ['-v']).error) return t.skip('pdftotext (poppler) is not installed');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/ocr-dense-geometry.json', import.meta.url), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-dense-'));
  const shares = [];
  for (const [n, entries] of fixture.pages.entries()) {
    const words = entries.map(([length, x0, y0, x1, y1], i) => ({ text: placeholder(length, i), x0, y0, x1, y1 }));
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    embedOcrLayer(page, await doc.embedFont(StandardFonts.Helvetica), words, fixture.dpi);
    const file = path.join(dir, `dense-${n}.pdf`);
    fs.writeFileSync(file, await doc.save());
    const got = execFileSync('pdftotext', [file, '-']).toString().split(/\s+/).filter(Boolean);
    shares.push(lcsShare(words.map((w) => w.text), got));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // On these two pages: 0.99 and 0.98 with each word stretched to its box and each line flattened, and about
  // 0.3 without. 0.9 leaves room for another poppler version and still fails without them.
  shares.forEach((share, i) => assert.ok(share >= 0.9, `page ${i + 1}: only ${(100 * share).toFixed(1)}% of words came back in order`));
});

// ── Words found on a page turned upright first (bundletoolDeskew.js) go back through its map ──

/** Where pdf.js finds each drawn word on the page: its text, its origin in points and the direction it runs. */
async function placedWords(doc) {
  const pdfjs = await import('/vendor/pdfjs.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  const pdf = await pdfjs.getDocument({ data: await doc.save(), isEvalSupported: false }).promise;
  const content = await (await pdf.getPage(1)).getTextContent();
  return content.items.filter((it) => it.str.trim()).map((it) => {
    const [a, b, , , e, f] = it.transform;
    return { text: it.str.trim(), x: e, y: f, angle: Math.round((Math.atan2(b, a) * 180) / Math.PI) };
  });
}

test('the map that changes nothing writes exactly the same text layer as no map', async () => {
  const plain = await pageWithFont();
  embedOcrLayer(plain.page, plain.font, jitteredWords(2, 7919), OCR_RASTER_DPI);
  const mapped = await pageWithFont();
  embedOcrLayer(mapped.page, mapped.font, jitteredWords(2, 7919), OCR_RASTER_DPI, { toRaw: uprightGeometry(1654, 2339).toRaw });
  const strip = (ops) => ops.replace(/\/Helvetica-\d+/g, '/F');   // pdf-lib names each font use afresh
  assert.equal(strip(contentOps(mapped.page)), strip(contentOps(plain.page)));
  assert.doesNotMatch(contentOps(mapped.page), /\bcm\b/);
});

test('a page read on its side or upside down gets text turned with it, each word starting where it is printed', async () => {
  // A4 at 200 dpi. Each word of a line found on the upright image is drawn at the point the map gives for its start
  // on the line's baseline, running the way the printed line runs on the page as scanned.
  const W = 1654, H = 2339;
  for (const [turn, angle] of [[90, -90], [180, 180], [270, 90]]) {
    const g = uprightGeometry(W, H, 0, turn);
    const words = [inkBox('alpha', 400, 300), inkBox('beta', 400, 420), inkBox('gamma', 400, 520)];
    const { doc, page, font } = await pageWithFont();
    page.setSize(W * 72 / OCR_RASTER_DPI, H * 72 / OCR_RASTER_DPI);
    embedOcrLayer(page, font, words, OCR_RASTER_DPI, { toRaw: g.toRaw });
    assert.match(contentOps(page), new RegExp(`\\s${{ 90: '0 -1 1 0', 180: '-1 0 0 -1', 270: '0 1 -1 0' }[turn]}\\s[\\d.]+\\s[\\d.]+\\scm`), `turn ${turn}: whole numbers`);
    const placed = await placedWords(doc);
    assert.deepEqual(placed.map((p) => p.text), ['alpha', 'beta', 'gamma'], `turn ${turn}`);
    for (const p of placed) assert.ok(Math.abs(((p.angle - angle + 540) % 360) - 180) < 1, `turn ${turn}: ${p.text} runs at ${p.angle}`);
    // The baseline point of each word's start, carried to the raster and on to points, is where pdf.js finds it.
    const lines = groupIntoLines(words);
    for (const [i, { word, baseline }] of lines[0].words.entries()) {
      const raw = applyAffine(g.toRaw, word.x0, baseline);
      const expected = { x: raw.x * 72 / OCR_RASTER_DPI, y: page.getHeight() - raw.y * 72 / OCR_RASTER_DPI };
      assert.ok(Math.abs(placed[i].x - expected.x) < 0.05 && Math.abs(placed[i].y - expected.y) < 0.05,
        `turn ${turn}: ${word.text} at (${placed[i].x.toFixed(2)}, ${placed[i].y.toFixed(2)}), expected (${expected.x.toFixed(2)}, ${expected.y.toFixed(2)})`);
    }
  }
});

test('a line of a page straightened a little is drawn level on one baseline; on a page tilted a long way it follows the print', async () => {
  const W = 1654, H = 2339;
  for (const [tilt, level] of [[1.2, true], [-1.2, true], [30, false], [-25, false]]) {
    const g = uprightGeometry(W, H, tilt);
    // One line of eight words across the middle of the upright image, so it lies on the printed page.
    const words = [];
    for (let k = 0; k < 8; k++) words.push(inkBox(SENTENCE[k], g.height / 2, g.width / 2 - 600 + k * 150));
    const { doc, page, font } = await pageWithFont();
    page.setSize(W * 72 / OCR_RASTER_DPI, H * 72 / OCR_RASTER_DPI);
    embedOcrLayer(page, font, words, OCR_RASTER_DPI, { toRaw: g.toRaw });
    const placed = await placedWords(doc);
    assert.equal(placed.length, 8, JSON.stringify(placed));
    if (level) {
      assert.ok(placed.every((p) => p.angle === 0), `tilt ${tilt}: level`);
      assert.equal(new Set(placed.map((p) => p.y.toFixed(3))).size, 1, `tilt ${tilt}: one baseline`);
    } else {
      // The printed line runs at -tilt degrees on the page (the tilt is the turn that levels it).
      assert.ok(placed.every((p) => Math.abs(p.angle + tilt) <= 1), `tilt ${tilt}: ${placed.map((p) => p.angle)}`);
    }
    // Either way each word starts within a point or two of where it is printed (the level line moves no word off
    // the printed line by more than the flattening allows).
    const lines = groupIntoLines(words);
    for (const [i, { word, baseline }] of lines[0].words.entries()) {
      const raw = applyAffine(g.toRaw, word.x0, baseline);
      const dx = placed[i].x - raw.x * 72 / OCR_RASTER_DPI;
      const dy = placed[i].y - (page.getHeight() - raw.y * 72 / OCR_RASTER_DPI);
      assert.ok(Math.hypot(dx, dy) < (level ? 12 : 0.05), `tilt ${tilt}: ${word.text} is ${Math.hypot(dx, dy).toFixed(2)}pt off`);
    }
  }
});
