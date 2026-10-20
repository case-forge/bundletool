/**
 * What the BundleTool command line accepts as a source file: PDFs (with an optional per-file turn), JPEG and PNG
 * photos read by their bytes, and a plain refusal for every other type the browser opens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from './fixtures.mjs';
import { loadPdf } from '../public/js/bundletoolPdfLoad.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'scripts', 'build-cli.mjs');
const photos = path.join(root, 'tests', 'fixtures', 'photo');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'btin-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
/** A one-section manifest naming `files` (name or {filename, ...}), the documents written by `put`, and the output path. */
function build(d, files, put, config = {}) {
  const docs = path.join(d, 'docs'); fs.mkdirSync(docs, { recursive: true });
  put(docs);
  const mp = path.join(d, 'm.json');
  fs.writeFileSync(mp, JSON.stringify({ config, sections: [{ sectionLabel: 'A', sectionName: 'Docs', files: files.map((f) => (typeof f === 'string' ? { filename: f, title: f } : { title: f.filename, ...f })) }] }));
  const out = path.join(d, 'out.pdf');
  return { r: cli(['--json', mp, docs, out]), out };
}
const load = async (file) => (await loadPdf(new Uint8Array(fs.readFileSync(file)))).doc;
const copyPhoto = (name, as) => (docs) => fs.copyFileSync(path.join(photos, name), path.join(docs, as ?? name));

test('a file entry may turn its document: the turn is added to the rotation the file already has', async () => {
  const d = tmp();
  try {
    const src = await fx.makePdf(2, 'TURNED', { rotations: [0, 90] });   // page 1 upright, page 2 already carries 90
    const plain = build(path.join(d, 'a'), ['x.pdf'], (docs) => fs.writeFileSync(path.join(docs, 'x.pdf'), src));
    const turned = build(path.join(d, 'b'), [{ filename: 'x.pdf', rotate: 90 }], (docs) => fs.writeFileSync(path.join(docs, 'x.pdf'), src));
    assert.equal(turned.r.status, 0, turned.r.stdout + turned.r.stderr);
    const angles = async (f) => (await load(f)).getPages().map((p) => p.getRotation().angle);
    const before = await angles(plain.out); const after = await angles(turned.out);
    assert.equal(before.length, after.length);
    // the last two pages are the document's own (the index page comes first)
    assert.deepEqual(before.slice(-2), [0, 90]);
    assert.deepEqual(after.slice(-2), [90, 180]);
    const twice = build(path.join(d, 'c'), [{ filename: 'x.pdf', rotate: 270 }], (docs) => fs.writeFileSync(path.join(docs, 'x.pdf'), src));
    assert.deepEqual((await angles(twice.out)).slice(-2), [270, 0]);
  } finally { rm(d); }
});

test('a rotate that is not 90, 180 or 270 is refused with invalid_rotation, before anything is read', () => {
  const d = tmp();
  try {
    for (const bad of [45, 0, -90, 360, '90', null, 1.5]) {
      const { r } = build(path.join(d, String(bad)), [{ filename: 'x.pdf', rotate: bad }], () => {});
      assert.equal(r.status, 3, `rotate ${JSON.stringify(bad)}`);
      assert.equal(r.json.error.code, 'invalid_rotation');
    }
  } finally { rm(d); }
});

