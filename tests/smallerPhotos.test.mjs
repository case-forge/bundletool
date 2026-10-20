/**
 * Smaller photos (pageOptions.smallerPhotos, on by default). The re-encoding itself (bundletoolSmallerPhotos.js):
 * only a page's one picture, at most 2000 pixels on its long edge, JPEG at quality 85, never enlarged, never a
 * picture already within the size, PNG kept lossless when a JPEG would not be smaller, the page and its text layer
 * untouched. The build's side (frontend/smallerPhotos.js): only documents BundleTool converted from pictures, never a
 * PDF, on and off, made once per held file. And the setting travelling everywhere settings go, the command line
 * included. The pixel work runs on @napi-rs/canvas here (the command line's codec); without it those tests skip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from './fixtures.mjs';
import { PDFDocument, PDFName, PDFRawStream, PDFDict, StandardFonts } from '../public/js/bundletoolPdfLib.js';
import { smallerPicturePdf, smallerSize, withoutExif, SMALLER_PHOTO_EDGE, SMALLER_PHOTO_QUALITY } from '../public/js/bundletoolSmallerPhotos.js';
import { imagesToPdf } from '../public/js/bundletoolPages.js';
import { photoToPdf } from '../public/js/bundletoolPhotoPdf.js';
import { loadNodeCodec } from '../scripts/cliSmallerPhotos.mjs';
import Config from '../public/js/bundletoolConfig.js';
import { flattenConfig, setMetadata } from '../public/js/bundletoolMeta.js';
import { openBundle } from '../public/js/bundletoolRestore.js';
import { sanitiseConfig, sanitiseNestedConfig, DEFAULTS_KEYS } from '../public/js/frontend/configSanitise.js';
import { encodeSettingsCode, decodeSettingsCode } from '../public/js/frontend/settingsCode.js';
import { flattenManifestConfig, nestManifestConfig } from '../public/js/manifestSchema.js';
import { state } from '../public/js/frontend/state.js';
import { filesForBundle } from '../public/js/frontend/smallerPhotos.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');
const codec = await loadNodeCodec();
const canvasLib = codec ? await import('@napi-rs/canvas') : null;
const needsCanvas = (t) => { if (!codec) { t.skip('@napi-rs/canvas is not available on this machine'); return true; } return false; };

/** A photo-like picture: light paper, lines of dark "text", a shadow, and grain, as a phone camera's JPEG. */
async function photoJpeg(width, height, { quality = 92, seed = 7 } = {}) {
  const c = canvasLib.createCanvas(width, height);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, '#f2efe6'); g.addColorStop(1, '#bdb8aa');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#222';
  ctx.font = `${Math.round(height / 60)}px sans-serif`;
  for (let y = height / 10; y < height * 0.9; y += height / 40) ctx.fillText('The school will close at 2.45pm on Thursday 17 July 2025.', width / 12, y);
  const img = ctx.getImageData(0, 0, width, height);
  const rand = fx.mulberry32(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 18;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  return new Uint8Array(await c.encode('jpeg', quality));
}

/** The one image a page draws: its resource name, dictionary and bytes. */
function pageImage(doc, page) {
  const xo = page.node.Resources().lookup(PDFName.of('XObject'), PDFDict);
  const [[name, ref]] = [...xo.entries()].filter(([, r]) => doc.context.lookup(r) instanceof PDFRawStream && doc.context.lookup(r).dict.get(PDFName.of('Subtype'))?.toString() === '/Image');
  const stream = doc.context.lookup(ref);
  const num = (k) => stream.dict.lookup(PDFName.of(k))?.asNumber?.();
  return { name: name.toString(), width: num('Width'), height: num('Height'), filter: stream.dict.lookup(PDFName.of('Filter'))?.toString(), smask: stream.dict.has(PDFName.of('SMask')), bytes: stream.contents };
}

/** The page's content streams, as bytes: what draws the picture and the text layer. */
function contents(doc, page) {
  const c = page.node.Contents();
  const streams = c instanceof PDFRawStream ? [c] : c.asArray().map((r) => doc.context.lookup(r));
  return streams.map((s) => Buffer.from(s.contents).toString('latin1')).join('\n--\n');
}

