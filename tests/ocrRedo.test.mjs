/**
 * Reading a page again replaces its invisible text instead of adding a second copy (bundletoolOcrRedo.js,
 * bundletoolOcr.js's replaceOcrLayer). Counts are taken as pdf.js reports text items and as a viewer's find bar counts
 * a word in the page's text, because poppler's pdftotext drops text drawn twice in one place and would hide the
 * duplicates. Visible text must come through untouched: checked on the content and, where pdftoppm is installed, on
 * the rendered page, pixel for pixel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, StandardFonts, getFontkit } from '../public/js/bundletoolPdfLib.js';
import { parseContent, stripInvisibleText, removeInvisibleText } from '../public/js/bundletoolOcrRedo.js';
import { embedOcrLayer, replaceOcrLayer, OCR_RASTER_DPI } from '../public/js/bundletoolOcr.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder('latin1').decode(b);
const strip = (s, opts) => { const r = stripInvisibleText(enc(s), opts); return { text: dec(r.bytes), removed: r.removed }; };

// ── one content stream ──────────────────────────────────────────────────────────────────────────────────────────────

test('the showing operators of an invisible text object go; its state and everything else stay', () => {
  const { text, removed } = strip('q 1 0 0 1 0 0 cm BT /F1 9 Tf 3 Tr 10 20 Td (alpha) Tj [(be) -20 (ta)] TJ ET Q');
  assert.equal(removed, 2);
  assert.doesNotMatch(text, /alpha|be|Tj|TJ/);
  for (const kept of ['q', '1 0 0 1 0 0 cm', 'BT', '/F1 9 Tf', '3 Tr', '10 20 Td', 'ET', 'Q']) assert.ok(text.includes(kept), kept);
});

test('visible, stroked and clipping text is never touched', () => {
  for (const mode of [0, 1, 2, 4, 5, 6, 7]) {
    const s = `BT /F1 9 Tf ${mode} Tr (shown) Tj ET`;
    assert.deepEqual(strip(s), { text: s, removed: 0 }, `mode ${mode}`);
  }
  // No render mode set at all: a page starts filling text.
  assert.equal(strip('BT /F1 9 Tf (shown) Tj ET').removed, 0);
});

test('a text object that mixes invisible and visible text is left exactly as it is', () => {
  const s = 'BT /F1 9 Tf 3 Tr (hidden) Tj 0 Tr (shown) Tj ET';
  assert.deepEqual(strip(s), { text: s, removed: 0 });
});

test('the render mode follows the graphics state: restored by Q, carried on past ET', () => {
  // Set inside q ... Q: the text after Q is drawn in the mode from before, and stays.
  assert.equal(strip('q 3 Tr Q BT (shown) Tj ET').removed, 0);
  // Set in one text object and never reset: the next text object is invisible too, and goes.
  const { text, removed } = strip('BT 3 Tr (a) Tj ET BT (b) Tj ET BT 0 Tr (c) Tj ET');
  assert.equal(removed, 2);
  assert.match(text, /\(c\) Tj/);
});

test("' and \" keep the line move and the spacing they set; only the text goes", () => {
  const { text, removed } = strip('BT 3 Tr 14 TL (one) \' 2 1 (two) " ET BT 0 Tr (three) Tj ET');
  assert.equal(removed, 2);
  assert.match(text, /T\*\s+2 Tw 1 Tc T\*/);
  assert.match(text, /\(three\) Tj/);
});

test('strings with escaped and nested brackets, hex strings, dictionaries and comments are read, not misread', () => {
  const s = 'BT 3 Tr (a \\( b ( c ) \\) Tj) Tj <48 49> Tj [(x) 10 <4A>] TJ ET % (not) Tj\n'
    + '/P <</MCID 0 /Alt (ET) >> BDC BT 0 Tr (shown) Tj ET EMC';
  const { text, removed } = strip(s);
  assert.equal(removed, 3);
  assert.match(text, /\(shown\) Tj/);
  assert.match(text, /\/Alt \(ET\)/);
});

