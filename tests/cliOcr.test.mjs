/**
 * The command line's OCR path: scripts/cliOcrEngine.mjs (the Node tesseract-wasm driver) and
 * scripts/cliOcrDocument.mjs (the per-document orchestrator), plus the real CLI's ocr.mode / per-file
 * forceOcr wiring (scripts/build-cli.mjs), run as a real child process the same way
 * tests/bundletoolCli.test.mjs does. @napi-rs/canvas and tesseract-wasm are optionalDependencies
 * (package.json); a test that genuinely needs the real native binary skips itself when it is absent,
 * the same pattern tests/cover.test.mjs uses for poppler. The 'unavailable'
 * and 'failed' return shapes are tested by INJECTING a loader (loadOcrRuntime's own parameters,
 * ocrDocument's own _loadOcrRuntime override), so those cases run deterministically regardless of
 * what is actually installed on the machine running this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import * as fx from './fixtures.mjs';
import { loadPdf } from '../public/js/bundletoolPdfLoad.js';
import { loadOcrRuntime, ocrSession } from '../scripts/cliOcrEngine.mjs';
import { ocrDocument, releaseBytes } from '../scripts/cliOcrDocument.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'scripts', 'build-cli.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'btocr-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000, ...opts });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, json };
}

/** A one-page PDF whose only content is a raster of `text`: no real text layer, pdf.js's own
 * getTextContent() reports ~0 characters, exactly the shape a scanner produces and bundletoolOcr.js's
 * needsOcr() exists to catch. Mirrors how the browser's own equivalent fixture would look, just built
 * with @napi-rs/canvas instead of a real scanner. */
async function makeScannedPdf(text, { width = 1700, height = 2200 } = {}) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'black';
  ctx.textBaseline = 'top';
  ctx.font = '48px "DejaVu Sans"';
  ctx.fillText(text, 100, 200);
  const png = canvas.toBuffer('image/png');
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  return doc.save();
}

/** A one-page PDF with a real, extractable vector text layer well past bundletoolOcr.js's own
 * 40-char OCR_MIN_CHARS threshold, in a deliberately small font: fx.makePdf's own fixed 24pt label
 * clips at around 39 to 41 characters on an A4 page before pdf.js's text extraction sees them, so it
 * cannot be used for a test that needs a long real layer. */
async function makeTextPdf(text) {
  const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText(text, { x: 60, y: 700, size: 10, font });
  return doc.save();
}

/** Extracts pdf.js's own text content for every page, for asserting a text layer landed (or did not)
 * without depending on poppler. */
async function extractText(bytes) {
  const pdfjsLib = await import('/vendor/pdfjs.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str).join(' '));
  }
  return pages;
}

let HAVE_OCR_RUNTIME = null;
async function haveOcrRuntime() {
  if (HAVE_OCR_RUNTIME === null) HAVE_OCR_RUNTIME = (await loadOcrRuntime()).available;
  return HAVE_OCR_RUNTIME;
}

// ── cliOcrEngine.mjs: loadOcrRuntime() ──────────────────────────────────────

test('loadOcrRuntime reports unavailable, with a reason, when either import rejects (injected, not dependent on what is installed)', async () => {
  const r1 = await loadOcrRuntime({ importCanvas: () => Promise.reject(new Error('no prebuilt binary for this platform')), importTesseract: () => import('tesseract-wasm/node') });
  assert.equal(r1.available, false);
  assert.match(r1.reason, /no prebuilt binary/);

  const r2 = await loadOcrRuntime({ importCanvas: () => import('@napi-rs/canvas'), importTesseract: () => Promise.reject(new Error('module not found')) });
  assert.equal(r2.available, false);
});

test('loadOcrRuntime reports available and returns usable constructors when real on this machine', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const r = await loadOcrRuntime();
  assert.equal(r.available, true);
  assert.equal(typeof r.createCanvas, 'function');
  assert.equal(typeof r.createOCRClient, 'function');
});

// ── cliOcrDocument.mjs: ocrDocument() ───────────────────────────────────────

test('a page with a real text layer is left alone: no OCR runtime even loaded, bytes returned null', async () => {
  const bytes = await makeTextPdf('ALREADY HAS A REAL TEXT LAYER, WELL PAST FORTY CHARACTERS LONG');
  // Prove the runtime is never reached for this path: an injected loader that always throws would
  // surface as reason 'unavailable' if called at all; it must not be.
  const result = await ocrDocument(bytes, { _loadOcrRuntime: () => { throw new Error('should not be called'); } });
  assert.deepEqual(result, { ok: true, bytes: null, ocredPages: 0, failures: [] });
});

test('a scanned page (no real text layer) is OCR\'d and gains a real, searchable text layer', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const bytes = await makeScannedPdf('HELLO BUNDLE TEST');
  const pages = [];
  const result = await ocrDocument(bytes, { onPage: (i, total) => pages.push([i, total]) });
  assert.equal(result.ok, true);
  assert.equal(result.ocredPages, 1);
  assert.ok(result.bytes);
  assert.deepEqual(pages, [[1, 1]]);
  const [extracted] = await extractText(new Uint8Array(result.bytes));
  assert.match(extracted, /HELLO/);
  assert.match(extracted, /BUNDLE/);
});

test('force:true OCRs a page that already has a real text layer, mirroring the browser\'s Force OCR button', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const bytes = await fx.makePdf(1, 'ALREADY TEXT');
  const result = await ocrDocument(bytes, { force: true });
  // A real vector-text page rasterised and re-recognised may not OCR back to the exact original
  // string (font substitution, anti-aliasing): the point of this test is that the engine runs at
  // all when forced, not exact text fidelity (covered by the scanned-page test above).
  assert.equal(result.ok, true);
  assert.equal(result.ocredPages, 1);
});

// A page scanned off level. The engine does not read a tilted page a little worse; it can fail to read it at all:
// read without straightening, this page, tilted 3 degrees clockwise, gives none of its words.
const TILTED_LINES = [
  'The court made the following order on the first day of the hearing',
  'Both parties shall file and serve a short statement of their position',
  'The matter is listed for a further directions appointment before a judge',
  'Each party must comply with this order by four pm on the date shown below',
  'Any application to vary or discharge this order must be made on notice',
  'The respondent shall not remove the child from the jurisdiction of England',
];
const TILT_W = 1700;
const TILT_H = 2200;

function drawTiltedPage(degrees) {
  const canvas = createCanvas(TILT_W, TILT_H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, TILT_W, TILT_H);
  ctx.fillStyle = 'black';
  ctx.textBaseline = 'top';
  ctx.font = '40px "DejaVu Sans"';
  ctx.translate(TILT_W / 2, TILT_H / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.translate(-TILT_W / 2, -TILT_H / 2);
  TILTED_LINES.forEach((line, i) => ctx.fillText(line, 140, 300 + i * 90));
  return canvas;
}

async function scannedPdfFrom(canvas) {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawImage(await doc.embedPng(canvas.toBuffer('image/png')), { x: 0, y: 0, width: 612, height: 792 });
  return doc.save();
}

/** Every text item pdf.js finds on page 1: its words and where it starts, in PDF points (origin bottom left). */
async function textItems(bytes) {
  const pdfjsLib = await import('/vendor/pdfjs.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  return content.items.filter((it) => it.str.trim()).map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5] }));
}

test('a page scanned 3 degrees off level is straightened before it is read, and the text layer lands on the printed words', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const canvas = drawTiltedPage(3);
  const result = await ocrDocument(await scannedPdfFrom(canvas), { force: true });
  assert.equal(result.ok, true);
  assert.ok(result.bytes, 'the page was read');
  const items = await textItems(new Uint8Array(result.bytes));

  // Read: nearly every word of the page is in the text layer (none without straightening).
  const got = new Map();
  for (const w of items.flatMap((i) => i.text.toLowerCase().split(/\s+/))) got.set(w, (got.get(w) ?? 0) + 1);
  const truth = TILTED_LINES.join(' ').toLowerCase().split(/\s+/);
  let found = 0;
  for (const w of truth) if ((got.get(w) ?? 0) > 0) { found++; got.set(w, got.get(w) - 1); }
  assert.ok(found / truth.length >= 0.9, `only ${found} of ${truth.length} words came back`);

  // Placed: each word starts on the printed ink, not somewhere the straightened page had it. A box mapped back the
  // wrong way would be tens of points off, so most words would start in white space.
  const px = canvas.getContext('2d').getImageData(0, 0, TILT_W, TILT_H).data;
  const scale = TILT_W / 612;
  let onInk = 0;
  for (const it of items) {
    const x = Math.round(it.x * scale);
    const base = Math.round((792 - it.y) * scale);
    let ink = false;
    for (let yy = base - 46; yy <= base + 8 && !ink; yy++) {
      for (let xx = x - 6; xx <= x + 14; xx++) {
        if (xx >= 0 && xx < TILT_W && yy >= 0 && yy < TILT_H && px[(yy * TILT_W + xx) * 4] < 128) { ink = true; break; }
      }
    }
    if (ink) onInk++;
  }
  assert.ok(onInk / items.length >= 0.9, `only ${onInk} of ${items.length} words start on printed ink`);
});

test('a level page is read as it is: nothing is rotated', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const result = await ocrDocument(await scannedPdfFrom(drawTiltedPage(0)), { force: true });
  assert.equal(result.ok, true);
  const text = (await textItems(new Uint8Array(result.bytes))).map((i) => i.text).join(' ').toLowerCase();
  for (const word of ['court', 'parties', 'directions', 'jurisdiction']) assert.ok(text.includes(word), `${word} was read`);
});

