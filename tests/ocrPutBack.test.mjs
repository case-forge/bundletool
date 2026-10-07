/**
 * "Put back as scanned": undoing Straighten tilted scanned pages for one page (putBackAsScanned in
 * bundletoolOcrReorient.js, the document window's button in frontend/rotate.js, the record in frontend/ocrReorient.js).
 * An undone page draws as the original scan did, pixel for pixel; its text layer lies along the tilted print again;
 * the other pages are not touched; and later readings leave it as scanned. The engine runs through the command line's
 * ocrDocument, and the tests skip without it; the poppler checks skip without pdftoppm and pdftotext.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeElement } from './fakeDom.mjs';
import { doc, state, $, until, openDocumentWindow } from './documentWindowHarness.mjs';
import { scanCanvas, scanPdfPages, LINES } from './ocrScans.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { loadOcrRuntime } from '../scripts/cliOcrEngine.mjs';
import { ocrDocument } from '../scripts/cliOcrDocument.mjs';
import { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } from '../public/js/bundletoolPdfLib.js';
import { putBackAsScanned, straightenContent } from '../public/js/bundletoolOcrReorient.js';
import { displayRules, shownInTemplate } from './cssDisplay.mjs';

const { noteReoriented, recordPutBack, reorientChoice, straightenedPageNote, ocrBadgeTitle } = await import('../public/js/frontend/ocrReorient.js');

let RUNTIME = null;
const haveRuntime = async () => (RUNTIME ??= (await loadOcrRuntime()).available);
const havePoppler = () => !spawnSync('pdftotext', ['-v']).error && !spawnSync('pdftoppm', ['-v']).error;
const STRAIGHTEN = { straighten: true };

/** Page `n` (1-based) drawn by pdf.js at `dpi`, as RGBA, onto @napi-rs/canvas (also for pdf.js's own scratch canvases). */
async function render(bytes, n, dpi = 60) {
  const pdfjsLib = await import('/vendor/pdfjs.mjs');
  const canvasFactory = {
    create(w, h) { const canvas = createCanvas(w, h); return { canvas, context: canvas.getContext('2d') }; },
    reset(cc, w, h) { cc.canvas.width = w; cc.canvas.height = h; },
    destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; },
  };
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice(), isEvalSupported: false, enableXfa: false, canvasFactory, verbosity: 0 });
  const pdf = await task.promise;
  const page = await pdf.getPage(n);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const cc = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: cc.context, viewport, canvas: cc.canvas, background: 'white' }).promise;
  const image = cc.context.getImageData(0, 0, cc.canvas.width, cc.canvas.height);
  await task.destroy();
  return { data: image.data, width: image.width, height: image.height };
}

/** Page `n` drawn by poppler's pdftoppm at `dpi`, as RGBA. */
async function renderPoppler(bytes, n, dpi = 60) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btputback-'));
  try {
    const file = path.join(dir, 'p.pdf');
    fs.writeFileSync(file, bytes);
    execFileSync('pdftoppm', ['-r', String(dpi), '-f', String(n), '-l', String(n), '-png', '-singlefile', file, path.join(dir, 'r')]);
    const img = await loadImage(fs.readFileSync(path.join(dir, 'r.png')));
    const c = createCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
    const image = c.getContext('2d').getImageData(0, 0, img.width, img.height);
    return { data: image.data, width: image.width, height: image.height };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** How two renders differ: the share of pixels whose largest channel difference is over `tolerance`, and the largest. */
function difference(a, b, tolerance = 8) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let over = 0;
  let largest = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > tolerance) over++;
    largest = Math.max(largest, d);
  }
  return { share: over / (a.width * a.height), largest };
}