/** The luminance quantisation table of a JPEG, in the file's own (zigzag) order. */
function lumaTable(jpeg) {
  for (let i = 2; i + 4 < jpeg.length;) {
    const marker = jpeg[i + 1];
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (marker === 0xdb) {
      for (let p = i + 4; p < i + 2 + len;) {
        const pq = jpeg[p] >> 4, tq = jpeg[p] & 15;
        const table = [...jpeg.subarray(p + 1, p + 1 + (pq ? 128 : 64))];
        if (tq === 0) return table;
        p += 1 + (pq ? 128 : 64);
      }
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return null;
}
/** The standard (IJG) luminance table scaled to `quality`, in zigzag order: what an encoder at that quality writes. */
function ijgLuma(quality) {
  const base = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
  const zigzag = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  return zigzag.map((n) => Math.min(255, Math.max(1, Math.floor((base[n] * scale + 50) / 100))));
}

// ── The sizes ────────────────────────────────────────────────────────────────────────────────────────────

test('at most 2000 pixels on the long edge, the shape kept, never enlarged', () => {
  assert.equal(SMALLER_PHOTO_EDGE, 2000);
  assert.equal(SMALLER_PHOTO_QUALITY, 0.85);
  assert.deepEqual(smallerSize(4032, 3024), { width: 2000, height: 1500 });
  assert.deepEqual(smallerSize(3024, 4032), { width: 1500, height: 2000 });
  assert.deepEqual(smallerSize(4000, 1), { width: 2000, height: 1 });
  assert.equal(smallerSize(2000, 1500), null, 'already within the size');
  assert.equal(smallerSize(1200, 900), null, 'never enlarged');
});

test('a JPEG\'s EXIF block is taken off before decoding, and nothing else', () => {
  const app = (marker, body) => [0xff, marker, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body];
  const exif = app(0xe1, [...Buffer.from('Exif\0\0'), 1, 2, 3, 4]);
  const jfif = app(0xe0, [...Buffer.from('JFIF\0'), 1, 1]);
  const xmp = app(0xe1, [...Buffer.from('http://ns.adobe.com/xap/1.0/\0'), 9]);
  const rest = [0xff, 0xda, 0, 2, 0x55, 0x66, 0xff, 0xd9];
  const jpeg = new Uint8Array([0xff, 0xd8, ...jfif, ...exif, ...xmp, ...rest]);
  assert.deepEqual([...withoutExif(jpeg)], [0xff, 0xd8, ...jfif, ...xmp, ...rest]);
  const none = new Uint8Array([0xff, 0xd8, ...jfif, ...rest]);
  assert.equal(withoutExif(none), none, 'no EXIF: the same bytes');
  const junk = new Uint8Array([1, 2, 3]);
  assert.equal(withoutExif(junk), junk, 'not a JPEG: the same bytes');
});

// ── The re-encoding ──────────────────────────────────────────────────────────────────────────────────────

test('a phone photo becomes a 2000 pixel JPEG at quality 85 in the same place, with the page and its text layer unchanged', async (t) => {
  if (needsCanvas(t)) return;
  const jpeg = await photoJpeg(4032, 3024);
  const pdf = await imagesToPdf([{ bytes: jpeg, kind: 'jpeg' }], 'a4');
  // A text layer over it, as OCR draws one, so it can be seen to stay as it was.
  const withText = await PDFDocument.load(pdf);
  const font = await withText.embedFont(StandardFonts.Helvetica);
  withText.getPage(0).drawText('school will close', { x: 100, y: 500, size: 12, font, opacity: 0 });
  const before = await withText.save();

  const { bytes, pictures } = await smallerPicturePdf(before, codec);
  assert.notEqual(bytes, before);
  const [a, b] = [await PDFDocument.load(before), await PDFDocument.load(bytes)];
  const [pa, pb] = [a.getPage(0), b.getPage(0)];
  const [ia, ib] = [pageImage(a, pa), pageImage(b, pb)];
  assert.deepEqual([ia.width, ia.height], [4032, 3024]);
  assert.deepEqual([ib.width, ib.height], [2000, 1500]);
  assert.equal(ib.filter, '/DCTDecode');
  assert.equal(ib.name, ia.name, 'the same image name, so the page still draws it');
  assert.deepEqual(lumaTable(ib.bytes), ijgLuma(85), 'JPEG quality 85');
  assert.ok(ib.bytes.length < ia.bytes.length / 2, `${ib.bytes.length} against ${ia.bytes.length}`);
  assert.deepEqual(pb.getMediaBox(), pa.getMediaBox(), 'the page keeps its size');
  assert.equal(contents(b, pb), contents(a, pa), 'the picture is drawn into the same rectangle and the text layer is untouched');
  assert.deepEqual(pictures, [{ page: 1, kind: 'jpeg', from: [4032, 3024], to: [2000, 1500], before: ia.bytes.length, after: ib.bytes.length, as: 'jpeg' }]);
});

test('a photo with an EXIF turn, as the command line draws it, keeps its turn: the stored pixels are made smaller as stored', async (t) => {
  if (needsCanvas(t)) return;
  const stored = await photoJpeg(4000, 3000);
  // EXIF orientation 6 (a portrait shot stored landscape) put into the JPEG after its SOI.
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
  const body = [...Buffer.from('Exif\0\0'), ...tiff];
  const app1 = [0xff, 0xe1, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body];
  const jpeg = new Uint8Array([0xff, 0xd8, ...app1, ...stored.subarray(2)]);
  const pdf = await photoToPdf(jpeg, 'a4');
  const { bytes } = await smallerPicturePdf(pdf, codec);
  const [a, b] = [await PDFDocument.load(pdf), await PDFDocument.load(bytes)];
  const ib = pageImage(b, b.getPage(0));
  assert.deepEqual([ib.width, ib.height], [2000, 1500], 'the stored (landscape) pixels, halved');
  assert.equal(contents(b, b.getPage(0)), contents(a, a.getPage(0)), 'the turn in the page content is the same');
  const pa = a.getPage(0).getSize();
  assert.ok(pa.height > pa.width, 'and it still stands upright on the page');
});

test('a picture already within 2000 pixels, and a page with two pictures, are left exactly as they are', async (t) => {
  if (needsCanvas(t)) return;
  const small = await imagesToPdf([{ bytes: await photoJpeg(1600, 1200), kind: 'jpeg' }], 'a4');
  const r = await smallerPicturePdf(small, codec);
  assert.equal(r.bytes, small, 'the same bytes, not even saved again');
  assert.equal(r.pictures[0].as, null);

  const doc = await PDFDocument.create();
  const page = doc.addPage();
  for (const [x, seed] of [[0, 1], [300, 2]]) page.drawImage(await doc.embedJpg(await photoJpeg(3000, 2000, { seed })), { x, y: 0, width: 300, height: 200 });
  const two = await doc.save();
  assert.equal((await smallerPicturePdf(two, codec)).bytes, two, 'not the shape BundleTool makes: left alone');
});

/** A PNG drawn on the canvas, made into a page as the browser makes one. */
async function pngPage(width, height, draw) {
  const c = canvasLib.createCanvas(width, height);
  draw(c.getContext('2d'));
  return imagesToPdf([{ bytes: new Uint8Array(await c.encode('png')), kind: 'png' }], 'a4');
}

test('a PNG becomes the smaller of a JPEG and lossless at 2000 pixels, and one that would grow either way is left as it is', async (t) => {
  if (needsCanvas(t)) return;
  const noisy = await imagesToPdf([{ bytes: fx.makeNoisePng(2600, 1800, 3), kind: 'png' }], 'a4');
  const n = await smallerPicturePdf(noisy, codec);
  assert.equal(n.pictures[0].as, 'jpeg', 'a photo kept as PNG: a JPEG');
  assert.ok(n.pictures[0].after < n.pictures[0].before / 4);

  const diagram = await pngPage(3000, 2000, (ctx) => {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 3000, 2000);
    ctx.lineWidth = 3;
    for (let i = 0; i < 40; i++) ctx.strokeRect(100 + (i % 8) * 350, 100 + Math.floor(i / 8) * 350, 300, 250);
  });
  const d = await smallerPicturePdf(diagram, codec);
  assert.equal(d.pictures[0].as, 'png', 'line art: lossless, smaller');
  const out = await PDFDocument.load(d.bytes);
  const img = pageImage(out, out.getPage(0));
  assert.equal(img.filter, '/FlateDecode');
  assert.deepEqual([img.width, img.height], [2000, 1333]);
  assert.ok(d.pictures[0].after < d.pictures[0].before);

  // A phone screenshot of messages: crisp text on flat colour, which both a JPEG and the smaller lossless picture
  // make larger than the page's own, so it stays exactly as it is. The text is drawn as glyph-like strokes, not with
  // a font, so the picture is the same on a machine with no fonts installed.
  const rand = fx.mulberry32(1);
  const chat = await pngPage(1290, 2796, (ctx) => {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1290, 2796);
    for (let y = 200, i = 0; y < 2596; y += 190, i++) {
      const x0 = i % 2 ? 40 : 400;
      ctx.fillStyle = i % 2 ? '#e9e9eb' : '#34c759';
      ctx.fillRect(x0, y, 850, 150);
      ctx.fillStyle = i % 2 ? '#000' : '#fff';
      for (const ly of [y + 30, y + 85]) {
        for (let x = x0 + 40; x < x0 + 800;) {
          const w = 14 + Math.floor(rand() * 12);
          ctx.fillRect(x, ly, 3, 34);
          if (rand() < 0.6) ctx.fillRect(x, ly + (rand() < 0.5 ? 0 : 31), w, 3);
          if (rand() < 0.5) ctx.fillRect(x + w - 3, ly + 10, 3, 24);
          if (rand() < 0.3) ctx.fillRect(x, ly + 16, w, 3);
          x += w + 6 + (rand() < 0.2 ? 18 : 0);
        }
      }
    }
  });
  const s = await smallerPicturePdf(chat, codec);
  assert.equal(s.pictures[0].as, null);
  assert.equal(s.bytes, chat, 'never larger: left exactly as it was');
});

