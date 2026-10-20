/**
 * Reading only what is not already text (bundletoolOcrPrinted.js): which of a page's text items are visible, where
 * they are, and which recognised words they cover. Counts are taken from pdf.js, never poppler alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, getFontkit } from '../public/js/bundletoolPdfLib.js';
import { drawnGlyphs, visibleItems, visibleTextBoxes, withoutPrintedText } from '../public/js/bundletoolOcrPrinted.js';
import { uprightGeometry } from '../public/js/bundletoolDeskew.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPS = { save: 1, restore: 2, setTextRenderingMode: 3, showText: 4, showSpacedText: 5, paintFormXObjectBegin: 6, paintFormXObjectEnd: 7, beginAnnotation: 8, endAnnotation: 9 };
const glyphs = (s) => [...s].map((unicode) => ({ unicode }));
const list = (...ops) => ({ fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1] ?? []) });

// ── which text is visible ───────────────────────────────────────────────────────────────────────────────────────────

test('glyphs carry the render mode they were drawn in, through q/Q, forms and annotations', () => {
  const g = drawnGlyphs(list(
    [OPS.showText, [glyphs('ab')]],
    [OPS.save], [OPS.setTextRenderingMode, [3]], [OPS.showText, [glyphs('cd')]], [OPS.restore],
    [OPS.showSpacedText, [[...glyphs('e'), -120, ...glyphs('f')]]],
    [OPS.paintFormXObjectBegin], [OPS.setTextRenderingMode, [7]], [OPS.showText, [glyphs('g')]], [OPS.paintFormXObjectEnd],
    [OPS.showText, [glyphs('h i')]],
    [OPS.beginAnnotation], [OPS.showText, [glyphs('zz')]], [OPS.endAnnotation],
  ), OPS);
  assert.deepEqual(g.map((x) => x.ch).join(''), 'abcdefghi');
  assert.deepEqual(g.map((x) => (x.visible ? 'v' : '-')).join(''), 'vv--vv-vv');
});

test('an item is visible when its characters match visibly drawn glyphs, in order; unmatched counts as not visible', () => {
  const g = drawnGlyphs(list(
    [OPS.setTextRenderingMode, [3]], [OPS.showText, [glyphs('old layer')]],
    [OPS.setTextRenderingMode, [0]], [OPS.showText, [glyphs('Stamp')]], [OPS.showText, [glyphs('text')]],
  ), OPS);
  const items = [{ str: 'old' }, { str: 'layer' }, { str: 'Stamp text' }, { str: 'nowhere' }, { str: ' ' }];
  assert.deepEqual(visibleItems(items, g), [false, false, true, false, false]);
});

// ── which words it covers ───────────────────────────────────────────────────────────────────────────────────────────

const box = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

test('a word mostly under visible text is left out; one beside it, or only touching it, is kept', () => {
  const words = [
    { text: 'under', x0: 100, y0: 100, x1: 200, y1: 130 },
    { text: 'beside', x0: 260, y0: 100, x1: 360, y1: 130 },
    { text: 'touching', x0: 190, y0: 125, x1: 290, y1: 160 },
  ];
  const kept = withoutPrintedText(words, [box(90, 95, 220, 135)]);
  assert.deepEqual(kept.map((w) => w.text), ['beside', 'touching']);
  assert.deepEqual(withoutPrintedText(words, []), words, 'nothing printed: nothing left out');
});

test('words read on a page turned upright are compared with the printed text where it is on that page', () => {
  // A page read after a quarter turn: a word at the upright image's top left is, on the raster, at its bottom left.
  const W = 1000, H = 1400;
  const g = uprightGeometry(W, H, 0, 90);
  const word = { text: 'turned', x0: 50, y0: 60, x1: 250, y1: 100 };
  const corners = [[word.x0, word.y0], [word.x1, word.y0], [word.x1, word.y1], [word.x0, word.y1]]
    .map(([x, y]) => ({ x: g.toRaw[0] * x + g.toRaw[2] * y + g.toRaw[4], y: g.toRaw[1] * x + g.toRaw[3] * y + g.toRaw[5] }));
  assert.deepEqual(withoutPrintedText([word], [corners], g.toRaw), []);
  assert.deepEqual(withoutPrintedText([word], [box(50, 60, 250, 100)], g.toRaw), [word], 'the same box unturned is elsewhere');
});

// ── on a real page ──────────────────────────────────────────────────────────────────────────────────────────────────

test('on a page with visible, invisible and clipping text, only the visible items have boxes, where pdf.js draws them', async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(await getFontkit());
  const font = await doc.embedFont(fs.readFileSync(path.join(root, 'public/fonts/serif/NotoSerif-Regular.ttf')), { subset: false });
  const page = doc.addPage([600, 800]);
  page.drawText('A visible heading', { x: 50, y: 700, size: 20, font });
  const key = page.node.Resources().lookup(PDFName.of('Font')).keys()[0].toString();
  const e = (t) => font.encodeText(t).toString();
  page.node.addContentStream(doc.context.register(doc.context.flateStream([
    `BT ${key} 14 Tf 3 Tr 50 500 Td ${e('an old invisible layer')} Tj ET`,
    `BT ${key} 30 Tf 7 Tr 50 400 Td ${e('CLIPPED')} Tj ET`,
    `BT ${key} 12 Tf 0 Tr 300 300 Td ${e('visible again')} Tj ET`,
  ].join('\n'))));
  const pdfjs = await import('/vendor/pdfjs.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  const pdf = await pdfjs.getDocument({ data: await doc.save(), isEvalSupported: false, verbosity: 0 }).promise;
  const pdfPage = await pdf.getPage(1);
  const viewport = pdfPage.getViewport({ scale: 200 / 72, rotation: 0 });
  const boxes = await visibleTextBoxes(pdfPage, viewport, pdfjs.OPS);
  assert.equal(boxes.length, 2, JSON.stringify(boxes));
  // The heading starts at (50, 700) points: on the 200 dpi raster that is x 139, y (800 - 700) * 200 / 72 = 278.
  const [heading] = boxes;
  const xs = heading.map((p) => p.x), ys = heading.map((p) => p.y);
  assert.ok(Math.abs(Math.min(...xs) - 50 * 200 / 72) < 1, `left ${Math.min(...xs)}`);
  assert.ok(Math.min(...ys) < 278 && Math.max(...ys) > 278, `the baseline at y 278 is inside ${Math.min(...ys)}..${Math.max(...ys)}`);
});

test('both the browser and the command line leave out words over visible text before the layer is drawn', () => {
  for (const file of ['public/js/frontend/bundletoolOcrDocument.js', 'scripts/cliOcrDocument.mjs']) {
    const code = fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.match(code, /visibleText(Boxes)?\(/, file);
    assert.match(code, /withoutPrintedText\(/, file);
  }
});
