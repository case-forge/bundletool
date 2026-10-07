import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { sniffHead, classifyBlob, classifyBytes, zipFlavour } from '../public/js/bundletoolSniff.js';
import { admitFile, safeFileName, correctedName, claimedExtension } from '../public/js/frontend/fileGate.js';
import { MAX_FILE_MB } from '../public/js/frontend/limits.js';

const bytes = (...a) => Uint8Array.from(a);
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const pad = (u8, n = 64) => cat(u8, new Uint8Array(Math.max(0, n - u8.length)));

// A minimal zip writer: stored or deflated entries, with the declared sizes overridable to model a bomb.
function zip(entries) {
  const locals = []; const dirs = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name); const raw = Buffer.from(e.data ?? '');
    const method = e.stored ? 0 : 8; const body = e.stored ? raw : zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw); const declaredSize = e.declaredSize ?? raw.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(declaredSize, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(declaredSize, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    dirs.push(cd, name);
    offset += lh.length + name.length + body.length;
  }
  const dir = Buffer.concat(dirs);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}
const docxEntries = (extra = []) => [
  { name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: '<w:document/>' }, ...extra,
];
const file = (u8, name) => new File([u8], name);
function pngHead(w, h) {
  const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b;
}

test('the type comes from the bytes: every supported kind and the ones that are not', () => {
  const cases = [
    ['pdf', pad(ascii('%PDF-1.7\n'))], ['pdf', pad(cat(ascii('JUNK'.repeat(50)), ascii('%PDF-1.4')))],
    ['jpeg', pad(bytes(0xff, 0xd8, 0xff, 0xe0))], ['png', pad(bytes(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10))],
    ['gif', pad(ascii('GIF89a'))], ['bmp', pad(ascii('BM'))], ['webp', pad(cat(ascii('RIFF'), bytes(0, 0, 0, 0), ascii('WEBP')))],
    ['tiff', pad(bytes(0x49, 0x49, 0x2a, 0))], ['tiff', pad(bytes(0x4d, 0x4d, 0, 0x2a))],
    ['avif', pad(cat(bytes(0, 0, 0, 24), ascii('ftypavif')))], ['heic', pad(cat(bytes(0, 0, 0, 24), ascii('ftypheic')))],
    ['zip', pad(bytes(0x50, 0x4b, 3, 4))], ['ole', pad(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))],
    ['exe', pad(ascii('MZ'))], ['exe', pad(bytes(0x7f, 0x45, 0x4c, 0x46))], ['exe', pad(ascii('#!/bin/sh'))],
    ['shortcut', pad(bytes(0x4c, 0, 0, 0, 1, 0x14, 2, 0))],
    ['html', ascii('<!DOCTYPE html><html>')], ['html', ascii('  \n<script>alert(1)</script>')],
    ['svg', ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>')], ['svg', ascii('<?xml version="1.0"?><svg/>')],
    ['text', ascii('hello, this is plain text\nwith lines\n')], ['unknown', pad(bytes(0, 1, 2, 3, 4, 200, 201))], ['empty', new Uint8Array(0)],
  ];
  for (const [kind, data] of cases) assert.equal(sniffHead(data), kind, kind);
});

test('a name never decides the type, and a wrong extension is corrected', () => {
  assert.equal(claimedExtension('scan.PDF'), 'pdf');
  assert.equal(correctedName('scan.jpg', 'pdf'), 'scan.pdf');
  assert.equal(correctedName('scan.pdf', 'jpeg'), 'scan.jpg');
  assert.equal(correctedName('scan.pdf', 'pdf'), 'scan.pdf');
  assert.equal(correctedName('holiday.jpeg', 'jpeg'), 'holiday.jpeg');
  assert.equal(correctedName('evidence.docm', 'docx'), 'evidence.docx');
  assert.equal(correctedName('evidence', 'pdf'), 'evidence.pdf');
});

test('safe names: no control characters, reversals, separators, leading dots or runaway length', () => {
  assert.equal(safeFileName('report.pdf'), 'report.pdf');
  assert.equal(safeFileName('a\u0000b\u001fc.pdf'), 'abc.pdf');
  assert.equal(safeFileName('annual\u202Efdp.exe'), 'annualfdp.exe');   // the right-to-left override is gone
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\Users\\me\\x.pdf'), 'x.pdf');
  assert.equal(safeFileName('....pdf'), 'document.pdf');
  assert.equal(safeFileName('.pdf'), 'document.pdf');
  assert.equal(safeFileName('   .pdf'), 'document.pdf');
  assert.equal(safeFileName('...'), 'document');
  assert.equal(safeFileName('   '), 'document');
  assert.equal(safeFileName('\u200b\u200d'), 'document');
  assert.equal(safeFileName('Tŷ Ŵyn – Łódź 📄.pdf'), 'Tŷ Ŵyn – Łódź 📄.pdf');
  const long = safeFileName('x'.repeat(400) + '.pdf');
  assert.ok(long.length <= 120 && long.endsWith('….pdf'), long);
  assert.equal(safeFileName('__proto__'), '__proto__');
  assert.equal(safeFileName('_draft v2.pdf'), '_draft v2.pdf');
});