// A page scanned on its side, upside down or tilted a long way is turned upright before it is read, and the
// text layer goes back onto the page as scanned, each word's text running the way its printed line runs.

/** The six lines above, upright, then the whole sheet turned `turn` degrees counter-clockwise (as a scan stored on
 * its side) or tilted `tilt` degrees clockwise on a larger sheet (as paper put crooked on the glass). */
function drawTurnedPage({ turn = 0, tilt = 0 } = {}) {
  const upright = drawTiltedPage(0);
  const side = turn === 90 || turn === 270;
  const w = tilt ? 2600 : side ? TILT_H : TILT_W;
  const h = tilt ? 2600 : side ? TILT_W : TILT_H;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(((tilt - turn) * Math.PI) / 180);
  ctx.drawImage(upright, -TILT_W / 2, -TILT_H / 2);
  return canvas;
}

async function scannedPdfOfSize(canvas) {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const pw = (canvas.width * 72) / 200, ph = (canvas.height * 72) / 200;   // scanned at 200 dpi
  const page = doc.addPage([pw, ph]);
  page.drawImage(await doc.embedPng(canvas.toBuffer('image/png')), { x: 0, y: 0, width: pw, height: ph });
  return doc.save();
}

/** Every text item pdf.js finds on page 1, with the direction its text runs (degrees, counter-clockwise). */
async function turnedItems(bytes) {
  const pdfjsLib = await import('/vendor/pdfjs.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  return content.items.filter((it) => it.str.trim()).map((it) => {
    const [a, b, , , x, y] = it.transform;
    return { text: it.str, x, y, angle: (Math.atan2(b, a) * 180) / Math.PI };
  });
}

for (const [name, shape, runs] of [
  ['on its left side (turned a quarter turn anticlockwise)', { turn: 90 }, 90],
  ['upside down', { turn: 180 }, 180],
  ['on its right side', { turn: 270 }, -90],
  ['tilted 30 degrees', { tilt: 30 }, -30],
]) {
  test(`a page scanned ${name} is read, and each word of its text layer starts on the printed word and runs with it`, async (t) => {
    if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
    const canvas = drawTurnedPage(shape);
    const result = await ocrDocument(await scannedPdfOfSize(canvas), { force: true });
    assert.equal(result.ok, true);
    assert.ok(result.bytes, 'the page was read');
    const items = await turnedItems(new Uint8Array(result.bytes));

    const got = new Map();
    for (const w of items.flatMap((i) => i.text.toLowerCase().split(/\s+/))) got.set(w, (got.get(w) ?? 0) + 1);
    const truth = TILTED_LINES.join(' ').toLowerCase().split(/\s+/);
    let found = 0;
    for (const w of truth) if ((got.get(w) ?? 0) > 0) { found++; got.set(w, got.get(w) - 1); }
    assert.ok(found / truth.length >= 0.9, `only ${found} of ${truth.length} words came back`);

    // Each word runs the way its printed line runs, and starts on printed ink: a few points along the text from its
    // start and up from its baseline, in the page as scanned. A box mapped back the wrong way lands in white space.
    const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const scale = 200 / 72;
    const pageH = canvas.height / scale;
    let onInk = 0;
    for (const it of items) {
      assert.ok(Math.abs(((it.angle - runs + 540) % 360) - 180) < 1.5, `"${it.text}" runs at ${it.angle.toFixed(1)}, not ${runs}`);
      const a = (it.angle * Math.PI) / 180;
      let ink = false;
      for (let along = 0; along <= 10 && !ink; along += 1) {
        for (let up = 1; up <= 14 && !ink; up += 1) {
          const X = it.x + along * Math.cos(a) - up * Math.sin(a);
          const Y = it.y + along * Math.sin(a) + up * Math.cos(a);
          const xx = Math.round(X * scale), yy = Math.round((pageH - Y) * scale);
          if (xx >= 0 && xx < canvas.width && yy >= 0 && yy < canvas.height && px[(yy * canvas.width + xx) * 4] < 128) ink = true;
        }
      }
      if (ink) onInk++;
    }
    assert.ok(onInk / items.length >= 0.9, `only ${onInk} of ${items.length} words start on printed ink`);
  });
}

// A scanner or phone app that stores a page turned sets /Rotate so it is displayed upright. OCR rasterises a page in
// its own unrotated space (where the text layer goes), so the raster is turned by the page's /Rotate before it is
// read; read as stored, such a page gives garbage.
for (const rotate of [90, 180, 270]) {
  test(`a page stored turned with /Rotate ${rotate} to show it upright is read, and its words sit over the text as displayed`, async (t) => {
    if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
    const { execFileSync, spawnSync } = await import('node:child_process');
    if (spawnSync('pdftotext', ['-v']).error) return t.skip('pdftotext (poppler) is not installed');
    // Stored turned anticlockwise by `rotate`; /Rotate turns it clockwise by the same, back upright.
    const stored = drawTurnedPage({ turn: rotate });
    const { PDFDocument, degrees } = await import('@cantoo/pdf-lib');
    const doc = await PDFDocument.create();
    const pw = (stored.width * 72) / 200, ph = (stored.height * 72) / 200;
    const page = doc.addPage([pw, ph]);
    page.drawImage(await doc.embedPng(stored.toBuffer('image/png')), { x: 0, y: 0, width: pw, height: ph });
    page.setRotation(degrees(rotate));
    // The engine's own orientation check is made to answer "upright" whatever it sees, so only /Rotate can turn
    // the page: this is the /Rotate path on its own, not the pixels' check standing in for it.
    const runtime = await loadOcrRuntime();
    const blind = async () => ({ ...runtime, createOCRClient: (...a) => {
      const client = runtime.createOCRClient(...a);
      client.getOrientation = async () => ({ rotation: 0, confidence: 1 });
      return client;
    } });
    const result = await ocrDocument(await doc.save(), { force: true, _loadOcrRuntime: blind });
    assert.equal(result.ok, true);
    assert.ok(result.bytes, 'the page was read');

    const dir = tmp();
    try {
      const file = path.join(dir, 'out.pdf');
      fs.writeFileSync(file, result.bytes);
      const html = execFileSync('pdftotext', ['-bbox', file, '-']).toString();
      const words = [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
        .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: m[5] }));
      const truth = TILTED_LINES.join(' ').toLowerCase().split(/\s+/);
      const got = new Map();
      for (const w of words) got.set(w.text.toLowerCase(), (got.get(w.text.toLowerCase()) ?? 0) + 1);
      let found = 0;
      for (const w of truth) if ((got.get(w) ?? 0) > 0) { found++; got.set(w, got.get(w) - 1); }
      assert.ok(found / truth.length >= 0.9, `only ${found} of ${truth.length} words came back`);
      // As displayed the page is the upright drawing; every word box poppler reports covers some of its ink.
      const upright = drawTiltedPage(0);
      const px = upright.getContext('2d').getImageData(0, 0, TILT_W, TILT_H).data;
      const s = 200 / 72;
      let onInk = 0;
      for (const w of words) {
        let ink = false;
        for (let y = Math.floor(w.y0 * s); y <= Math.ceil(w.y1 * s) && !ink; y++) {
          for (let x = Math.floor(w.x0 * s); x <= Math.ceil(w.x1 * s); x++) {
            if (x >= 0 && x < TILT_W && y >= 0 && y < TILT_H && px[(y * TILT_W + x) * 4] < 128) { ink = true; break; }
          }
        }
        if (ink) onInk++;
      }
      assert.ok(onInk / words.length >= 0.95, `only ${onInk} of ${words.length} word boxes cover printed ink`);
    } finally {
      rm(dir);
    }
  });
}

