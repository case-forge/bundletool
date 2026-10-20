/**
 * The zip writer behind "Download zip" in the split dialog: the file is a real zip that other
 * tools open, names keep their letters, and the bytes come back exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipStore, crc32 } from '../public/js/bundletoolZip.js';

/** Reads the zip back with no help from the writer: end record, central directory, then each entry. */
function readZip(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end of central directory record');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, 'central directory header');
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(local, true), 0x04034b50, 'local file header');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    out.push({ name, crc, bytes: zip.subarray(start, start + size) });
    at += 46 + nameLength;
  }
  return out;
}

test('crc32 agrees with node\'s own', () => {
  const data = new Uint8Array(70_000).map((_, i) => (i * 31 + 7) & 255);
  assert.equal(crc32(data), zlib.crc32(data));
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('a zip of parts holds every file, byte for byte, under its own name', () => {
  const files = [
    { name: 'Bundle for hearing - Cover and index.pdf', bytes: new Uint8Array([37, 80, 68, 70, 1, 2, 3]) },
    { name: 'Bundle for hearing - A Applications.pdf', bytes: new Uint8Array(100_000).map((_, i) => i & 255) },
    { name: 'Wniosek – Załącznik ąęł.pdf', bytes: new Uint8Array(0) },
  ];
  const back = readZip(zipStore(files));
  assert.deepEqual(back.map((f) => f.name), files.map((f) => f.name));
  back.forEach((entry, i) => {
    assert.deepEqual(Buffer.from(entry.bytes), Buffer.from(files[i].bytes));
    assert.equal(entry.crc, zlib.crc32(files[i].bytes));
  });
});

test('other tools accept the zip', (t) => {
  let have = true;
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { have = false; }
  if (!have) { t.skip('unzip is not installed'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-zip-'));
  try {
    const file = path.join(dir, 'parts.zip');
    fs.writeFileSync(file, zipStore([
      { name: 'One - A Applications.pdf', bytes: new Uint8Array(5000).map((_, i) => i & 255) },
      { name: 'One - B Orders.pdf', bytes: new Uint8Array(10) },
    ]));
    const said = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.match(said, /No errors detected/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
