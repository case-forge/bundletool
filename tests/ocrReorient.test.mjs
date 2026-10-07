/**
 * The two optional OCR page changes (bundletoolOcrReorient.js): ocr.turnUpright turns a scanned page read on its side
 * upright through its /Rotate, ocr.straighten turns a tilted scanned page level by wrapping its content in a rotation.
 * The decisions and the geometry are checked without an engine; the whole path runs through the command line's
 * ocrDocument (the browser runs the same functions) on scans drawn here, and skips without the OCR runtime. The checks
 * that read word boxes with pdftotext or render with pdftoppm skip without poppler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFDocument, PDFName, PDFArray, PDFRawStream, StandardFonts, degrees, decodePDFRawStream } from '../public/js/bundletoolPdfLib.js';
import {
  planReorient, turnedRotation, hasAnnotations, straightenContent, rasterCentre, reorientSettings, STRAIGHTEN_MAX,
} from '../public/js/bundletoolOcrReorient.js';
import { uprightGeometry, applyAffine, estimateLayout, DESKEW } from '../public/js/bundletoolDeskew.js';
import { loadOcrRuntime } from '../scripts/cliOcrEngine.mjs';
import { LINES, W, H, scanCanvas, scanPdf, addLink } from './ocrScans.mjs';
import { ocrDocument } from '../scripts/cliOcrDocument.mjs';

const ON = { turnUpright: true, straighten: true };

// ── Decisions, without an engine ──────────────────────────────────────────────────────────────────────────

test('with both settings off nothing is planned, whatever the reader measured', () => {
  for (const read of [{ accepted: 90, tilt: 4 }, { accepted: 180, tilt: 0 }, { accepted: 0, tilt: -8 }]) {
    const plan = planReorient(read, reorientSettings(undefined));
    assert.equal(plan.turn, 0);
    assert.equal(plan.tilt, 0);
    assert.equal(plan.notStraightened, false);
  }
  assert.deepEqual(reorientSettings({ turnUpright: 'yes', straighten: 1 }), { turnUpright: false, straighten: false, keepAsScanned: new Set() });
  assert.deepEqual(reorientSettings({ keepAsScanned: [2, 'x', 5] }).keepAsScanned, new Set([2, 5]));
});

test('turning takes only the quarter turn the reader accepted; with turning off it is kept as a sideways note', () => {
  for (const accepted of [90, 180, 270]) {
    assert.equal(planReorient({ accepted, tilt: 0 }, ON).turn, accepted);
    assert.equal(planReorient({ accepted, tilt: 0 }, ON).sideways, 0);
    assert.equal(planReorient({ accepted, tilt: 0 }, { straighten: true }).sideways, accepted);
  }
  assert.equal(planReorient({ accepted: 0, tilt: 0 }, ON).turn, 0);
  assert.equal(planReorient({ accepted: 45, tilt: 0 }, ON).turn, 0, 'never anything but a quarter turn');
});

test('straightening takes a tilt up to STRAIGHTEN_MAX either way, and nothing beyond it', () => {
  assert.equal(STRAIGHTEN_MAX, 10);
  for (const tilt of [0.3, -2, 5, -10, 10]) assert.equal(planReorient({ tilt }, ON).tilt, tilt);
  for (const tilt of [10.01, -14, 20, 44]) assert.equal(planReorient({ tilt }, ON).tilt, 0);
  assert.equal(planReorient({ tilt: 0 }, ON).tilt, 0);
});

test('a page with text of its own is never turned or straightened, and one with annotations is left tilted and reported', () => {
  assert.deepEqual(planReorient({ accepted: 90, tilt: 5 }, ON, { ownText: true }), { turn: 0, tilt: 0, sideways: 0, notStraightened: false });
  const annotated = planReorient({ accepted: 90, tilt: 5 }, ON, { annotated: true });
  assert.equal(annotated.tilt, 0);
  assert.equal(annotated.notStraightened, true);
  assert.equal(annotated.turn, 90, 'turning moves annotations with the page, so it still applies');
  assert.equal(planReorient({ tilt: 30 }, ON, { annotated: true }).notStraightened, false, 'beyond the cap it is not a candidate at all');
});

test('a quarter turn counter-clockwise is a /Rotate that much less, kept in 0..270', () => {
  assert.equal(turnedRotation(0, 270), 90);
  assert.equal(turnedRotation(0, 90), 270);
  assert.equal(turnedRotation(90, 180), 270);
  assert.equal(turnedRotation(270, 270), 0);
  assert.equal(turnedRotation(undefined, 180), 180);
});

// ── Geometry ──────────────────────────────────────────────────────────────────────────────────────────────

/** Rotation by `tilt` degrees counter-clockwise as seen about (cx, cy), in image pixels (y down). */
const turnAbout = (tilt, cx, cy) => (p) => {
  const t = (tilt * Math.PI) / 180;
  const dx = p.x - cx, dy = p.y - cy;
  return { x: cx + dx * Math.cos(t) + dy * Math.sin(t), y: cy - dx * Math.sin(t) + dy * Math.cos(t) };
};