// A ruled table loses whole columns of text (dates, amounts) unless the engine is told the image's resolution:
// handed bare pixels, Tesseract assumes 70 dpi, and its ruled-line finding and layout go wrong at that scale.
// Without the resolution, this page loses about half its words, every date and amount among them.
const TABLE_ROWS = Array.from({ length: 20 }, (_, i) => [
  `${String((i * 7) % 28 + 1).padStart(2, '0')}/0${(i % 9) + 1}/2025`,
  ['Court fee', 'Copy order', 'Hearing', 'Bundle', 'Postage'][i % 5],
  `BENCH-${4100 + i * 37}`,
  `${(i * 53) % 900 + 10}.${String((i * 17) % 100).padStart(2, '0')}`,
  ['AB', 'CD', 'EF', 'GH'][i % 4],
]);

function drawRuledTable() {
  const W = 1654, H = 2339;   // A4 at 200 dpi
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'black';
  ctx.font = '25px "DejaVu Sans"';
  ctx.textBaseline = 'middle';
  const cols = [150, 420, 760, 1080, 1320, 1500];
  const top = 300, rowH = 70;
  ctx.fillText('Schedule of payments', 150, 220);
  TABLE_ROWS.forEach((row, r) => row.forEach((cell, c) => ctx.fillText(cell, cols[c] + 18, top + r * rowH + rowH / 2)));
  ctx.fillRect(cols[0], top, cols[5] - cols[0], 3);
  for (let r = 0; r <= TABLE_ROWS.length; r++) ctx.fillRect(cols[0], top + r * rowH, cols[5] - cols[0], 3);
  for (const x of cols) ctx.fillRect(x, top, 3, TABLE_ROWS.length * rowH + 3);
  return canvas;
}

/** A stand-in OCR client that records what it is asked, with or without the engine handle the session reaches for. */
function recordingClient(calls, { engine = true, refuse = false } = {}) {
  return () => ({
    _ocrEngine: engine ? Promise.resolve({
      setVariable: async (name, value) => { calls.push(['setVariable', name, value]); if (refuse) throw new Error('no such variable'); },
    }) : undefined,
    loadModel: async () => {},
    loadImage: async (image) => { calls.push(['loadImage', image.width]); },
    getTextBoxes: async () => [{ text: 'word', rect: { left: 1, top: 2, right: 3, bottom: 4 } }],
    clearImage: async () => {},
    destroy: async () => {},
  });
}

test('the session tells the engine each image\'s resolution, rounded, before it loads the image', async () => {
  const calls = [];
  const session = await ocrSession(recordingClient(calls));
  const image = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  await session.recognizeWords(image, { dpi: 199.6 });
  await session.load(image, { dpi: 141.4 });
  assert.deepEqual(calls, [['setVariable', 'user_defined_dpi', '200'], ['loadImage', 1], ['setVariable', 'user_defined_dpi', '141'], ['loadImage', 1]]);
});

test('an engine that cannot be told the resolution reads the page anyway', async () => {
  for (const opts of [{ engine: false }, { refuse: true }]) {
    const calls = [];
    const session = await ocrSession(recordingClient(calls, opts));
    const words = await session.recognizeWords({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, { dpi: 200 });
    assert.equal(words.length, 1, JSON.stringify(opts));
    assert.ok(calls.some((c) => c[0] === 'loadImage'));
  }
});

test('the vendored tesseract-wasm keeps the engine handle the session sets the resolution through', () => {
  // OCRClient has no setVariable of its own; the worker's OCREngine does, reached through the client's _ocrEngine.
  // A new build that renames either fails here rather than silently reading every page at 70 dpi.
  // The served copy is found where the tests' own resolver finds /vendor/ (static/ inside this folder, or one level
  // up when the tool is built as part of the full site); the npm copy is the one the command line runs.
  const served = [path.join(root, 'static', 'vendor'), path.join(root, '..', 'static', 'vendor')].find((d) => fs.existsSync(d));
  assert.ok(served, 'static/vendor/ was found');
  const dirs = [path.join(served, 'tesseract-wasm'), path.join(root, 'node_modules', 'tesseract-wasm', 'dist')].filter((d) => fs.existsSync(d));
  assert.ok(dirs.length >= 1);
  for (const dir of dirs) {
    const lib = fs.readFileSync(path.join(dir, 'lib.js'), 'utf8');
    const worker = fs.readFileSync(path.join(dir, 'tesseract-worker.js'), 'utf8');
    assert.match(lib, /this\._ocrEngine = remote\.createOCREngine\(/, dir);
    assert.match(worker, /setVariable\(name, value\) \{/, dir);
  }
});

test('a ruled table is read whole, dates and amounts included: the engine is told the page\'s resolution', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const canvas = drawRuledTable();
  const result = await ocrDocument(await scannedPdfOfSize(canvas), { force: true });
  assert.equal(result.ok, true);
  const text = (await turnedItems(new Uint8Array(result.bytes))).map((i) => i.text).join(' ');
  const got = new Map();
  for (const w of text.split(/\s+/).filter(Boolean)) got.set(w, (got.get(w) ?? 0) + 1);
  const truth = TABLE_ROWS.flat().flatMap((c) => c.split(' '));
  let found = 0;
  for (const w of truth) if ((got.get(w) ?? 0) > 0) { found++; got.set(w, got.get(w) - 1); }
  assert.ok(found / truth.length >= 0.9, `only ${found} of ${truth.length} cells' words came back: ${text.slice(0, 300)}`);
  const dates = TABLE_ROWS.filter((row) => text.includes(row[0])).length;
  assert.ok(dates >= 18, `only ${dates} of 20 dates came back`);
});

test('ocrDocument reports reason "unavailable" (not a throw) when the runtime cannot load, via an injected loader', async () => {
  const bytes = await makeScannedPdf('NEEDS OCR');
  const result = await ocrDocument(bytes, { _loadOcrRuntime: async () => ({ available: false, reason: 'simulated: no prebuilt binary for this platform' }) });
  assert.deepEqual(result, { ok: false, reason: 'unavailable', detail: 'simulated: no prebuilt binary for this platform' });
});

test('a per-page recognition failure lands in result.failures (ok:true overall), not a throw and not a top-level failure', async () => {
  const bytes = await makeScannedPdf('NEEDS OCR');
  const failingRuntime = async () => ({
    available: true,
    createCanvas,
    createOCRClient: () => ({
      loadModel: async () => {},
      loadImage: async () => { throw new Error('simulated engine failure'); },
      getTextBoxes: async () => [],
      clearImage: async () => {},
      destroy: async () => {},
    }),
  });
  const result = await ocrDocument(bytes, { _loadOcrRuntime: failingRuntime });
  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].page, 1);
  // The real error's own message ("simulated engine failure") must NOT appear: only fixed text and
  // the error's class name may reach this field, since a real failure's message can carry this
  // machine's own absolute paths or other local detail.
  assert.doesNotMatch(result.failures[0].detail, /simulated engine failure/);
  assert.match(result.failures[0].detail, /recognise the page/);
  assert.equal(result.bytes, null); // nothing succeeded, the only target page failed
  assert.equal(result.ocredPages, 0);
});

// Reading a page again replaces its old invisible layer (bundletoolOcrRedo.js) rather than adding a second one. Counted
// as pdf.js reports text items and as a viewer's find bar counts a word: poppler's pdftotext drops text drawn twice in
// one place, so it hides exactly this.
async function layerCounts(bytes, word = 'order') {
  const pdfjsLib = await import('/vendor/pdfjs.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false, verbosity: 0 }).promise;
  let items = 0, finds = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const found = (await (await doc.getPage(i)).getTextContent()).items.filter((it) => it.str.trim());
    items += found.length;
    finds += (found.map((it) => it.str).join(' ').match(new RegExp(`\\b${word}\\b`, 'gi')) ?? []).length;
  }
  return { items, finds };
}

function renderPage(bytes) {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, 'p.pdf'), bytes);
    const r = spawnSync('pdftoppm', ['-r', '60', '-gray', '-singlefile', path.join(d, 'p.pdf'), path.join(d, 'out')]);
    assert.equal(r.status, 0);
    return fs.readFileSync(path.join(d, 'out.pgm'));
  } finally { rm(d); }
}