/** pdftotext -bbox's words on page `n`, in points from the top left. */
function bboxWords(bytes, n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btputback-'));
  try {
    const file = path.join(dir, 'p.pdf');
    fs.writeFileSync(file, bytes);
    const html = execFileSync('pdftotext', ['-f', String(n), '-l', String(n), '-bbox', file, '-']).toString();
    return [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ x: (+m[1] + +m[3]) / 2, y: (+m[2] + +m[4]) / 2, text: m[5].toLowerCase() }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** pdf.js's text items on page `n`, with the direction each runs (degrees, counter-clockwise). */
async function items(bytes, n) {
  const pdfjsLib = await import('/vendor/pdfjs.mjs');
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice(), isEvalSupported: false, enableXfa: false, verbosity: 0 });
  const content = await (await (await task.promise).getPage(n)).getTextContent();
  await task.destroy();
  return content.items.filter((it) => it.str.trim()).map((it) => ({ text: it.str.trim(), angle: (Math.atan2(it.transform[1], it.transform[0]) * 180) / Math.PI }));
}

/** The decoded content streams of every page, for telling whether a page changed. */
async function contentsOf(bytes) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((page) => {
    const c = page.node.Contents();
    const refs = c instanceof PDFArray ? c.asArray() : [page.node.get(PDFName.of('Contents'))];
    return { rotate: page.getRotation().angle, streams: refs.map((r) => {
      const st = pdf.context.lookup(r);
      return Buffer.from(st instanceof PDFRawStream ? decodePDFRawStream(st).decode() : st.getUnencodedContents()).toString('latin1');
    }) };
  });
}

/** Reads `bytes`, straightening, and puts page `n` back as scanned the way the window does. */
async function readAndPutBack(bytes, n) {
  const read = await ocrDocument(new Uint8Array(bytes).slice(), { force: true, reorient: STRAIGHTEN });
  assert.equal(read.ok, true, JSON.stringify({ ...read, bytes: undefined }));
  const entries = read.reoriented.straightened.filter(([page]) => page === n);
  assert.ok(entries.length, `page ${n} was straightened`);
  const pdf = await PDFDocument.load(new Uint8Array(read.bytes));
  assert.equal(putBackAsScanned(pdf.getPage(n - 1)), true);
  return { read, undone: await pdf.save() };
}

// ── Without the engine: what putting back does to a page's content ─────────────────────────────────────────────────

/** A one-page PDF of `ops` (content stream text), saved and loaded again as a scan would be. */
async function pageWith(ops) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream(ops)));
  return PDFDocument.load(await pdf.save());
}
const ORIGINAL = '0.5 g 100 100 200 300 re f';

test('putting back takes the straightening out: the original content is drawn with no transform round it, and the layer after it is turned back', async () => {
  for (const tilt of [0.25, -2.6, 5, 10]) {
    const pdf = await pageWith(ORIGINAL);
    const page = pdf.getPage(0);
    assert.equal(straightenContent(page, tilt, { x: 306, y: 396 }), true);
    page.drawRectangle({ x: 1, y: 1, width: 1, height: 1 });   // stands in for the text layer drawn after
    const straightened = await PDFDocument.load(await pdf.save());
    assert.equal(putBackAsScanned(straightened.getPage(0)), true);
    const [{ streams }] = await contentsOf(await straightened.save());
    const at = streams.indexOf(ORIGINAL);
    assert.ok(at >= 0, 'the original stream is there, byte for byte');
    assert.deepEqual(streams.slice(0, at).map((x) => x.trim()), ['q'], `${tilt}: nothing but a q before it, no cm`);
    assert.equal(streams[at + 1].trim(), 'Q');
    const after = streams.slice(at + 2).join('\n');
    assert.match(after, /^q\s+[-\d.e]+ [-\d.e]+ [-\d.e]+ [-\d.e]+ [-\d.e]+ [-\d.e]+ cm/, 'the layer after it is wrapped in the opposite rotation');
    const [c, s] = after.split(/\s+/).slice(1, 3).map(Number);
    assert.ok(Math.abs(Math.atan2(s, c) * 180 / Math.PI + tilt) < 1e-9, `${tilt}: turned back by ${tilt}`);
    assert.equal(putBackAsScanned(straightened.getPage(0)), false, 'nothing left to put back');
  }
  assert.equal(putBackAsScanned((await pageWith(ORIGINAL)).getPage(0)), false, 'a page never straightened is left alone');
});