test('toLevel is toRaw followed by the page turned by its tilt about its centre, and leaves no rotation but quarter turns', () => {
  const W = 1700, H = 2200;
  for (const pageTurn of [0, 90, 180, 270]) {
    for (const turn of [0, 90, 180, 270]) {
      for (const tilt of [0, 2, -5, 10, -14]) {
        const g = uprightGeometry(W, H, tilt, turn, 3e6, pageTurn);
        if (!tilt) assert.deepEqual(g.toLevel, g.toRaw, 'no tilt: the same map');
        const level = turnAbout(tilt, W / 2, H / 2);
        for (const p of [{ x: 0, y: 0 }, { x: g.width, y: 0 }, { x: 137, y: 911 }, { x: g.width / 2, y: g.height }]) {
          const want = level(applyAffine(g.toRaw, p.x, p.y));
          const got = applyAffine(g.toLevel, p.x, p.y);
          assert.ok(Math.hypot(want.x - got.x, want.y - got.y) < 1e-6, `pageTurn ${pageTurn} turn ${turn} tilt ${tilt}`);
        }
        const [a, b, c, d] = g.toLevel;
        assert.ok([a, b, c, d].every((v) => v === 0 || Math.abs(Math.abs(v) - Math.abs(g.toLevel[0] || g.toLevel[1])) < 1e-12),
          `only a scaled quarter turn: ${g.toLevel.slice(0, 4)}`);
      }
    }
  }
});

/** The content streams of a page, decoded, in order. */
function contents(doc, page) {
  const c = page.node.Contents();
  const refs = c instanceof PDFArray ? c.asArray() : [page.node.get(PDFName.of('Contents'))];
  return refs.map((r) => {
    const s = doc.context.lookup(r);
    return new TextDecoder().decode(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getUnencodedContents());
  });
}

test('straightenContent wraps the page\'s own content in a rotation about the centre, and what is drawn next stays outside it', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  page.drawRectangle({ x: 100, y: 100, width: 50, height: 50 });
  const saved = await PDFDocument.load(await doc.save());
  const p = saved.getPage(0);
  const own = contents(saved, p);
  assert.equal(straightenContent(p, 5, { x: 300, y: 400 }), true);
  p.drawText('after', { x: 10, y: 10, size: 12, font: await saved.embedFont(StandardFonts.Helvetica) });
  const out = contents(saved, p);
  const t = (5 * Math.PI) / 180;
  const [cos, sin] = [Math.cos(t), Math.sin(t)];
  const first = out[0].trim().split(/\s+/);
  assert.equal(first[0], 'q');
  assert.equal(first[7], 'cm');
  const m = first.slice(1, 7).map(Number);
  for (const [i, v] of [cos, sin, -sin, cos, 300 - cos * 300 + sin * 400, 400 - sin * 300 - cos * 400].entries()) {
    assert.ok(Math.abs(m[i] - v) < 1e-4, `cm[${i}] ${m[i]} vs ${v}`);
  }
  // The rotation's centre stays where it is.
  assert.ok(Math.abs(m[0] * 300 + m[2] * 400 + m[4] - 300) < 1e-3 && Math.abs(m[1] * 300 + m[3] * 400 + m[5] - 400) < 1e-3);
  assert.ok(out.some((s) => s === own[0]), 'the page\'s own stream is untouched');
  const closing = out.findIndex((s) => s.trim() === 'Q' && out.indexOf(s) > out.indexOf(own[0]));
  const text = out.findIndex((s) => s.includes('Tj'));
  assert.ok(out.indexOf(own[0]) > 0 && closing > out.indexOf(own[0]) && text > closing, `order: ${out.map((s) => s.slice(0, 20)).join(' | ')}`);
  assert.deepEqual(p.getSize(), { width: 600, height: 800 }, 'the page keeps its size');
});