test('Force OCR on a page read before replaces its text layer: as many items and finds as once, and the page looks the same', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const scan = await scannedPdfFrom(drawTiltedPage(0));
  const once = await ocrDocument(scan.slice(), { force: true });
  const twice = await ocrDocument(new Uint8Array(once.bytes), { force: true });
  const a = await layerCounts(new Uint8Array(once.bytes));
  const b = await layerCounts(new Uint8Array(twice.bytes));
  assert.ok(a.finds >= 2, `the first reading found "order" ${a.finds} times`);
  assert.deepEqual(b, a, 'read twice, the page carries one layer, not two');
  if (spawnSync('pdftoppm', ['-v']).error) return;
  const original = renderPage(scan);
  assert.ok(renderPage(new Uint8Array(twice.bytes)).equals(original), 'the page looks exactly as scanned');
});

// Only what is not already text (bundletoolOcrPrinted.js): a page's own visible text is not read a second time, while
// print in its images still is.

/** A page of real, visible text in an embedded font, `lines` lines down from the top; optionally a scan below it. */
async function bornDigitalPage({ lines, scan } = {}) {
  const { PDFDocument, getFontkit } = await import('../public/js/bundletoolPdfLib.js');
  const doc = await PDFDocument.create();
  doc.registerFontkit(await getFontkit());
  const font = await doc.embedFont(fs.readFileSync(path.join(root, 'public/fonts/serif/NotoSerif-Regular.ttf')), { subset: false });
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 60, y: 740 - i * 22, size: 12, font }));
  if (scan) page.drawImage(await doc.embedPng(scan.toBuffer('image/png')), { x: 0, y: 0, width: 612, height: 400 });
  return doc.save();
}

const LICENCE_LINES = [
  'This License applies to the whole of the work and to every copy of it.',
  'Each party may rely on the License as written on the date of signing.',
  'The License may be varied only in writing, signed by both parties.',
  'Nothing in this License limits a right that cannot be limited by law.',
];

test('Force OCR on a page of real text adds nothing: each visible word is found as often as before', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const page = await bornDigitalPage({ lines: LICENCE_LINES });
  const before = await layerCounts(page, 'License');
  assert.equal(before.finds, 4);
  const result = await ocrDocument(page.slice(), { force: true });
  assert.equal(result.ok, true);
  const after = await layerCounts(result.bytes ? new Uint8Array(result.bytes) : page, 'License');
  assert.deepEqual(after, before, '"License" is found as often as before, and no text item was added');
});

test('on a page of real text over a scan, the scan\'s print is still read and the real text is not read again', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  // The scan: the six lines of TILTED_LINES, level, drawn into the bottom half of the page.
  const page = await bornDigitalPage({ lines: LICENCE_LINES, scan: drawTiltedPage(0) });
  const result = await ocrDocument(page.slice(), { force: true });
  assert.equal(result.ok, true);
  const bytes = new Uint8Array(result.bytes);
  assert.equal((await layerCounts(bytes, 'License')).finds, 4, 'the real text is not read again');
  for (const word of ['jurisdiction', 'directions', 'respondent']) {
    assert.equal((await layerCounts(bytes, word)).finds, 1, `"${word}", printed in the scan, is read once`);
  }
});

test('a scan with a visible stamp and an old layer: the layer is replaced, the stamp is kept and not read again', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const { PDFDocument, getFontkit } = await import('../public/js/bundletoolPdfLib.js');
  const read = await ocrDocument(await scannedPdfFrom(drawTiltedPage(0)), { force: true });
  const doc = await PDFDocument.load(new Uint8Array(read.bytes));
  doc.registerFontkit(await getFontkit());
  const font = await doc.embedFont(fs.readFileSync(path.join(root, 'public/fonts/serif/NotoSerif-Regular.ttf')), { subset: false });
  doc.getPage(0).drawText('EXHIBIT MT1', { x: 420, y: 40, size: 16, font });
  const stamped = await doc.save();
  const before = { stamp: await layerCounts(stamped, 'EXHIBIT'), scan: await layerCounts(stamped, 'order') };
  assert.equal(before.stamp.finds, 1);
  const again = await ocrDocument(stamped.slice(), { force: true });
  const bytes = new Uint8Array(again.bytes);
  assert.equal((await layerCounts(bytes, 'EXHIBIT')).finds, 1, 'the stamp is there once');
  assert.equal((await layerCounts(bytes, 'order')).finds, before.scan.finds, 'the scan\'s words are there as often as before');
});

test('a page whose new reading finds nothing keeps the layer it had', async () => {
  const scan = await scannedPdfFrom(drawTiltedPage(0));
  // An existing layer, drawn without an engine.
  const { PDFDocument, StandardFonts } = await import('../public/js/bundletoolPdfLib.js');
  const { embedOcrLayer } = await import('../public/js/bundletoolOcr.js');
  const doc = await PDFDocument.load(scan);
  embedOcrLayer(doc.getPage(0), await doc.embedFont(StandardFonts.Helvetica), [{ text: 'order', x0: 100, y0: 100, x1: 300, y1: 140 }], 200);
  const layered = await doc.save();
  const silent = async () => ({
    available: true,
    createCanvas,
    createOCRClient: () => ({
      loadModel: async () => {}, loadImage: async () => {}, getTextBoxes: async () => [], clearImage: async () => {}, destroy: async () => {},
      getOrientation: async () => ({ rotation: 0, confidence: 1 }),
    }),
  });
  const result = await ocrDocument(layered.slice(), { force: true, _loadOcrRuntime: silent });
  assert.equal(result.ok, true);
  const after = result.bytes ? new Uint8Array(result.bytes) : layered;
  assert.equal((await layerCounts(after)).finds, 1, 'the old layer is still there');
});

// ── The real CLI: ocr.mode, forceOcr, warnings ──────────────────────────────

async function setupOcr(d, { scannedText = 'HELLO BUNDLE TEST', forceOcr, config = {} } = {}) {
  const docs = path.join(d, 'docs'); fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'scan.pdf'), await makeScannedPdf(scannedText));
  const fileEntry = { filename: 'scan.pdf', title: 'Scan' };
  if (forceOcr !== undefined) fileEntry.forceOcr = forceOcr;
  const manifest = {
    schemaVersion: 1,
    config: { 'heading.bundleTitle': 'T', 'heading.projectName': 'R', 'heading.claimNumber': 'C', ...config },
    sections: [{ sectionLabel: 'A', sectionName: 'Docs', files: [fileEntry] }],
  };
  const mp = path.join(d, 'm.json');
  fs.writeFileSync(mp, JSON.stringify(manifest));
  return { docs, mp, out: path.join(d, 'out.pdf') };
}

test('--config-keys lists ocr.mode with its default', () => {
  const r = cli(['--json', '--config-keys']);
  assert.equal(r.status, 0);
  assert.equal(r.json.configKeys['ocr.mode'], 'auto');
});

test('ocr.mode "auto" (the default) OCRs a scanned file; the built bundle has a searchable text layer', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const d = tmp();
  try {
    const { docs, mp, out } = await setupOcr(d);
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.warnings, []);
    const pages = await extractText(new Uint8Array(fs.readFileSync(out)));
    assert.ok(pages.some((p) => /HELLO/.test(p) && /BUNDLE/.test(p)), `no OCR'd text found across pages: ${JSON.stringify(pages)}`);
  } finally { rm(d); }
});

test('ocr.mode "off" skips OCR entirely: the scanned page stays without a text layer', async () => {
  const d = tmp();
  try {
    const { docs, mp, out } = await setupOcr(d, { config: { 'ocr.mode': 'off' } });
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stderr);
    const pages = await extractText(new Uint8Array(fs.readFileSync(out)));
    assert.ok(!pages.some((p) => /HELLO/.test(p)), `OCR ran despite ocr.mode "off": ${JSON.stringify(pages)}`);
  } finally { rm(d); }
});

test('a file\'s own forceOcr:true overrides ocr.mode "off" for that one file', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const d = tmp();
  try {
    const { docs, mp, out } = await setupOcr(d, { config: { 'ocr.mode': 'off' }, forceOcr: true });
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stderr);
    const pages = await extractText(new Uint8Array(fs.readFileSync(out)));
    assert.ok(pages.some((p) => /HELLO/.test(p)), `forceOcr did not override ocr.mode "off": ${JSON.stringify(pages)}`);
  } finally { rm(d); }
});