// ── With the engine ───────────────────────────────────────────────────────────────────────────────────────────────

test('a page put back draws as the original scan did, pixel for pixel, while straightened it did not', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  for (const tilt of [2, 5, 10]) {
    const scan = await scanPdfPages([scanCanvas({ tilt })]);
    const { read, undone } = await readAndPutBack(scan, 1);
    const original = await render(scan, 1);
    const straightened = difference(original, await render(read.bytes, 1));
    assert.ok(straightened.share > 0.01, `${tilt}: straightened, the page looks different (${straightened.share})`);
    const back = difference(original, await render(undone, 1));
    assert.ok(back.share < 0.0005, `${tilt}: ${(100 * back.share).toFixed(3)}% of pixels differ by more than 8 levels (largest ${back.largest})`);
    if (havePoppler()) {
      const p = difference(await renderPoppler(scan, 1), await renderPoppler(undone, 1));
      assert.ok(p.share < 0.0005, `${tilt}, poppler: ${(100 * p.share).toFixed(3)}% of pixels differ (largest ${p.largest})`);
    }
  }
});

test('the text layer of a page put back lies along the tilted print again, where reading it unstraightened puts it', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const tilt = 5;
  const scan = await scanPdfPages([scanCanvas({ tilt })]);
  const { undone } = await readAndPutBack(scan, 1);
  const plain = await ocrDocument(scan.slice(), { force: true });
  // The words run with the tilted print again (drawn level over the level page, then turned back with it).
  const runs = await items(undone, 1);
  assert.ok(runs.length > 10);
  for (const it of runs) assert.ok(Math.abs(it.angle + tilt) < 0.5, `"${it.text}" runs at ${it.angle.toFixed(2)}, the print at ${-tilt}`);
  if (!havePoppler()) return t.skip('pdftotext (poppler) is not installed: the word boxes are not compared');
  const once = (list) => {
    const m = new Map();
    for (const w of list) m.set(w.text, m.has(w.text) ? null : w);
    return m;
  };
  const a = once(bboxWords(undone, 1));
  const b = once(bboxWords(plain.bytes, 1));
  const truth = new Set(LINES.join(' ').toLowerCase().split(/\s+/));
  let compared = 0;
  for (const [word, w] of a) {
    const v = b.get(word);
    if (!w || !v || !truth.has(word)) continue;
    compared++;
    const d = Math.hypot(w.x - v.x, w.y - v.y);
    assert.ok(d < 3, `"${word}" is ${d.toFixed(2)} pt from where reading the page unstraightened puts it`);
  }
  assert.ok(compared >= 20, `${compared} words compared`);
});