test('an inline image\'s data is skipped whole, even when it holds bytes that look like operators', () => {
  const s = 'BI /W 4 /H 1 /BPC 8 /CS /G ID TjET EI BT 3 Tr (gone) Tj ET BT 0 Tr (kept) Tj ET';
  const ops = parseContent(enc(s)).map((o) => o.op);
  assert.deepEqual(ops, ['BI', 'ID', 'BT', 'Tr', 'Tj', 'ET', 'BT', 'Tr', 'Tj', 'ET']);
  const { text, removed } = strip(s);
  assert.equal(removed, 1);
  assert.ok(text.startsWith('BI /W 4 /H 1 /BPC 8 /CS /G ID TjET EI'));
});

test('in a form, text before the form sets its own mode inherits an unknown one and is kept', () => {
  assert.equal(strip('BT (inherits) Tj ET', { mode: null }).removed, 0);
  assert.equal(strip('BT 3 Tr (own) Tj ET', { mode: null }).removed, 1);
});

test('a stream that cannot be read with certainty is left exactly as it is', () => {
  for (const s of ['BT 3 Tr (unterminated Tj ET', 'BT 3 Tr <414 Tj ET', 'BI /W 1 ID xx', 'BT 3 Tr ) Tj ET']) {
    assert.deepEqual(strip(s), { text: s, removed: 0 }, s);
  }
});

// ── a page ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const WORDS = 'the court made the following order on the first day of the hearing'.split(' ').map((text, i) => ({
  text, x0: 200 + i * 110, y0: 400, x1: 290 + i * 110, y1: 440,
}));

/** Every text item pdf.js finds, and how often a whole word occurs in the page's text, as a viewer's find bar counts it. */
async function textOf(bytes, word = 'the') {
  const pdfjs = await import('/vendor/pdfjs.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  // A copy: pdf.js takes the buffer it is given over to its worker.
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const items = (await (await doc.getPage(1)).getTextContent()).items.filter((i) => i.str.trim());
  const text = items.map((i) => i.str).join(' ');
  return { items: items.length, hits: (text.match(new RegExp(`\\b${word}\\b`, 'gi')) ?? []).length, text };
}

test('drawing a new layer over an old one replaces it: as many items and finds as one layer, not twice as many', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([1240, 1754]);
  embedOcrLayer(page, font, WORDS, OCR_RASTER_DPI);
  const once = await textOf(await doc.save());
  assert.equal(once.hits, 4);

  const again = await PDFDocument.load(await doc.save());
  const removed = replaceOcrLayer(again.getPage(0), await again.embedFont(StandardFonts.Helvetica), WORDS, OCR_RASTER_DPI);
  assert.ok(removed > 0);
  const twice = await textOf(await again.save());
  assert.deepEqual([twice.items, twice.hits], [once.items, once.hits]);
});

test('a layer held in a Form XObject, as OCRmyPDF draws it, is taken off too; forms are rewritten once', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('x', { x: 0, y: 0, size: 1, font, opacity: 0 });
  const fontKey = page.node.Resources().lookup(PDFName.of('Font')).keys()[0].toString();
  const form = doc.context.flateStream(`BT 3 Tr ${fontKey} 12 Tf 50 700 Td (the hidden form text) Tj ET`, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800], Resources: { Font: page.node.Resources().lookup(PDFName.of('Font')) },
  });
  const formRef = doc.context.register(form);
  page.node.Resources().lookup(PDFName.of('XObject')).set(PDFName.of('OCR1'), formRef);
  page.node.addContentStream(doc.context.register(doc.context.flateStream('q /OCR1 Do Q q /OCR1 Do Q')));
  const before = await textOf(await doc.save(), 'hidden');
  assert.equal(before.hits, 2, 'drawn twice from one form');

  const loaded = await PDFDocument.load(await doc.save());
  assert.equal(removeInvisibleText(loaded.getPage(0)), 1, 'the shared form is rewritten once');
  assert.equal((await textOf(await loaded.save(), 'hidden')).hits, 0);
});