test('an empty file, a huge file and an unreadable file are refused in plain words', async () => {
  const empty = await admitFile(file(new Uint8Array(0), 'blank.pdf'));
  assert.equal(empty.ok, false); assert.match(empty.message, /empty \(0 bytes\)/); assert.match(empty.message, /not added/);
  const huge = await admitFile({ name: 'big.pdf', size: (MAX_FILE_MB + 1) * 1024 * 1024, slice() { throw new Error('must not be read'); } });
  assert.equal(huge.ok, false); assert.match(huge.message, new RegExp(`${MAX_FILE_MB} MB`)); assert.match(huge.message, /Split it/);
  const folder = await admitFile({ name: 'Exhibits', size: 4096, slice() { throw new Error('NotFoundError'); } });
  assert.equal(folder.ok, false); assert.match(folder.message, /folder/);
});

test('PDF bytes named .jpg are added as a PDF, a photo named .pdf as a photo, each with a note', async () => {
  const pdf = await admitFile(file(pad(ascii('%PDF-1.4\n')), 'scan.jpg'));
  assert.deepEqual([pdf.ok, pdf.route, pdf.kind], [true, 'pdf', 'pdf']); assert.match(pdf.note, /named \.jpg but is really a PDF, so it was treated as one/);
  const jpg = await admitFile(file(pad(bytes(0xff, 0xd8, 0xff, 0xe0)), 'scan.pdf'));
  assert.deepEqual([jpg.ok, jpg.route, jpg.kind], [true, 'photo', 'jpeg']); assert.match(jpg.note, /named \.pdf but is really a JPEG photo/);
  const fine = await admitFile(file(pad(ascii('%PDF-1.4\n')), 'scan.pdf'));
  assert.equal(fine.note, '');
});

test('a program, a web page, an SVG, text and old Office files named as documents are refused and never opened', async () => {
  for (const [data, name, pattern] of [
    [pad(ascii('MZ')), 'contract.pdf', /named \.pdf but is really a program/],
    [ascii('<html><script>alert(1)</script>'), 'letter.pdf', /a web page/],
    [ascii('<svg onload="alert(1)"></svg>'), 'logo.png', /an SVG drawing/],
    [ascii('just text\n'), 'notes.docx', /plain text file/],
    [pad(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)), 'old.docx', /older Microsoft Office file/],
    [pad(bytes(0x4c, 0, 0, 0, 1, 0x14, 2, 0)), 'x.pdf.lnk', /Windows shortcut/],
  ]) {
    const r = await admitFile(file(data, name));
    assert.equal(r.ok, false, name); assert.match(r.message, pattern, name); assert.equal(r.guide, true);
  }
});

test('other zip-based files are named for what they are', async () => {
  for (const [entries, pattern] of [
    [[{ name: 'xl/workbook.xml', data: '<w/>' }], /Excel spreadsheet/], [[{ name: 'ppt/presentation.xml', data: '<p/>' }], /PowerPoint/],
    [[{ name: 'mimetype', data: 'x', stored: true }, { name: 'content.xml', data: '<x/>' }], /OpenDocument/], [[{ name: 'a.txt', data: 'x' }], /zip archive/],
  ]) {
    const r = await admitFile(file(zip(entries), 'thing.docx')); assert.equal(r.ok, false); assert.match(r.message, pattern);
  }
  assert.equal(zipFlavour([{ name: 'word/document.xml' }, { name: '[Content_Types].xml' }]), 'docx');
});

test('a Word document is admitted, and one with macros is admitted with a note', async () => {
  const ok = await admitFile(file(zip(docxEntries()), 'letter.docx'));
  assert.deepEqual([ok.ok, ok.route], [true, 'docx']);
  const macro = await admitFile(file(zip(docxEntries([{ name: 'word/vbaProject.bin', data: 'x' }])), 'letter.docm'));
  assert.deepEqual([macro.ok, macro.route], [true, 'docx']); assert.match(macro.note, /macros/);
});