test('putting one page back touches no other page, and a later reading leaves it as scanned', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const scan = await scanPdfPages([scanCanvas({ tilt: 5 }), scanCanvas({ tilt: -4 }), scanCanvas({ tilt: 3 })]);
  const { read, undone } = await readAndPutBack(scan, 2);
  assert.deepEqual(read.reoriented.straightened.map(([page]) => page), [1, 2, 3]);
  const before = await contentsOf(read.bytes);
  const after = await contentsOf(undone);
  assert.deepEqual(after[0], before[0], 'page 1 as it was');
  assert.deepEqual(after[2], before[2], 'page 3 as it was');
  assert.notDeepEqual(after[1], before[1], 'page 2 put back');
  assert.equal(after[1].rotate, before[1].rotate);

  // The document's record, as the window keeps it, then Force OCR with the settings still on.
  state.frontendInputData['three.pdf'] = { title: 'Three' };
  noteReoriented('three.pdf', read.reoriented);
  recordPutBack('three.pdf', 2);
  assert.deepEqual(state.frontendInputData['three.pdf'].ocrPages.putBack, [2]);
  assert.deepEqual(state.frontendInputData['three.pdf'].ocrPages.straightened.map(([page]) => page), [1, 3]);
  assert.equal(state.frontendInputData['three.pdf'].pagesChanged, true, 'still a changed document');
  assert.deepEqual(reorientChoice('three.pdf').keepAsScanned, [2]);
  const again = await ocrDocument(new Uint8Array(undone), { force: true, reorient: { ...STRAIGHTEN, keepAsScanned: reorientChoice('three.pdf').keepAsScanned } });
  assert.equal(again.ok, true);
  assert.ok(!again.reoriented.straightened.some(([page]) => page === 2), 'page 2 is not straightened again');
  noteReoriented('three.pdf', again.reoriented);
  const record = state.frontendInputData['three.pdf'].ocrPages;
  assert.deepEqual(record.putBack, [2], 'and stays put back');
  assert.deepEqual([...new Set(record.straightened.map(([page]) => page))], [1, 3], 'pages 1 and 3 can still be put back');
  assert.equal(straightenedPageNote({ filename: 'three.pdf', pageNum: 2 }), 'Put back as scanned.');
  assert.match(straightenedPageNote({ filename: 'three.pdf', pageNum: 1 }), /^Straightened by \d+\.\d degrees\.$/);
  assert.match(ocrBadgeTitle(state.frontendInputData['three.pdf']), /pages 1 and 3 straightened; page 2 put back as scanned\.$/);
  // Without the page put back, the same reading would have straightened it.
  const unkept = await ocrDocument(new Uint8Array(undone), { force: true, reorient: STRAIGHTEN });
  assert.ok(unkept.reoriented.straightened.some(([page]) => page === 2));
  delete state.frontendInputData['three.pdf'];
});

/** The window's template, and whether the put-back button is displayed as the browser would show it: by the
 * stylesheet's own rules, with the row it sits in and the window round it (tests/cssDisplay.mjs). */
const windowHtml = fs.readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
const cssRules = displayRules(fs.readFileSync(new URL('../assets/css/bundletool.css', import.meta.url), 'utf8'));
const putBackShown = () => shownInTemplate(doc, windowHtml, 'rotate-putback', cssRules, (tag) => new FakeElement(doc, tag));

/** Goes to page n through the page box, as a person typing it does. */
function typePage(n) {
  const box = $('rotate-page-input');
  box.value = String(n);
  box.dispatchEvent({ type: 'change', target: box, preventDefault() {}, stopPropagation() {} });
}

/** Asserts the button is shown on every page the record says was straightened, and on no other, walking the pages
 * with the arrows and then with the page box. */
async function walk(name, pageCount, what) {
  const straightened = () => new Set((state.frontendInputData[name].ocrPages?.straightened ?? []).map(([page]) => page));
  for (const go of [(n) => { while (Number($('rotate-page-input').value) < n) $('rotate-next').click(); }, typePage]) {
    typePage(1);
    for (let n = 1; n <= pageCount; n++) {
      go(n);
      await until(() => Number($('rotate-page-input').value) === n, `page ${n}`);
      assert.equal(putBackShown(), straightened().has(n), `${what}, page ${n}: the button ${straightened().has(n) ? 'is missing' : 'shows on a page not straightened'}`);
    }
  }
}

