/**
 * lazyImport() resolves a plain relative specifier against /js/shared/lazy-load.js, not against the file that
 * calls it, and BundleTool's own scripts are served from /bundletool/js/, so `lazyImport('../x.js')` would ask
 * for /js/x.js and fail on every load. A first-party module is therefore always named by
 * `new URL('<path>', import.meta.url)`, which resolves against the calling file. This pins both halves: no
 * lazyImport() takes a relative string, and every URL form points at a file that exists. The classic page
 * script (bundletoolPage.js) has no import.meta, so it names its modules against PAGE_SCRIPT_URL, its own
 * address; that form is checked the same way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/js');

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') yield* walk(p); }
    else if (/\.m?js$/.test(e.name)) yield p;
  }
}

const files = [...walk(ROOT)].map((p) => ({ p, text: fs.readFileSync(p, 'utf8') }));

test('no lazyImport() takes a relative string specifier', () => {
  const bad = [];
  for (const { p, text } of files) {
    for (const m of text.matchAll(/lazyImport\(\s*(['"`])(\.{1,2}\/[^'"`]*)\1/g)) bad.push(`${path.relative(ROOT, p)}: ${m[2]}`);
  }
  assert.deepEqual(bad, [], 'name a first-party module as new URL(path, import.meta.url): a relative string resolves against lazy-load.js');
});

test('every lazyImport(new URL(path, import.meta.url | PAGE_SCRIPT_URL)) names a file that exists', () => {
  let seen = 0;
  const missing = [];
  for (const { p, text } of files) {
    for (const m of text.matchAll(/lazyImport\(\s*new URL\(\s*(['"`])([^'"`]+)\1\s*,\s*(?:import\.meta\.url|PAGE_SCRIPT_URL)\s*\)/g)) {
      seen++;
      if (!fs.existsSync(path.resolve(path.dirname(p), m[2]))) missing.push(`${path.relative(ROOT, p)}: ${m[2]}`);
    }
  }
  assert.ok(seen > 0, 'the scan found at least one call, so it is not passing vacuously');
  assert.deepEqual(missing, []);
});