test('a zip bomb, a document with too many parts and a huge picture are refused before anything is unpacked', async () => {
  const lyingSize = await admitFile(file(zip(docxEntries([{ name: 'word/media/x.bin', data: 'tiny', declaredSize: 900 * 1024 * 1024 }])), 'a.docx'));
  assert.equal(lyingSize.ok, false); assert.match(lyingSize.message, /Save As and pick PDF/);
  const longXml = await admitFile(file(zip([{ name: '[Content_Types].xml', data: '<T/>' }, { name: 'word/document.xml', data: '<d/>', declaredSize: 20 * 1024 * 1024 }]), 'b.docx'));
  assert.equal(longXml.ok, false); assert.match(longXml.message, /very long/);
  const many = await admitFile(file(zip(docxEntries(Array.from({ length: 3100 }, (_, i) => ({ name: `j/${i}.txt`, data: 'x' })))), 'c.docx'));
  assert.equal(many.ok, false); assert.match(many.message, /separate parts/);
  const bigPicture = await admitFile(file(zip(docxEntries([{ name: 'word/media/p.png', data: Buffer.from(pngHead(20000, 20000)), stored: true }])), 'd.docx'));
  assert.equal(bigPicture.ok, false); assert.match(bigPicture.message, /million pixels/);
  const smallPicture = await admitFile(file(zip(docxEntries([{ name: 'word/media/p.png', data: Buffer.from(pngHead(800, 600)), stored: true }])), 'e.docx'));
  assert.equal(smallPicture.ok, true);
});

test('a very long Word document is refused by the amount of its text, a normal one is not', async () => {
  const para = (n) => `<w:p><w:r><w:t>${'Lorem ipsum dolor sit amet. '.repeat(n)}</w:t></w:r></w:p>`;
  const longXml = '<w:document><w:body>' + para(8).repeat(7000) + '</w:body></w:document>';     // about 650 pages
  const long = await admitFile(file(zip([{ name: '[Content_Types].xml', data: '<T/>' }, { name: 'word/document.xml', data: longXml }]), 'long.docx'));
  assert.equal(long.ok, false); assert.match(long.message, /about \d+ pages/); assert.doesNotMatch(long.message, /\.,|\. so /);
  const normalXml = '<w:document><w:body>' + para(8).repeat(400) + '</w:body></w:document>';    // about 35 pages
  const normal = await admitFile(file(zip([{ name: '[Content_Types].xml', data: '<T/>' }, { name: 'word/document.xml', data: normalXml }]), 'normal.docx'));
  assert.equal(normal.ok, true);
});

test('a cut-short Word document is refused as damaged, not as an unknown file', async () => {
  const good = zip(docxEntries());
  const r = await admitFile(file(good.slice(0, Math.floor(good.length * 0.6)), 'cut.docx'));
  assert.equal(r.ok, false); assert.match(r.message, /damaged or cut short/);
});

test('classifyBlob reads a directory from the end without unpacking', async () => {
  const info = await classifyBlob(new Blob([zip(docxEntries())]));
  assert.equal(info.kind, 'zip'); assert.equal(info.zip.flavour, 'docx');
});

test('classifyBytes answers exactly as classifyBlob does, including for a view that starts partway into a buffer', async () => {
  const good = zip(docxEntries());
  const cases = [
    pad(ascii('%PDF-1.7\n')), pad(bytes(0xff, 0xd8, 0xff, 0xe0)), ascii('hello, plain text\n'), new Uint8Array(0),
    good, zip([{ name: 'a.txt', data: 'x' }]), good.slice(0, Math.floor(good.length * 0.6)),
  ];
  for (const data of cases) {
    assert.deepEqual(await classifyBytes(data), await classifyBlob(new Blob([data])));
    // The same bytes as a view into a bigger buffer: every read must honour the view's own offset.
    const host = new Uint8Array(data.length + 300); host.fill(0x41); host.set(data, 100);
    assert.deepEqual(await classifyBytes(host.subarray(100, 100 + data.length)), await classifyBlob(new Blob([data])));
  }
});

test('classifyBytes does not copy the file it reads (new Blob([bytes]) copies all of it)', async () => {
  const big = new Uint8Array(64 * 1024 * 1024); big.set(ascii('%PDF-1.7\n'));
  const before = process.memoryUsage().arrayBuffers;
  assert.equal((await classifyBytes(big)).kind, 'pdf');
  const grown = process.memoryUsage().arrayBuffers - before;
  assert.ok(grown < 16 * 1024 * 1024, `classifying a 64 MB file grew array buffers by ${(grown / 1048576).toFixed(0)} MB`);
});