test('the real CLI\'s forceOcr on a file already read replaces its layer: the bundle finds each word once', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const d = tmp();
  try {
    const { docs, mp, out } = await setupOcr(d, { forceOcr: true });
    const read = await ocrDocument(new Uint8Array(fs.readFileSync(path.join(docs, 'scan.pdf'))), { force: true });
    fs.writeFileSync(path.join(docs, 'scan.pdf'), read.bytes);
    const before = await layerCounts(new Uint8Array(read.bytes), 'bundle');
    assert.ok(before.finds >= 1);
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json?.ok, true, `stdout is the JSON result alone: ${r.stdout.slice(0, 300)}`);
    const after = await layerCounts(new Uint8Array(fs.readFileSync(out)), 'bundle');
    assert.equal(after.finds, before.finds, `"bundle" found ${after.finds} times in the bundle, ${before.finds} in the file`);
  } finally { rm(d); }
});

test('a non-boolean forceOcr is refused as invalid_manifest, naming the file', () => {
  const d = tmp();
  try {
    const docs = path.join(d, 'docs'); fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'scan.pdf'), Buffer.from('not a real pdf, never read: rejected before that'));
    const manifest = {
      schemaVersion: 1,
      config: { 'heading.bundleTitle': 'T', 'heading.projectName': 'R', 'heading.claimNumber': 'C' },
      sections: [{ sectionLabel: 'A', sectionName: 'Docs', files: [{ filename: 'scan.pdf', forceOcr: 'yes' }] }],
    };
    const mp = path.join(d, 'm.json');
    fs.writeFileSync(mp, JSON.stringify(manifest));
    const r = cli(['--json', mp, docs, path.join(d, 'out.pdf')]);
    assert.equal(r.status, 3);
    assert.equal(r.json.error.code, 'invalid_manifest');
    assert.match(r.json.error.message, /forceOcr/);
  } finally { rm(d); }
});

test('an invalid ocr.mode config value is refused as invalid_config', async () => {
  const d = tmp();
  try {
    const docs = path.join(d, 'docs'); fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'doc.pdf'), await fx.makePdf(1, 'DOC'));
    const manifest = {
      schemaVersion: 1,
      config: { 'heading.bundleTitle': 'T', 'heading.projectName': 'R', 'heading.claimNumber': 'C', 'ocr.mode': 'sometimes' },
      sections: [{ sectionLabel: 'A', sectionName: 'Docs', files: [{ filename: 'doc.pdf' }] }],
    };
    const mp = path.join(d, 'm.json');
    fs.writeFileSync(mp, JSON.stringify(manifest));
    const r = cli(['--json', mp, docs, path.join(d, 'out.pdf')]);
    assert.equal(r.status, 3, r.stderr);
    assert.equal(r.json.error.code, 'invalid_config');
    assert.match(r.json.error.message, /OCR mode/);
  } finally { rm(d); }
});

test('the exit code proves no hang: the CLI process terminates on its own once OCR (and its worker_threads client) is done', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const d = tmp();
  try {
    const { docs, mp, out } = await setupOcr(d);
    const r = cli(['--json', mp, docs, out]);
    // spawnSync sets status to null and signal to 'SIGTERM' if the 60s timeout above had to kill it:
    // a real hang would show up as exactly that, not as a normal exit.
    assert.equal(r.signal, null, `process was killed (hung): ${JSON.stringify(r)}`);
    assert.equal(r.status, 0);
  } finally { rm(d); }
});

// ── The real CLI with the dependency genuinely absent ───────────────────────
// Not an injected simulation: the CLI runs from a copy of its own scripts whose node_modules holds every installed
// package except @napi-rs/canvas (each one a link to the real install), so it resolves the package exactly as it would
// on a machine where `npm install` skipped an optionalDependency with no prebuilt binary for that platform. The same
// copy gives the truncated model test below a public/ocr/eng.traineddata of its own. The shared tree itself is never
// touched: node:test runs the *.test.mjs files at the same time, and any of them may be loading @napi-rs/canvas,
// tesseract-wasm or the model while this runs (the OCR page-change tests do). sharedTree.test.mjs keeps every test
// file from moving, overwriting or deleting anything in the tool's own folders.

/** Links every entry of `from` into `to` (a new folder), except those `replace` names (paths relative to `from`): one
 * given bytes is written there instead, one given null is left out, and a folder on the way to either is made for real
 * and linked inside the same way. */
function linkTree(from, to, replace = {}) {
  fs.mkdirSync(to);
  for (const name of fs.readdirSync(from)) {
    const inside = Object.fromEntries(Object.entries(replace)
      .filter(([rel]) => rel.startsWith(`${name}/`)).map(([rel, bytes]) => [rel.slice(name.length + 1), bytes]));
    if (Object.hasOwn(replace, name)) {
      if (replace[name] !== null) fs.writeFileSync(path.join(to, name), replace[name]);
    } else if (Object.keys(inside).length) linkTree(path.join(from, name), path.join(to, name), inside);
    else fs.symlinkSync(path.join(from, name), path.join(to, name));
  }
}

/**
 * A copy of the command line in a folder of its own: its scripts copied, its public files, packages and the shared
 * static folder linked to the real ones, except what `modules` and `files` replace (see linkTree: paths relative to
 * node_modules and to the tool's public folder).
 */
function isolatedTool({ modules = {}, files = {} } = {}) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'btocr-isolated-'));
  const standalone = fs.existsSync(path.join(root, 'static', 'vendor'));
  const tool = path.join(top, 'bundletool');
  fs.mkdirSync(tool);
  fs.cpSync(path.join(root, 'scripts'), path.join(tool, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(tool, 'package.json'));
  linkTree(path.join(root, 'public'), path.join(tool, 'public'), files);
  linkTree(path.join(root, 'node_modules'), path.join(tool, 'node_modules'), modules);
  if (standalone) fs.symlinkSync(path.join(root, 'static'), path.join(tool, 'static'));
  else fs.symlinkSync(path.join(root, '..', 'static'), path.join(top, 'static'));
  const script = path.join(tool, 'scripts', 'build-cli.mjs');
  return {
    // Runs this copy, with the same result shape as cli().
    cli(args) {
      const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000 });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
      return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, json };
    },
    // rmSync removes a link, never what it points to.
    cleanup: () => rm(top),
  };
}

test('the real CLI emits ocr_unavailable and still builds when the dependency is genuinely not installed', async (t) => {
  if (!fs.existsSync(path.join(root, 'node_modules', '@napi-rs', 'canvas'))) return t.skip('@napi-rs/canvas is not installed to begin with');
  const d = tmp();
  const without = isolatedTool({ modules: { '@napi-rs/canvas': null } });
  try {
    const { docs, mp, out } = await setupOcr(d);
    const r = without.cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.warnings.length, 1);
    assert.equal(r.json.warnings[0].code, 'ocr_unavailable');
    assert.equal(r.json.warnings[0].file, 'scan.pdf');
    const pages = await extractText(new Uint8Array(fs.readFileSync(out)));
    assert.ok(!pages.some((p) => /HELLO/.test(p)), `OCR somehow still ran without the dependency: ${JSON.stringify(pages)}`);
    // The installed tree, which other test files read at this moment, still has it.
    assert.ok(fs.existsSync(path.join(root, 'node_modules', '@napi-rs', 'canvas', 'package.json')));
  } finally {
    without.cleanup();
    rm(d);
  }
});

// ── The try/catch boundary: never a throw, never a hang ──

test('a corrupted model (loadModel itself fails) is reported as "failed" with page:null, not a throw: the error-to-warning boundary covers session setup, not only recognition', async () => {
  const bytes = await makeScannedPdf('NEEDS OCR');
  const corruptedModelRuntime = async () => ({
    available: true,
    createCanvas,
    createOCRClient: () => ({
      loadModel: async () => { throw new Error('simulated: corrupted or truncated eng.traineddata'); },
      loadImage: async () => { throw new Error('should not be reached: loadModel already failed'); },
      getTextBoxes: async () => [],
      clearImage: async () => {},
      destroy: async () => {},
    }),
  });
  const result = await ocrDocument(bytes, { _loadOcrRuntime: corruptedModelRuntime });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed');
  // A fixed, specific phrase for this one failure mode: not the generic setup-failure phrase, and
  // not the real message text (which must not survive either way).
  assert.doesNotMatch(result.detail, /corrupted or truncated/);
  assert.equal(result.detail, 'the OCR model failed to load');
});