test('the window shows "Put back as scanned" exactly on the pages the record says were straightened, page after page', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  // Four pages: tilted, level, tilted the other way, level.
  const scan = await scanPdfPages([scanCanvas({ tilt: 5 }), scanCanvas(), scanCanvas({ tilt: -4 }), scanCanvas()]);
  const read = await ocrDocument(scan.slice(), { force: true, reorient: STRAIGHTEN });
  assert.deepEqual(read.reoriented.straightened.map(([page]) => page), [1, 3]);
  const name = 'walk.pdf';
  state.filesMap.set(name, new File([read.bytes], name, { type: 'application/pdf' }));
  state.frontendInputData[name] = { title: name, date: '', pageCount: 4, ocrApplied: true };
  noteReoriented(name, read.reoriented);
  const opener = doc.body.appendChild(new FakeElement(doc, 'button'));
  await openDocumentWindow(name, opener);
  await until(() => Number($('rotate-page-input').value) === 1, 'the window open on page 1');
  await walk(name, 4, 'on opening');

  // Put page 1 back: the button goes, and stays gone when paging away and back.
  typePage(1);
  await until(() => putBackShown(), 'the button on page 1');
  $('rotate-putback').click();
  await until(() => $('rotate-message').textContent === 'Page 1 put back as scanned.', 'page 1 put back');
  await until(() => !$('rotate-putback').disabled, 'the window settled');
  assert.equal(putBackShown(), false, 'gone once used');
  $('rotate-next').click();
  $('rotate-prev').click();
  await until(() => Number($('rotate-page-input').value) === 1, 'back on page 1');
  assert.equal(putBackShown(), false, 'still gone after paging away and back');
  await walk(name, 4, 'after putting page 1 back');

  // A turn waiting to be confirmed changes nothing about which pages were straightened.
  typePage(3);
  $('rotate-right').click();
  await until(() => Number($('rotate-page-input').value) === 3, 'page 3');
  assert.equal(putBackShown(), true, 'page 3 is still straightened while turned in the preview');
  $('rotate-left').click();

  // While "Remove this page" asks, the row is one of the controls the question stands in for; answered "Keep it",
  // it is back.
  $('rotate-remove').click();
  assert.equal(putBackShown(), false, 'hidden while the question is up');
  $('rotate-remove-keep').click();
  assert.equal(putBackShown(), true, 'back once the question is answered');

  // Removing page 2 moves page 3, and its button, to page 2.
  typePage(2);
  $('rotate-remove').click();
  $('rotate-remove-yes').click();
  await until(() => $('rotate-message').textContent === 'Page 2 removed.', 'page 2 removed');
  await until(() => !$('rotate-remove').disabled, 'the window settled');
  assert.deepEqual([...new Set(state.frontendInputData[name].ocrPages.straightened.map(([page]) => page))], [2]);
  await walk(name, 3, 'after removing page 2');
  $('rotate-cancel').click();

  // Opened again: the same, from the record.
  await openDocumentWindow(name, opener);
  await until(() => Number($('rotate-page-input').value) === 1, 'opened again on page 1');
  await walk(name, 3, 'opened again');
  const stored = new Uint8Array(await state.filesMap.get(name).arrayBuffer());
  const back = difference(await render(scan, 1), await render(stored, 1));
  assert.ok(back.share < 0.0005, `page 1 as scanned: ${(100 * back.share).toFixed(3)}% of pixels differ`);
  $('rotate-cancel').click();
  delete state.frontendInputData[name];
  state.filesMap.delete(name);
});

test('a straightened page read again (Force OCR) can still be put back exactly: the old layer goes, the straightening stays apart', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const scan = await scanPdfPages([scanCanvas({ tilt: 5 })]);
  const once = await ocrDocument(scan.slice(), { force: true, reorient: STRAIGHTEN });
  const again = await ocrDocument(new Uint8Array(once.bytes), { force: true, reorient: STRAIGHTEN });
  assert.equal(again.ok, true);
  assert.deepEqual(again.reoriented.straightened, [], 'level now, so not straightened twice');
  assert.equal((await items(again.bytes, 1)).length, (await items(once.bytes, 1)).length, 'one text layer, not two');
  const pdf = await PDFDocument.load(new Uint8Array(again.bytes));
  assert.equal(putBackAsScanned(pdf.getPage(0)), true, 'the straightening streams are still there to take out');
  const undone = await pdf.save();
  const back = difference(await render(scan, 1), await render(undone, 1));
  assert.ok(back.share < 0.0005, `${(100 * back.share).toFixed(3)}% of pixels differ`);
  if (havePoppler()) {
    const p = difference(await renderPoppler(scan, 1), await renderPoppler(undone, 1));
    assert.ok(p.share < 0.0005, `poppler: ${(100 * p.share).toFixed(3)}% of pixels differ`);
  }
  for (const it of await items(undone, 1)) assert.ok(Math.abs(it.angle + 5) < 0.5, `"${it.text}" runs at ${it.angle.toFixed(2)}`);
});
