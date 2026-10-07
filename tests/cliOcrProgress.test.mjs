/**
 * The command line reads text synchronously, document by document, so it needs no queue or question; what it needs is
 * to say what it is doing while a long scan is read. Without --json it prints each page as it is read
 * ("scan.pdf: reading text, page 1 of 1"); with --json nothing but the result reaches stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOcrRuntime } from '../scripts/cliOcrEngine.mjs';
import { scanCanvas, scanPdf } from './ocrScans.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'build-cli.mjs');

test('each scanned page is reported as it is read, and --json stays pure JSON', async (t) => {
  if (!(await loadOcrRuntime()).available) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btprogress-'));
  try {
    const docs = path.join(dir, 'docs');
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, 'scan.pdf'), await scanPdf(scanCanvas({})));
    fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ schemaVersion: 1, config: { 'heading.bundleTitle': 'T', 'heading.projectName': 'P', 'heading.claimNumber': 'C' },
      sections: [{ sectionLabel: 'A', sectionName: 'Docs', files: [{ filename: 'scan.pdf', title: 'Scan' }] }] }));
    const plain = spawnSync(process.execPath, [CLI, path.join(dir, 'm.json'), docs, path.join(dir, 'a.pdf')], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /\[bundletool\] scan\.pdf: reading text, page 1 of 1\n/);
    assert.ok(plain.stdout.indexOf('reading text') < plain.stdout.indexOf('source page(s)'), 'while the documents are read, before the build');
    const json = spawnSync(process.execPath, [CLI, '--json', path.join(dir, 'm.json'), docs, path.join(dir, 'b.pdf')], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(json.status, 0, json.stderr);
    assert.doesNotMatch(json.stdout, /reading text/);
    assert.equal(JSON.parse(json.stdout).ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