test('the rotation centre is the centre of the raster on the page, inside the visible box', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  assert.deepEqual(rasterCentre(page, { width: 1700, height: 2200 }, 200), { x: 306, y: 396 });
  page.setMediaBox(10, 20, 612, 792);
  page.setCropBox(30, 20, 500, 700);
  const c = rasterCentre(page, { width: 500 * 200 / 72, height: 700 * 200 / 72 }, 200);
  assert.ok(Math.abs(c.x - 280) < 1e-9 && Math.abs(c.y - 370) < 1e-9, JSON.stringify(c));
});

test('hasAnnotations sees a link and an empty page has none', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  assert.equal(hasAnnotations(page), false);
  addLink(doc, page);
  assert.equal(hasAnnotations(page), true);
});

// ── The whole path, with the engine ───────────────────────────────────────────────────────────────────────

let RUNTIME = null;
const haveRuntime = async () => (RUNTIME ??= (await loadOcrRuntime()).available);
const havePoppler = () => !spawnSync('pdftotext', ['-v']).error && !spawnSync('pdftoppm', ['-v']).error;

async function pageOf(bytes) {
  const doc = await PDFDocument.load(bytes);
  return { doc, page: doc.getPage(0) };
}

/** pdf.js's text items on page 1: text, start (PDF points, the page's own unrotated space) and direction. */
async function items(bytes) {
  const pdfjsLib = await import('/vendor/pdfjs.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice(), isEvalSupported: false, enableXfa: false, verbosity: 0 });
  const doc = await task.promise;
  const content = await (await doc.getPage(1)).getTextContent();
  await task.destroy();
  return content.items.filter((it) => it.str.trim()).map((it) => {
    const [a, b, , , x, y] = it.transform;
    return { text: it.str.trim(), x, y, angle: (Math.atan2(b, a) * 180) / Math.PI };
  });
}

/** Share of the true words found in the text layer, in any order. */
function wordsFound(list) {
  const got = new Map();
  for (const w of list.flatMap((i) => i.text.toLowerCase().split(/\s+/))) got.set(w, (got.get(w) ?? 0) + 1);
  const truth = LINES.join(' ').toLowerCase().split(/\s+/);
  let found = 0;
  for (const w of truth) if ((got.get(w) ?? 0) > 0) { found++; got.set(w, got.get(w) - 1); }
  return found / truth.length;
}

/** pdftotext -bbox's words on page 1, in points from the top left of the page as displayed. */
function bboxWords(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btreorient-'));
  try {
    const file = path.join(dir, 'p.pdf');
    fs.writeFileSync(file, bytes);
    const html = execFileSync('pdftotext', ['-bbox', file, '-']).toString();
    return [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: m[5].toLowerCase() }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The page rendered by poppler, as the measured layout of its print (bundletoolDeskew.js). */
async function renderedLayout(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btreorient-'));
  try {
    const file = path.join(dir, 'p.pdf');
    fs.writeFileSync(file, bytes);
    execFileSync('pdftoppm', ['-r', '60', '-png', '-singlefile', file, path.join(dir, 'r')]);
    const img = await loadImage(fs.readFileSync(path.join(dir, 'r.png')));
    const c = createCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
    const { data } = c.getContext('2d').getImageData(0, 0, img.width, img.height);
    return estimateLayout(data, img.width, img.height, { factor: 1 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The words that appear exactly once in both lists, paired. */
function pairs(a, b) {
  const once = (list) => {
    const m = new Map();
    for (const w of list) m.set(w.text, m.has(w.text) ? null : w);
    return m;
  };
  const ma = once(a), mb = once(b);
  return [...ma].filter(([k, v]) => v && mb.get(k)).map(([k, v]) => [v, mb.get(k)]);
}

test('with both settings off the output is byte for byte what the reader gives without them, and the pages are not changed', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  for (const [name, bytes] of [
    ['level', await scanPdf(scanCanvas())],
    ['tilted 5 degrees', await scanPdf(scanCanvas({ tilt: 5 }))],
    ['on its side', await scanPdf(scanCanvas({ turn: 90 }))],
    ['stored turned, /Rotate set', await scanPdf(scanCanvas({ turn: 270 }), { rotate: 270 })],
  ]) {
    const plain = await ocrDocument(bytes.slice(), { force: true });
    const off = await ocrDocument(bytes.slice(), { force: true, reorient: { turnUpright: false, straighten: false } });
    assert.equal(off.ok, true, name);
    assert.ok(off.bytes, `${name}: read`);
    assert.ok(Buffer.from(off.bytes).equals(Buffer.from(plain.bytes)), `${name}: byte for byte`);
    assert.deepEqual(off.reoriented.turned, []);
    assert.deepEqual(off.reoriented.straightened, []);
    const before = await pageOf(bytes);
    const after = await pageOf(off.bytes);
    assert.equal(after.page.getRotation().angle, before.page.getRotation().angle, `${name}: /Rotate as it was`);
    const own = contents(before.doc, before.page);
    const now = contents(after.doc, after.page);
    assert.ok(own.every((s) => now.includes(s)), `${name}: the page's own content is untouched`);
    assert.ok(!now.some((s) => /\bcm\b/.test(s) && !own.includes(s) && !s.includes('BT')), `${name}: no rotation added round the content`);
  }
});

for (const turn of [90, 180, 270]) {
  test(`turnUpright: a page stored ${turn === 180 ? 'upside down' : 'on its side'} (${turn}) gets /Rotate ${turn}, and its text layer reads upright with it`, async (t) => {
    if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
    const bytes = await scanPdf(scanCanvas({ turn }));
    const r = await ocrDocument(bytes, { force: true, reorient: { turnUpright: true } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reoriented.turned, [[1, (360 - turn) % 360]]);
    const { page } = await pageOf(r.bytes);
    assert.equal(page.getRotation().angle, turn, 'shown upright');
    // The layer is in the page's own space, turned with the print; shown with the new /Rotate it runs level.
    const list = await items(r.bytes);
    assert.ok(wordsFound(list) >= 0.9, `only ${wordsFound(list)} of the words`);
    for (const it of list) {
      const shown = ((it.angle - turn) % 360 + 540) % 360 - 180;
      assert.ok(Math.abs(shown) < 1.5, `"${it.text}" runs at ${shown.toFixed(1)} as shown`);
    }
    if (havePoppler()) {
      // As displayed, the words lie on lines across the page, top to bottom in the printed order.
      const words = bboxWords(r.bytes);
      const firsts = ['court', 'parties', 'directions', 'comply', 'application', 'respondent']
        .map((w) => words.find((b) => b.text === w)).filter(Boolean);
      assert.ok(firsts.length >= 5, 'the lines are found');
      for (let i = 1; i < firsts.length; i++) assert.ok(firsts[i].y0 > firsts[i - 1].y0, 'each line below the one before');
      const layout = await renderedLayout(r.bytes);
      assert.equal(layout.axis, 'rows', 'rendered, its lines run across the page');
    }
  });
}

test('turnUpright: a page already shown upright by its own /Rotate is not turned again', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  for (const rotate of [90, 270]) {
    const r = await ocrDocument(await scanPdf(scanCanvas({ turn: rotate }), { rotate }), { force: true, reorient: ON });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reoriented.turned, []);
    assert.equal((await pageOf(r.bytes)).page.getRotation().angle, rotate);
  }
});

test('neither setting touches a born-digital page, even one whose text runs sideways and is read by Force OCR', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  LINES.forEach((line, i) => page.drawText(line, { x: 200 + i * 30, y: 150, size: 14, font, rotate: degrees(85) }));
  const bytes = await doc.save();
  const r = await ocrDocument(bytes, { force: true, reorient: ON });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reoriented, { turned: [], straightened: [], notStraightened: [], sideways: [] });
  if (r.bytes) {
    const after = await pageOf(r.bytes);
    assert.equal(after.page.getRotation().angle, 0);
    const own = contents((await pageOf(bytes)).doc, (await pageOf(bytes)).page);
    assert.ok(own.every((s) => contents(after.doc, after.page).includes(s)));
  }
});

/** A blank page with a few specks, a photograph-like page of soft blobs, and a ruled grid. */
function otherPages() {
  const blank = createCanvas(W, H);
  let ctx = blank.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#333';
  for (const [x, y] of [[300, 400], [1200, 900], [800, 1800], [1500, 300]]) ctx.fillRect(x, y, 3, 3);
  const photo = createCanvas(W, H);
  ctx = photo.getContext('2d');
  ctx.fillStyle = '#c8bca8'; ctx.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 60; i++) {
    const g = ctx.createRadialGradient(rnd() * W, rnd() * H, 0, rnd() * W, rnd() * H, 100 + rnd() * 400);
    g.addColorStop(0, `rgba(${Math.floor(rnd() * 120)},${Math.floor(rnd() * 120)},${Math.floor(rnd() * 120)},0.8)`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  const grid = createCanvas(W, H);
  ctx = grid.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'black'; ctx.lineWidth = 3;
  for (let x = 150; x <= W - 150; x += 140) { ctx.beginPath(); ctx.moveTo(x, 150); ctx.lineTo(x, H - 150); ctx.stroke(); }
  for (let y = 150; y <= H - 150; y += 140) { ctx.beginPath(); ctx.moveTo(150, y); ctx.lineTo(W - 150, y); ctx.stroke(); }
  return { blank, photo, grid };
}

test('a blank page, a photograph and a ruled grid are neither turned nor straightened', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  for (const [name, canvas] of Object.entries(otherPages())) {
    const bytes = await scanPdf(canvas);
    const r = await ocrDocument(bytes, { force: true, reorient: ON });
    assert.equal(r.ok, true, name);
    assert.deepEqual(r.reoriented.turned, [], name);
    assert.deepEqual(r.reoriented.straightened, [], name);
    if (r.bytes) {
      const after = await pageOf(r.bytes);
      assert.equal(after.page.getRotation().angle, 0, name);
      assert.ok(!contents(after.doc, after.page).some((s) => /^\s*q\s[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ cm\s*$/.test(s)), `${name}: no rotation`);
    }
  }
});

for (const tilt of [2, 5, 10]) {
  test(`straighten: a page scanned ${tilt} degrees off level is turned level, and its text layer lies on the level print`, async (t) => {
    if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
    const level = await ocrDocument(await scanPdf(scanCanvas()), { force: true, reorient: { straighten: true } });
    const r = await ocrDocument(await scanPdf(scanCanvas({ tilt })), { force: true, reorient: { straighten: true } });
    assert.equal(r.ok, true);
    assert.equal(r.reoriented.straightened.length, 1);
    const [[pageNo, applied]] = r.reoriented.straightened;
    assert.equal(pageNo, 1);
    assert.ok(Math.abs(applied - tilt) < 0.3, `straightened by ${applied}, scanned ${tilt} off`);
    assert.deepEqual(level.reoriented.straightened, [], 'the level page is left alone');
    const { page } = await pageOf(r.bytes);
    assert.deepEqual(page.getSize(), { width: 612, height: 792 }, 'the page keeps its size');

    // The text layer runs level and starts where the level print's own layer does (pdf.js, the page's own space).
    const got = await items(r.bytes);
    const want = await items(level.bytes);
    assert.ok(wordsFound(got) >= 0.9, `only ${wordsFound(got)} of the words`);
    for (const it of got) assert.ok(Math.abs(it.angle) < 0.5, `"${it.text}" runs at ${it.angle.toFixed(2)}`);
    const firstWord = (list) => list.map((i) => ({ ...i, text: i.text.split(/\s+/)[0].toLowerCase() }));
    const matched = pairs(firstWord(got), firstWord(want));
    assert.ok(matched.length >= 4, `${matched.length} lines matched`);
    for (const [a, b] of matched) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 3, `"${a.text}" at ${a.x.toFixed(1)},${a.y.toFixed(1)}, level print ${b.x.toFixed(1)},${b.y.toFixed(1)}`);

    if (havePoppler()) {
      // Word boxes as a reader sees them, against the level print's, and the rendered page measured level.
      const boxes = pairs(bboxWords(r.bytes), bboxWords(level.bytes));
      assert.ok(boxes.length >= 20, `${boxes.length} words matched`);
      for (const [a, b] of boxes) {
        const d = Math.hypot((a.x0 + a.x1 - b.x0 - b.x1) / 2, (a.y0 + a.y1 - b.y0 - b.y1) / 2);
        assert.ok(d < 3, `"${a.text}" is ${d.toFixed(2)} pt from the level print's`);
        assert.ok(Math.abs((a.y1 - a.y0) - (b.y1 - b.y0)) < 2, `"${a.text}" is as tall as the level print's`);
      }
      const layout = await renderedLayout(r.bytes);
      assert.ok(layout.confident && layout.axis === 'rows', 'rendered, the lines are measured');
      assert.ok(Math.abs(layout.tilt) < DESKEW.APPLY_MIN, `rendered, the page is ${layout.tilt} degrees off level`);
    }
  });
}

test('straighten: a page tilted more than STRAIGHTEN_MAX is left as it is', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  for (const tilt of [14, 20]) {
    const r = await ocrDocument(await scanPdf(scanCanvas({ tilt })), { force: true, reorient: ON });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reoriented.straightened, [], `${tilt}`);
    assert.deepEqual(r.reoriented.notStraightened, []);
    const after = await pageOf(r.bytes);
    assert.ok(!contents(after.doc, after.page).some((s) => /^\s*q\s[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ cm\s*$/.test(s)), `${tilt}`);
  }
});

test('straighten: a tilted page with a link is left tilted and reported, and still gets its text layer', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const r = await ocrDocument(await scanPdf(scanCanvas({ tilt: 5 }), { link: true }), { force: true, reorient: ON });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reoriented.straightened, []);
  assert.deepEqual(r.reoriented.notStraightened, [1]);
  assert.ok(wordsFound(await items(r.bytes)) >= 0.9, 'read as usual');
});

test('reading a straightened page again neither straightens it twice nor leaves two text layers', async (t) => {
  if (!(await haveRuntime())) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const once = await ocrDocument(await scanPdf(scanCanvas({ tilt: 5 })), { force: true, reorient: ON });
  assert.equal(once.ok, true, JSON.stringify({ ...once, bytes: undefined }));
  assert.deepEqual(once.reoriented.straightened.map(([page]) => page), [1]);
  const twice = await ocrDocument(new Uint8Array(once.bytes), { force: true, reorient: ON });
  assert.equal(twice.ok, true, JSON.stringify({ ...twice, bytes: undefined }));
  assert.deepEqual(twice.reoriented.straightened, []);
  const a = await items(once.bytes), b = await items(twice.bytes);
  assert.ok(Math.abs(a.length - b.length) <= 2, `${a.length} items once, ${b.length} read again`);
});