test('a PNG with transparency is drawn over white, and its soft mask goes with it', async (t) => {
  if (needsCanvas(t)) return;
  const c = canvasLib.createCanvas(2400, 1600);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(2400, 1600);
  const rand = fx.mulberry32(5);
  for (let i = 0; i < img.data.length; i += 4) { img.data[i] = rand() * 255; img.data[i + 1] = rand() * 255; img.data[i + 2] = rand() * 255; img.data[i + 3] = i < img.data.length / 2 ? 0 : 255; }
  ctx.putImageData(img, 0, 0);
  const pdf = await imagesToPdf([{ bytes: new Uint8Array(await c.encode('png')), kind: 'png' }], 'a4');
  assert.equal(pageImage(await PDFDocument.load(pdf), (await PDFDocument.load(pdf)).getPage(0)).smask, true);
  const { bytes } = await smallerPicturePdf(pdf, codec);
  const out = await PDFDocument.load(bytes);
  const i2 = pageImage(out, out.getPage(0));
  assert.equal(i2.smask, false);
  const decoded = await canvasLib.loadImage(Buffer.from(i2.bytes));
  const probe = canvasLib.createCanvas(decoded.width, decoded.height).getContext('2d');
  probe.drawImage(decoded, 0, 0);
  const [r, g, b] = probe.getImageData(1000, 100, 1, 1).data;
  assert.ok(r > 235 && g > 235 && b > 235, `the transparent half is white: ${r},${g},${b}`);
});