test('a PDF @cantoo/pdf-lib accepts but pdf.js itself rejects is reported as "failed", not a throw or a hang (a valid PDF truncated at about 95% satisfies pdf-lib\'s tolerant recovery but fails pdf.js\'s stricter structure check)', async () => {
  const good = await fx.makePdf(1, 'TEXT');
  const truncated = fx.truncate(good, 0.95);
  // Confirm the asymmetry holds for this exact fixture before trusting the rest of the assertion:
  // pdf-lib's tolerance can change between versions, and a silent change there would make this
  // test pass for the wrong reason.
  const { doc } = await loadPdf(new Uint8Array(truncated.buffer, truncated.byteOffset, truncated.byteLength));
  assert.equal(doc.getPageCount(), 1, 'fixture assumption broken: pdf-lib does not accept this truncated file');

  const result = await ocrDocument(new Uint8Array(truncated.buffer, truncated.byteOffset, truncated.byteLength), { force: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed'); // pdf.js rejects it before any specific page is reached
});

test('TWO files needing OCR while the engine is absent each get their OWN ocr_unavailable warning, not just the first', async (t) => {
  if (!fs.existsSync(path.join(root, 'node_modules', '@napi-rs', 'canvas'))) return t.skip('@napi-rs/canvas is not installed to begin with');
  const d = tmp();
  const without = isolatedTool({ modules: { '@napi-rs/canvas': null } });
  try {
    const docs = path.join(d, 'docs'); fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'scan1.pdf'), await makeScannedPdf('FIRST SCAN'));
    fs.writeFileSync(path.join(docs, 'scan2.pdf'), await makeScannedPdf('SECOND SCAN'));
    const manifest = {
      schemaVersion: 1,
      config: { 'heading.bundleTitle': 'T', 'heading.projectName': 'R', 'heading.claimNumber': 'C' },
      sections: [{ sectionLabel: 'A', sectionName: 'Docs', files: [{ filename: 'scan1.pdf' }, { filename: 'scan2.pdf' }] }],
    };
    const mp = path.join(d, 'm.json');
    fs.writeFileSync(mp, JSON.stringify(manifest));
    const r = without.cli(['--json', mp, docs, path.join(d, 'out.pdf')]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.warnings.length, 2, `expected one ocr_unavailable per file, got: ${JSON.stringify(r.json.warnings)}`);
    assert.deepEqual(r.json.warnings.map((w) => w.code), ['ocr_unavailable', 'ocr_unavailable']);
    assert.deepEqual(r.json.warnings.map((w) => w.file).sort(), ['scan1.pdf', 'scan2.pdf']);
  } finally {
    without.cleanup();
    rm(d);
  }
});

// ── Ordering: needsOcr() over every page decides BEFORE the runtime is ever probed ──
// A document whose every page clears the 40-char threshold costs nothing beyond the pdf.js
// text-layer check: no runtime probe, no warning, even with the real runtime absent.

test('a text-only PDF (every page over the OCR threshold) raises NO warning at all when the runtime is absent: it never needs OCR', async () => {
  if (!fs.existsSync(path.join(root, 'node_modules', '@napi-rs', 'canvas'))) return;
  const d = tmp();
  const without = isolatedTool({ modules: { '@napi-rs/canvas': null } });
  try {
    const docs = path.join(d, 'docs'); fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'doc.pdf'), await makeTextPdf('A GENUINELY REAL TEXT LAYER, WELL OVER FORTY CHARACTERS IN LENGTH'));
    const manifest = {
      schemaVersion: 1,
      config: { 'heading.bundleTitle': 'T', 'heading.projectName': 'R', 'heading.claimNumber': 'C' },
      sections: [{ sectionLabel: 'A', sectionName: 'Docs', files: [{ filename: 'doc.pdf' }] }],
    };
    const mp = path.join(d, 'm.json');
    fs.writeFileSync(mp, JSON.stringify(manifest));
    const r = without.cli(['--json', mp, docs, path.join(d, 'out.pdf')]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.warnings, [], `a text-only document should never raise an OCR warning: ${JSON.stringify(r.json.warnings)}`);
  } finally {
    without.cleanup();
    rm(d);
  }
});

test('ocrDocument never even calls the runtime loader for a text-only PDF (asserted against a spy, not inferred from timing)', async () => {
  const bytes = await makeTextPdf('ANOTHER GENUINELY REAL TEXT LAYER, ALSO COMFORTABLY PAST FORTY CHARACTERS');
  let callCount = 0;
  const spyLoader = async () => { callCount++; return { available: false, reason: 'should not have been called at all' }; };
  const result = await ocrDocument(bytes, { _loadOcrRuntime: spyLoader });
  assert.equal(callCount, 0, 'the runtime loader was called for a document that never needed OCR');
  assert.deepEqual(result, { ok: true, bytes: null, ocredPages: 0, failures: [] });
});

// ── The real hang blocker: a genuinely truncated model file, the REAL worker ──
// The earlier "corrupted model" test above uses a fake client with no real worker, so it
// structurally cannot see the orphaned-worker hang: this one uses the real createOCRClient()
// against a real, truncated public/ocr/eng.traineddata.

test('a genuinely truncated model file fails fast through the real worker, and the CLI process still exits on its own', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const realModel = fs.readFileSync(path.join(root, 'public', 'ocr', 'eng.traineddata'));
  const d = tmp();
  // The copy's own model is truncated; the real one, which other test files read at this moment, is not touched.
  const truncated = isolatedTool({ files: { 'ocr/eng.traineddata': realModel.subarray(0, 1000) } });
  try {
    const { docs, mp, out } = await setupOcr(d);
    const started = Date.now();
    const r = truncated.cli(['--json', mp, docs, out]);
    const elapsedMs = Date.now() - started;
    assert.equal(r.signal, null, `process was killed (hung): ${JSON.stringify(r)}`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(elapsedMs < 10_000, `expected a fast failure, took ${elapsedMs}ms`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.warnings.length, 1);
    assert.equal(r.json.warnings[0].code, 'ocr_failed');
    assert.doesNotMatch(r.json.warnings[0].message, /eng\.traineddata|\/home\/|\/tmp\//, 'the warning must not leak a filesystem path');
    assert.ok(fs.readFileSync(path.join(root, 'public', 'ocr', 'eng.traineddata')).equals(realModel), 'the real model is untouched');
  } finally {
    truncated.cleanup();
    rm(d);
  }
});

// ── Partial progress on a per-page failure ──────────────────────────────────

/** A document whose middle page is oversized past even the scaled-down floor: always reported
 * "too large", regardless of this machine's real memory, so tests using this are deterministic
 * rather than a real OOM gamble: good, too-large, good. */
async function makeGoodTooLargeGoodPdf() {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const addScanPage = async (text) => {
    const canvas = createCanvas(1700, 2200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1700, 2200);
    ctx.fillStyle = 'black'; ctx.textBaseline = 'top'; ctx.font = '48px "DejaVu Sans"';
    ctx.fillText(text, 100, 200);
    const png = canvas.toBuffer('image/png');
    const page = doc.addPage([612, 792]);
    const img = await doc.embedPng(png);
    page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  };
  await addScanPage('GOOD PAGE ONE');
  doc.addPage([15000, 15000]); // page 2: always "too large"
  await addScanPage('GOOD PAGE THREE');
  return doc.save();
}

test('a failed page does not stop OCR on the pages after it in the same file (good, too-large, good)', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const bytes = await makeGoodTooLargeGoodPdf();

  const result = await ocrDocument(bytes, { force: true });
  assert.equal(result.ok, true);
  assert.equal(result.ocredPages, 2, 'pages 1 and 3 should both have succeeded');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].page, 2);
  assert.ok(result.bytes);

  const [page1Text, , page3Text] = await extractText(new Uint8Array(result.bytes));
  assert.match(page1Text, /GOOD/);
  assert.match(page1Text, /PAGE/);
  assert.match(page3Text, /THREE/, 'page 3 (after the failed page 2) must still have its own text layer');
});