test('a JPEG or PNG is a page of the bundle, read by its bytes not its name, and a rotated photo comes out upright', async () => {
  const d = tmp();
  try {
    const { r, out } = build(d, ['scan.pdf', 'plain.png', 'phone.jpg'], (docs) => {
      copyPhoto('plain.jpg', 'scan.pdf')(docs);       // a JPEG called .pdf
      copyPhoto('upright.png', 'plain.png')(docs);
      copyPhoto('orientation-6.jpg', 'phone.jpg')(docs);
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.pages.source, 3, 'one page per photo');
    assert.equal((await load(out)).getPageCount(), r.json.pages.total);
    const photoPage = (await load(out)).getPage(r.json.pages.total - 1);
    assert.ok(Math.abs(photoPage.getSize().width - 595.28) < 0.5, 'an A4 page');
  } finally { rm(d); }
});

test('the photo goes on the bundle page size, and a photo can be turned like a PDF', async () => {
  const d = tmp();
  try {
    const { r, out } = build(d, [{ filename: 'p.jpg', rotate: 90 }], copyPhoto('plain.jpg', 'p.jpg'), { 'pageOptions.pageSize': 'letter' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const last = (await load(out)).getPages().at(-1);
    assert.equal(last.getRotation().angle, 90);
    assert.ok(Math.abs(last.getSize().width - 612) < 0.5 || Math.abs(last.getSize().height - 612) < 0.5, 'Letter');
  } finally { rm(d); }
});

test('every other type the browser opens is refused with unsupported_input_type, naming the type', () => {
  const d = tmp();
  try {
    const stub = (...bytes) => (docs, name) => fs.writeFileSync(path.join(docs, name), Buffer.from([...bytes, ...new Array(40).fill(0)]));
    const cases = [
      ['x.docx', (docs) => copyPhoto('sample.docx', 'x.docx')(docs), /Word document/],
      ['x.webp', (docs) => copyPhoto('sample.webp', 'x.webp')(docs), /WEBP/],
      ['x.gif', (docs) => stub(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)(docs, 'x.gif'), /GIF/],
      ['x.bmp', (docs) => stub(0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)(docs, 'x.bmp'), /BMP/],
      ['x.tif', (docs) => stub(0x49, 0x49, 0x2a, 0x00)(docs, 'x.tif'), /TIFF/],
      ['x.doc', (docs) => stub(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)(docs, 'x.doc'), /Office/],
    ];
    for (const [name, put, message] of cases) {
      const { r } = build(path.join(d, name), [name], put);
      assert.equal(r.status, 3, name);
      assert.equal(r.json.error.code, 'unsupported_input_type', name);
      assert.match(r.json.error.message, message, name);
      assert.match(r.json.error.message, /convert it to a PDF first/, name);
      assert.equal(r.json.error.details.file, name);
    }
  } finally { rm(d); }
});

test('a cut-short or lying picture is invalid_image or image_too_large, never a PDF parse error', () => {
  const d = tmp();
  try {
    const jpg = fs.readFileSync(path.join(photos, 'plain.jpg'));
    const cut = build(path.join(d, 'cut'), ['c.jpg'], (docs) => fs.writeFileSync(path.join(docs, 'c.jpg'), jpg.subarray(0, jpg.length / 2)));
    assert.equal(cut.r.status, 3);
    assert.equal(cut.r.json.error.code, 'invalid_image');
    const png = Buffer.from(fs.readFileSync(path.join(photos, 'upright.png')));
    png.writeUInt32BE(60000, 16); png.writeUInt32BE(60000, 20);
    const big = build(path.join(d, 'big'), ['b.png'], (docs) => fs.writeFileSync(path.join(docs, 'b.png'), png));
    assert.equal(big.r.status, 3);
    assert.ok(['image_too_large', 'invalid_image'].includes(big.r.json.error.code), big.r.json.error.code);
    const junk = build(path.join(d, 'junk'), ['j.png'], (docs) => fs.writeFileSync(path.join(docs, 'j.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30, 7)])));
    assert.equal(junk.r.status, 3);
    assert.equal(junk.r.json.error.code, 'invalid_image');
  } finally { rm(d); }
});

test('the size limits of the browser hold: one file over 200 MB is file_too_large', () => {
  const d = tmp();
  try {
    const { r } = build(d, ['big.pdf'], (docs) => {
      const fd = fs.openSync(path.join(docs, 'big.pdf'), 'w');
      fs.writeSync(fd, Buffer.from('%PDF-1.4\n'));
      fs.ftruncateSync(fd, 201 * 1024 * 1024);
      fs.closeSync(fd);
    });
    assert.equal(r.status, 3);
    assert.equal(r.json.error.code, 'file_too_large');
  } finally { rm(d); }
});