/** A page with visible text in an embedded font, a mixed text object, clipping text, an inline image and an old layer. */
async function mixedPage() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(await getFontkit());
  const font = await doc.embedFont(fs.readFileSync(path.join(root, 'public/fonts/serif/NotoSerif-Regular.ttf')), { subset: false });
  const page = doc.addPage([600, 800]);
  page.drawText('A visible heading over the page', { x: 50, y: 750, size: 18, font });
  const key = page.node.Resources().lookup(PDFName.of('Font')).keys()[0].toString();
  const e = (t) => font.encodeText(t).toString();
  page.node.addContentStream(doc.context.register(doc.context.flateStream([
    `BT ${key} 14 Tf 50 700 Td 3 Tr ${e('hidden mixed words')} Tj 0 Tr ${e(' visible after hidden')} Tj ET`,
    `q BT ${key} 30 Tf 7 Tr 50 600 Td ${e('CLIPPED')} Tj ET 0 0 1 rg 40 590 300 40 re f Q`,
    `BT ${key} 14 Tf 3 Tr 50 500 Td ${e('the old hidden layer')} Tj ET`,
    `BT ${key} 12 Tf 3 Tr 50 400 Td 14 TL ${e('quote hidden')} ' 2 1 ${e('dquote hidden')} " ET`,
    `BT ${key} 12 Tf 0 Tr 50 350 Td ${e('spaced visible line after the quotes')} Tj ET`,
    'q 100 0 0 25 50 250 cm BI /W 4 /H 1 /BPC 8 /CS /G ID TjET EI Q',
    `BT ${key} 12 Tf 50 200 Td ${e('visible after an inline image')} Tj ET`,
  ].join('\n'))));
  return doc.save();
}

function render(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-redo-'));
  try {
    fs.writeFileSync(path.join(dir, 'p.pdf'), bytes);
    const r = spawnSync('pdftoppm', ['-r', '72', '-gray', '-singlefile', path.join(dir, 'p.pdf'), path.join(dir, 'out')]);
    assert.equal(r.status, 0, String(r.stderr));
    return fs.readFileSync(path.join(dir, 'out.pgm'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('visible text is never removed: every visible string is still there, and only invisible ones went', async () => {
  const bytes = await mixedPage();
  const before = await textOf(bytes, 'visible');
  const doc = await PDFDocument.load(bytes);
  removeInvisibleText(doc.getPage(0));
  const after = await textOf(await doc.save(), 'visible');
  for (const shown of ['A visible heading over the page', 'visible after hidden', 'CLIPPED', 'spaced visible line after the quotes', 'visible after an inline image']) {
    assert.ok(after.text.includes(shown), `"${shown}" is still there`);
  }
  // The mixed text object keeps its invisible part too; the invisible-only ones are gone.
  assert.ok(after.text.includes('hidden mixed words'));
  for (const gone of ['the old hidden layer', 'quote hidden', 'dquote hidden']) assert.ok(!after.text.includes(gone), `"${gone}" was taken off`);
  assert.equal(after.hits, before.hits);
});

test('the page looks exactly the same afterwards, pixel for pixel', async (t) => {
  if (spawnSync('pdftoppm', ['-v']).error) return t.skip('pdftoppm (poppler) is not installed');
  const bytes = await mixedPage();
  const doc = await PDFDocument.load(bytes);
  assert.ok(removeInvisibleText(doc.getPage(0)) > 0);
  const after = await doc.save();
  assert.ok(render(after).equals(render(bytes)), 'the rendering changed');
});

test('both the browser and the command line draw a page\'s layer through replaceOcrLayer, never straight on top', () => {
  // The browser's Force OCR (ocrForce.js) and automatic OCR both run bundletoolOcrDocument.js; the command line's
  // forceOcr and ocr.mode run cliOcrDocument.mjs. Neither may draw a layer without first taking the old one off.
  for (const file of ['public/js/frontend/bundletoolOcrDocument.js', 'scripts/cliOcrDocument.mjs']) {
    const code = fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.match(code, /replaceOcrLayer\(/, file);
    assert.doesNotMatch(code, /embedOcrLayer\(/, file);
  }
});