test('the real CLI\'s warning for a failed page names only that page, and pages after it still succeed', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const d = tmp();
  try {
    const docs = path.join(d, 'docs'); fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'mixed.pdf'), await makeGoodTooLargeGoodPdf());
    const manifest = {
      schemaVersion: 1,
      config: { 'heading.bundleTitle': 'T', 'heading.projectName': 'R', 'heading.claimNumber': 'C' },
      sections: [{ sectionLabel: 'A', sectionName: 'Docs', files: [{ filename: 'mixed.pdf', forceOcr: true }] }],
    };
    const mp = path.join(d, 'm.json');
    fs.writeFileSync(mp, JSON.stringify(manifest));
    const r = cli(['--json', mp, docs, path.join(d, 'out.pdf')]);
    assert.equal(r.status, 0, r.stderr);
    // Not asserting the total warning count: a 15000x15000pt page is enough of an edge case that
    // the build engine's own, unrelated damaged-document recovery may also warn about it; this
    // test is about the ocr_failed warning's own wording, not an exhaustive warnings inventory.
    const ocrWarning = r.json.warnings.find((w) => w.code === 'ocr_failed');
    assert.ok(ocrWarning, `expected an ocr_failed warning, got: ${JSON.stringify(r.json.warnings)}`);
    assert.equal(ocrWarning.page, 2);
    assert.match(ocrWarning.message, /^mixed\.pdf, page 2: OCR failed \([^)]*\)\. That page has no searchable text layer/, 'isolated to the one page, since the others succeed independently');
    // Indexed by position in the SOURCE file (mixed.pdf) above, but the final bundle also has its
    // own index/cover pages first, so checked with .some() here, not by fixed array position.
    const outPages = await extractText(new Uint8Array(fs.readFileSync(path.join(d, 'out.pdf'))));
    assert.ok(outPages.some((p) => /GOOD/.test(p) && /PAGE/.test(p)), `page 1's text layer missing: ${JSON.stringify(outPages)}`);
    assert.ok(outPages.some((p) => /THREE/.test(p)), `page 3's text layer missing: ${JSON.stringify(outPages)}`);
  } finally {
    rm(d);
  }
});

// ── Two passes: pdf-lib opens the file only once pdf.js and the OCR engine are closed ──

test('pdf-lib opens the file only after every page is read and the OCR engine is closed, and each page keeps its own words', async () => {
  const bytes = await makeGoodTooLargeGoodPdf(); // built before PDFDocument.load is watched below
  const events = [];
  const pageWords = ['ALPHA', 'BRAVO'];
  const recordingRuntime = async () => ({
    available: true,
    createCanvas,
    createOCRClient: () => ({
      loadModel: async () => {},
      // A whole page, or a region of one read again for print the first look passed over (bundletoolOcrGaps.js).
      loadImage: async (image) => { events.push(image.width > 1000 ? 'page read' : 'region read'); },
      getTextBoxes: async () => (events.at(-1) === 'page read'
        ? [{ text: pageWords[events.filter((e) => e === 'page read').length - 1], rect: { left: 200, top: 300, right: 700, bottom: 360 } }]
        : []),
      clearImage: async () => {},
      destroy: async () => { events.push('engine closed'); },
    }),
  });
  const { PDFDocument } = await import('../public/js/bundletoolPdfLib.js');
  const realLoad = PDFDocument.load;
  PDFDocument.load = function (...args) { events.push('pdf-lib opened'); return realLoad.apply(this, args); };
  let result;
  try {
    result = await ocrDocument(bytes, { force: true, _loadOcrRuntime: recordingRuntime });
  } finally {
    PDFDocument.load = realLoad;
  }
  assert.equal(result.ok, true);
  assert.equal(result.ocredPages, 2);
  assert.deepEqual(result.failures.map((f) => f.page), [2]);
  const firstOpen = events.indexOf('pdf-lib opened');
  assert.ok(firstOpen > -1, `pdf-lib never opened the file: ${events.join(', ')}`);
  const reads = events.slice(0, firstOpen);
  assert.deepEqual(reads.filter((e) => e !== 'region read'), ['page read', 'page read', 'engine closed'], `order was: ${events.join(', ')}`);
  assert.equal(reads.at(-1), 'engine closed', `order was: ${events.join(', ')}`);
  assert.ok(!events.slice(firstOpen).some((e) => e.endsWith('read')), `a page was read after pdf-lib opened the file: ${events.join(', ')}`);
  const [page1, page2, page3] = await extractText(new Uint8Array(result.bytes));
  assert.match(page1, /ALPHA/);
  assert.doesNotMatch(page2, /ALPHA|BRAVO/);
  assert.match(page3, /BRAVO/);
});

test('releaseBytes frees bytes that own their whole buffer, including a file read the way the CLI reads it, and leaves anything shared alone', async () => {
  const whole = new Uint8Array(1024).fill(1);
  assert.equal(releaseBytes(whole), true);
  assert.equal(whole.length, 0);

  const d = tmp();
  try {
    const file = path.join(d, 'f.pdf');
    fs.writeFileSync(file, new Uint8Array(1024 * 1024).fill(2));
    const read = await fs.promises.readFile(file); // build-cli.mjs's own read
    assert.equal(releaseBytes(read), true);
    assert.equal(read.length, 0);
  } finally {
    rm(d);
  }

  const big = new Uint8Array(1024).fill(3);
  const part = big.subarray(10, 100);
  assert.equal(releaseBytes(part), false, 'a view into a larger buffer must not be released');
  assert.equal(part.length, 90);
  assert.equal(big.length, 1024);

  const pooled = Buffer.from('still here'); // a small Buffer is a slice of a shared pool
  assert.equal(releaseBytes(pooled), false);
  assert.equal(pooled.toString(), 'still here');

  const shared = new Uint8Array(64).fill(4);
  const keep = new Uint8Array(shared.buffer);
  assert.equal(releaseBytes(shared, keep), false, 'bytes sharing a buffer with `keep` must not be released');
  assert.equal(keep.length, 64);

  assert.equal(releaseBytes(undefined), false);
});

// ── The raster cap: scale down to fit, or fail cleanly below a usable floor ──

test('an oversized page is scaled down to fit the OCR-specific 25-million-pixel ceiling, not rejected outright', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage([4000, 4000]); // blank; needs force since there is no text layer to object to. At
  // the default 200 DPI this is 77.7 megapixels, over the 25-million cap, scaling down to 90 DPI,
  // comfortably clear of the 72 DPI floor, unlike 5000x5000pt, which lands exactly on it.
  const bytes = await doc.save();
  const result = await ocrDocument(bytes, { force: true });
  assert.equal(result.ok, true);
  assert.equal(result.ocredPages, 1);
  assert.deepEqual(result.failures, []);
});

// ── Embedded-image size cap: a different, earlier failure point than the page-size cap
// above. A page can be an ordinary size while carrying one enormous embedded image, and pdf.js's
// own decode of that image happens before any raster-cap code in this file runs. A one-page,
// ordinary-sized PDF whose only content is a 10000x10000 image peaks at 1.73 GB RSS and takes
// 2.3s inside ocrDocument() itself with no maxImageSize cap; with OCR_MAX_IMAGE_PIXELS set, the
// same call uses about 730 to 750 MB RSS and 260ms. This caps ONE image at a time, not a page's
// total (see the constant's own comment in bundletoolOcr.js): it removes the single-oversized-image
// cliff, it is not a per-page memory bound. pdf.js reports the drop through its own `warn()`
// (static/vendor/pdfjs.worker.mjs), which calls console.log (routed by Node to stdout, not
// stderr), so getDocument({ verbosity: 1 }) plus a console.log capture scoped to each page's own
// render call gives a real per-page signal, tested below.
test('an oversized embedded image gives that specific page a real ocr_failed, not a silent empty success', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const { createCanvas } = await import('@napi-rs/canvas');
  const { PDFDocument } = await import('@cantoo/pdf-lib');

  async function makeHugeImagePdf(side) {
    const canvas = createCanvas(side, side);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, side, side);
    const png = canvas.toBuffer('image/png');
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]); // ordinary US Letter: the page itself is not oversized
    const img = await doc.embedPng(png);
    page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
    return doc.save();
  }

  const bytes = await makeHugeImagePdf(10000); // 100,000,000 pixels: the shape described above
  const result = await ocrDocument(bytes, { force: true });

  // Without the per-page signal this would return ok:true, ocredPages:1, failures:[]: a page
  // silently counted as successfully OCR'd with an empty text layer, because pdf.js drops the
  // oversized image and OCR "succeeds" on whatever is left (nothing).
  assert.equal(result.ok, true); // a per-page failure, not a document-level one
  assert.equal(result.ocredPages, 0, 'a page whose only content was dropped must not count as OCRd');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].page, 1);
  assert.match(result.failures[0].detail, /too large/);
});