// ── The build: only converted pictures, on and off ───────────────────────────────────────────────────────

test('a bundle gets smaller copies of the documents made from pictures only; PDFs, and everything when off, go in untouched', async () => {
  for (const k of Object.keys(state.frontendInputData)) delete state.frontendInputData[k];
  const photo = new File([new Uint8Array([1])], 'photo.pdf', { type: 'application/pdf' });
  const pdf = new File([new Uint8Array([2])], 'scan.pdf', { type: 'application/pdf' });
  const docx = new File([new Uint8Array([3])], 'letter.pdf', { type: 'application/pdf' });
  state.frontendInputData['photo.pdf'] = { convertedFromImage: true };
  state.frontendInputData['scan.pdf'] = {};
  state.frontendInputData['letter.pdf'] = { convertedFromDocx: true };
  const files = new Map([['scan.pdf', pdf], ['photo.pdf', photo], ['letter.pdf', docx]]);
  const seen = [];
  const shrink = async (bytes) => { seen.push([...bytes]); return { bytes: new Uint8Array([9, 9]) }; };
  const labels = [];

  assert.equal(await filesForBundle(files, { on: false, shrink }), files, 'off: the documents exactly as held');
  const on = await filesForBundle(files, { on: true, shrink, onProgress: (l) => labels.push(l) });
  assert.deepEqual([...on.keys()], ['scan.pdf', 'photo.pdf', 'letter.pdf'], 'in the same order');
  assert.equal(on.get('scan.pdf'), pdf, 'a PDF the person added is never touched');
  assert.equal(on.get('letter.pdf'), docx, 'nor a converted Word document');
  assert.deepEqual([...new Uint8Array(await on.get('photo.pdf').arrayBuffer())], [9, 9]);
  assert.equal(files.get('photo.pdf'), photo, 'the held document keeps its full picture');
  assert.deepEqual(seen, [[1]]);
  assert.deepEqual(labels, ['Making photos smaller (1 of 1)…']);
  await filesForBundle(files, { on: true, shrink });
  assert.equal(seen.length, 1, 'built again: the copy is reused, not made again');

  const failing = new File([new Uint8Array([4])], 'photo.pdf');
  const broken = await filesForBundle(new Map([['photo.pdf', failing]]), { on: true, shrink: async () => { throw new Error('no'); } });
  assert.equal(broken.get('photo.pdf'), failing, 'a copy that fails: the document goes in as it is');
  for (const k of Object.keys(state.frontendInputData)) delete state.frontendInputData[k];
});