test('a legitimate large embedded image, comfortably under the cap, produces the real recognised text', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const { createCanvas } = await import('@napi-rs/canvas');
  const { PDFDocument } = await import('@cantoo/pdf-lib');

  // 9000x9000 = 81,000,000 pixels: comfortably under OCR_MAX_IMAGE_PIXELS (90,000,000), and above
  // what an A3 page at 600 DPI actually needs (7016 x 9921 ~= 69.6 million pixels): the real
  // legitimate ceiling this cap must not reject.
  const canvas = createCanvas(9000, 9000);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 9000, 9000);
  ctx.fillStyle = 'black';
  ctx.textBaseline = 'top';
  ctx.font = '400px "DejaVu Sans"';
  ctx.fillText('LEGITIMATE LARGE SCAN', 200, 200);
  const png = canvas.toBuffer('image/png');
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  const bytes = await doc.save();

  const result = await ocrDocument(bytes, { force: true });
  assert.equal(result.ok, true);
  assert.equal(result.ocredPages, 1);
  assert.deepEqual(result.failures, []);
  assert.ok(result.bytes, 'a legitimate large image must still produce OCR output, not be silently dropped');
  // Not just "the call returned ok": this test is about the OTHER failure mode, a cap so tight
  // that a legitimate image is dropped, so the real text must actually be there.
  const [pageText] = await extractText(result.bytes);
  // Whitespace-tolerant: each recognised word lands as its own text-layer item, joined by
  // extractText() with a single space regardless of the original glyph spacing, so run-length
  // between words is not meaningful here, only that all three words were read correctly.
  assert.match(pageText, /LEGITIMATE\s+LARGE\s+SCAN/i, `expected the recognised text in the output layer, got: ${pageText.slice(0, 200)}`);
});

/** Strips line comments and block comments (not string-aware, but neither of these two source
 * files has a comment-opening sequence inside a string literal near a real getDocument() call).
 * Needed because their header comments mention "getDocument()" several times in prose (e.g. "a
 * canvasFactory MUST be passed to getDocument() itself"), which the brace-matching scan below
 * would otherwise count as real, argument-less call sites. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// A fixed list of known call sites can only prove those sites are safe, not that no new, uncapped
// one exists (the same reasoning as pdfjsEvalMitigation.test.mjs's own header comment). The two
// tests above exercise only the CLI path, so without this scan, removing `maxImageSize` from the
// browser's getDocument() call would leave them green.
test('every OCR getDocument() call, the CLI and the browser both, carries a maxImageSize cap', () => {
  const files = [
    '../scripts/cliOcrDocument.mjs',
    '../public/js/frontend/bundletoolOcrDocument.js',
  ];
  let callsFound = 0;
  for (const rel of files) {
    const abs = fileURLToPath(new URL(rel, import.meta.url));
    const text = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const m of text.matchAll(/getDocument\(/g)) {
      const rest = text.slice(m.index);
      const open = rest.indexOf('(');
      let depth = 0, end = -1;
      for (let i = open; i < rest.length; i++) {
        if (rest[i] === '(') depth++;
        else if (rest[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      assert.ok(end > -1, `${rel}: getDocument( call has no matching close paren`);
      const args = rest.slice(open + 1, end);
      callsFound++;
      assert.match(args, /^\s*\{/, `${rel}: getDocument() is not called with an inline object literal, so this scan cannot verify it: ${args.slice(0, 80)}`);
      assert.match(args, /maxImageSize\s*:/, `${rel}: ${args.slice(0, 160)}`);
    }
  }
  assert.equal(callsFound, 2, 'expected exactly one getDocument() call in each of the two OCR files; the scan itself may be broken, or a new call site needs adding to this list');
});

test('a page too large even at the scaled-down floor fails cleanly as an isolated ocr_failed, with no raw size-driven crash', async () => {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage([15000, 15000]);
  const bytes = await doc.save();
  const result = await ocrDocument(bytes, { force: true });
  assert.equal(result.ok, true); // a per-page failure, not a document-level one
  assert.equal(result.ocredPages, 0);
  assert.equal(result.bytes, null);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].page, 1);
  assert.match(result.failures[0].detail, /too large/);
});

// ── Upfront validation: a bad forceOcr on a later file must not cost earlier files real work ──

test('an invalid forceOcr on the SECOND file is caught before the FIRST file is ever read or OCR\'d', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const d = tmp();
  try {
    const docs = path.join(d, 'docs'); fs.mkdirSync(docs, { recursive: true });
    // file1 would need real OCR work (expensive) if ever reached; file2's bad forceOcr must be
    // caught before that work happens, not discovered only once the batch gets to file2.
    fs.writeFileSync(path.join(docs, 'file1.pdf'), await makeScannedPdf('SHOULD NEVER BE OCRD'));
    fs.writeFileSync(path.join(docs, 'file2.pdf'), await fx.makePdf(1, 'X'));
    const manifest = {
      schemaVersion: 1,
      config: { 'heading.bundleTitle': 'T', 'heading.projectName': 'R', 'heading.claimNumber': 'C' },
      sections: [{ sectionLabel: 'A', sectionName: 'Docs', files: [{ filename: 'file1.pdf' }, { filename: 'file2.pdf', forceOcr: 'not a boolean' }] }],
    };
    const mp = path.join(d, 'm.json');
    fs.writeFileSync(mp, JSON.stringify(manifest));
    const started = Date.now();
    const r = cli(['--json', mp, docs, path.join(d, 'out.pdf')]);
    const elapsedMs = Date.now() - started;
    assert.equal(r.status, 3, r.stderr);
    assert.equal(r.json.error.code, 'invalid_manifest');
    assert.match(r.json.error.message, /file2\.pdf/);
    // A real OCR attempt on file1 (a genuine scanned raster) takes over a second; failing in well
    // under that proves file1's OCR never ran.
    assert.ok(elapsedMs < 1000, `expected a fast, upfront rejection before any OCR, took ${elapsedMs}ms`);
  } finally {
    rm(d);
  }
});

// ── stderr suppression: routine engine chatter must not print once per OCR'd page ──

test('Leptonica\'s routine "Estimating resolution" chatter does not reach stderr', async (t) => {
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const d = tmp();
  try {
    const { docs, mp, out } = await setupOcr(d);
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /Estimating resolution/);
  } finally {
    rm(d);
  }
});

// Reading order: the layer is read back by a real reader from real OCR boxes. Boxes of invented, uniform height
// read back in order where a real scan's boxes may not: a real box is as tall as its letters are, so only real
// OCR boxes test the reading order.
test('the OCR text layer of a real multi-line scan reads back in order in poppler', async (t) => {
  if (spawnSync('pdftotext', ['-v']).error) return t.skip('pdftotext (poppler) is not installed');
  if (!(await haveOcrRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const lines = [
    'The quick brown fox jumps over the lazy dog today', 'Pack my box with five dozen liquor jugs please',
    'How vexingly quick daft zebras jump over there', 'Sphinx of black quartz judge my vow of silence',
    'Waltz bad nymph for quick jigs vex my friend', 'Amazingly few discotheques provide jukeboxes now',
  ];
  const canvas = createCanvas(1700, 2200);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1700, 2200);
  ctx.fillStyle = 'black'; ctx.textBaseline = 'top'; ctx.font = '44px "DejaVu Sans"';
  lines.forEach((text, i) => ctx.fillText(text, 100, 200 + i * 120));
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const src = await PDFDocument.create();
  const img = await src.embedPng(canvas.toBuffer('image/png'));
  src.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 });

  const result = await ocrDocument(new Uint8Array(await src.save()));
  assert.equal(result.ok, true);
  const d = tmp();
  try {
    const file = path.join(d, 'ocr.pdf');
    fs.writeFileSync(file, result.bytes);
    const read = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' }).stdout.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
    const truth = lines.join(' ').toLowerCase().split(' ');
    // Longest common subsequence: how many of the real words come back in the real order.
    const dp = Array.from({ length: truth.length + 1 }, () => new Array(read.length + 1).fill(0));
    for (let i = 0; i < truth.length; i++) for (let j = 0; j < read.length; j++) {
      dp[i + 1][j + 1] = truth[i] === read[j] ? dp[i][j] + 1 : Math.max(dp[i][j + 1], dp[i + 1][j]);
    }
    const inOrder = dp[truth.length][read.length] / truth.length;
    assert.ok(inOrder >= 0.9, `only ${(100 * inOrder).toFixed(0)}% of the words came back in order: ${read.slice(0, 12).join(' ')}`);
  } finally { rm(d); }
});