test('Create Bundle builds from those copies, with the setting read from the form', () => {
  const code = read('public/js/frontend/bundleGeneration.js');
  assert.match(code, /filesForBundle\(state\.filesMap, \{ on: configOptions\.pageOptions\.smallerPhotos, onProgress \}\)\s*\.then\(\(files\) => state\.processTheBundle\(files,/);
  assert.match(code, /smallerPhotos: +document\.getElementById\('config-smallerPhotos'\)\?\.checked \?\? true/);
});

// ── The setting, everywhere settings go ──────────────────────────────────────────────────────────────────

test('the setting defaults to true, is checked like every other setting, and travels in the flattened config', () => {
  const config = new Config();
  assert.equal(config.getOption('pageOptions.smallerPhotos'), true);
  config.validateStructure();
  config.validateOptions();
  assert.equal(flattenConfig(config)['pageOptions.smallerPhotos'], true);
  const bad = new Config();
  bad.updateOptions({ pageOptions: { smallerPhotos: 'yes' } });
  assert.throws(() => bad.validateOptions(), /smaller photos/);
  const off = new Config();
  off.updateOptions({ pageOptions: { smallerPhotos: false } });
  off.validateOptions();
  assert.equal(flattenConfig(off)['pageOptions.smallerPhotos'], false);
});

test('Advanced Settings has the switch, on by default, with help saying it applies only to pictures BundleTool converted', () => {
  const html = read('layouts/partials/bundletool.html');
  const input = html.match(/<input[^>]*id="config-smallerPhotos"[^>]*>/)?.[0];
  assert.ok(input);
  assert.match(input, /\bchecked\b/, 'on by default');
  assert.match(input, /aria-label="Smaller Photos"/);
  const hint = html.slice(html.indexOf(input)).match(/<p class="bt-hint[^"]*">([^<]*)<\/p>/)?.[1] ?? '';
  assert.match(hint, /^On by default\./);
  assert.match(hint, /Only photos and pictures BundleTool converted/);
  assert.match(hint, /never a PDF/);
  const panel = html.slice(html.indexOf('Page Setup</h4>'), html.indexOf('OCR (Searchable Text)'));
  assert.ok(panel.includes('config-smallerPhotos'), 'in the Page Setup panel');
});

test('saved defaults, share links and QR codes keep it, and drop anything that is not true or false', async () => {
  assert.ok(DEFAULTS_KEYS.includes('smallerPhotos'));
  assert.deepEqual(sanitiseConfig({ smallerPhotos: false }, { only: DEFAULTS_KEYS }), { smallerPhotos: false });
  assert.deepEqual(sanitiseConfig({ smallerPhotos: 'false' }, { only: DEFAULTS_KEYS }), {});
  const code = await encodeSettingsCode({ smallerPhotos: false });
  assert.deepEqual(await decodeSettingsCode(code), { smallerPhotos: false });
  const page = read('public/js/bundletoolPage.js');
  assert.match(page, /FACTORY = \{[\s\S]*smallerPhotos: true/);
  assert.match(page, /smallerPhotos: document\.getElementById\('config-smallerPhotos'\)\?\.checked \?\? true/);
  assert.match(page, /getElementById\('config-smallerPhotos'\);\s*if \(el && d\.smallerPhotos !== undefined\) el\.checked = d\.smallerPhotos;/);
});

/** A stand-in for the page's controls: every id answers with one lasting element. */
function stubPage() {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, value: '', checked: false, dataset: {}, style: {}, dispatchEvent() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
    return els.get(id);
  };
  globalThis.document = { getElementById: el, querySelector: () => null, querySelectorAll: () => [] };
  globalThis.window = globalThis;
  return el;
}
const unstub = () => { delete globalThis.document; delete globalThis.window; };

test('an autosave snapshot keeps it and puts it back', async () => {
  const el = stubPage();
  try {
    const { collectFormConfig, applyFormConfig } = await import('../public/js/frontend/autosave.js');
    el('config-smallerPhotos').checked = false;
    const snap = JSON.parse(JSON.stringify(collectFormConfig()));
    assert.equal(snap.smallerPhotos, false);
    el('config-smallerPhotos').checked = true;
    applyFormConfig(snap);
    assert.equal(el('config-smallerPhotos').checked, false);
  } finally { unstub(); }
});

const TOC = [{
  sectionID: '0001', sectionNumber: 1, sectionLabel: 'A', sectionTitle: 'Docs', beginsOnPdfPage: 2, actualPdfStartPageWithToc: 2,
  entries: [{ tabNumber: 1, title: 'Photo', date: '', filename: 'photo.pdf', pageCount: 1, beginsOnPdfPage: 2, beginsOnPageOfSection: 1, actualPdfStartPageWithToc: 2 }],
}];
async function reopened(pageOptions) {
  const config = new Config();
  config.updateOptions({ pageOptions });
  const doc = await PDFDocument.load(await fx.makePdf(2, 'B'));
  setMetadata(doc, TOC, flattenConfig(config));
  return openBundle(await doc.save());
}

test('a bundle remembers it in its embedded config and reopens with it; one made before it existed reopens with it on', async () => {
  const el = stubPage();
  try {
    const { applyExtractedConfig } = await import('../public/js/frontend/bundleGeneration.js');
    const off = await reopened({ smallerPhotos: false });
    assert.equal(off.config.pageOptions.smallerPhotos, false);
    assert.equal(sanitiseNestedConfig(off.config).pageOptions.smallerPhotos, false);
    el('config-smallerPhotos').checked = true;
    applyExtractedConfig(off.config);
    assert.equal(el('config-smallerPhotos').checked, false);
    const on = await reopened({});
    assert.equal(on.config.pageOptions.smallerPhotos, true);
    const older = structuredClone(on.config);
    delete older.pageOptions.smallerPhotos;
    applyExtractedConfig(older);
    assert.equal(el('config-smallerPhotos').checked, true, 'a bundle with no such setting: the default, on');
  } finally { unstub(); }
});

test('the browser\'s manifest export carries it, and importing it sets it', async () => {
  const el = stubPage();
  try {
    const { gatherConfigOptions, applyExtractedConfig } = await import('../public/js/frontend/bundleGeneration.js');
    el('config-smallerPhotos').checked = false;
    const flat = flattenManifestConfig(gatherConfigOptions());
    assert.equal(flat['pageOptions.smallerPhotos'], false);
    el('config-smallerPhotos').checked = true;
    applyExtractedConfig(nestManifestConfig(JSON.parse(JSON.stringify(flat))));
    assert.equal(el('config-smallerPhotos').checked, false);
  } finally { unstub(); }
});

// ── The command line ─────────────────────────────────────────────────────────────────────────────────────

const CLI = path.join(here, '..', 'scripts', 'build-cli.mjs');
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

test('--config-keys, --help settings, the schema and the README describe it, on by default', () => {
  assert.equal(cli(['--json', '--config-keys']).json.configKeys['pageOptions.smallerPhotos'], true);
  assert.match(cli(['--help', 'settings']).stdout, /pageOptions\.smallerPhotos/);
  assert.match(cli(['--help', 'errors']).stdout, /photo_not_smaller/);
  assert.match(JSON.parse(read('manifest.schema.json')).properties.config.description, /pageOptions\.smallerPhotos \(true or false, true by default\)/);
  assert.match(read('README.md'), /\| `pageOptions\.smallerPhotos` \| true or false \| `true` \|/);
});

/** The images of a built bundle's pages, after the index: their sizes. */
async function bundleImages(file) {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  return doc.getPages().map((p) => { try { const i = pageImage(doc, p); return [i.width, i.height]; } catch { return null; } }).filter(Boolean);
}

test('the command line makes a JPEG smaller in the bundle, leaves a PDF\'s picture alone, and keeps both with the setting off', async (t) => {
  if (needsCanvas(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btsmaller-'));
  try {
    const docs = path.join(dir, 'docs');
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, 'photo.jpg'), await photoJpeg(4000, 3000));
    // A PDF that holds a big picture of its own: added as a PDF, so never changed.
    fs.writeFileSync(path.join(docs, 'scan.pdf'), await imagesToPdf([{ bytes: await photoJpeg(3000, 4000, { seed: 9 }), kind: 'jpeg' }], 'a4'));
    const build = (config, out) => {
      fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ schemaVersion: 1, config: { 'heading.bundleTitle': 'T', 'heading.projectName': 'P', 'heading.claimNumber': 'C', 'ocr.mode': 'off', ...config },
        sections: [{ sectionLabel: 'A', sectionName: 'Docs', files: [{ filename: 'photo.jpg', title: 'Photo' }, { filename: 'scan.pdf', title: 'Scan' }] }] }));
      return cli([path.join(dir, 'm.json'), docs, path.join(dir, out)]);
    };
    const on = build({}, 'on.pdf');
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /photo\.jpg: picture made smaller for the bundle, \d+\.\d MB to \d+\.\d MB/);
    assert.deepEqual(await bundleImages(path.join(dir, 'on.pdf')), [[2000, 1500], [3000, 4000]]);
    const off = build({ 'pageOptions.smallerPhotos': false }, 'off.pdf');
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(await bundleImages(path.join(dir, 'off.pdf')), [[4000, 3000], [3000, 4000]]);
    assert.ok(fs.statSync(path.join(dir, 'on.pdf')).size < fs.statSync(path.join(dir, 'off.pdf')).size);
    assert.deepEqual((await openBundle(new Uint8Array(fs.readFileSync(path.join(dir, 'off.pdf'))))).config.pageOptions.smallerPhotos, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without @napi-rs/canvas the command line keeps its pictures and says so', async () => {
  const { loadNodeCodec: load } = await import('../scripts/cliSmallerPhotos.mjs');
  assert.equal(await load({ importCanvas: async () => { throw new Error('missing'); } }), null);
  const code = read('scripts/build-cli.mjs');
  assert.match(code, /if \(!photoCodec\) \{\s*ctx\.warn\('photo_not_smaller'/);
});
