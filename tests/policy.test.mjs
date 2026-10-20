/**
 * Guards on things that must stay true regardless of what else changes.
 *
 * These are cheap and they encode decisions that are expensive to rediscover:
 * a licence obligation, a failure mode that produces blank pages, and a set of
 * storage keys whose names are load-bearing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsRoot = path.join(repoRoot, 'public', 'js');

function sourceFiles(dir = jsRoot) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    // vendor/ holds bundled third-party code (see scripts/build-vendor.mjs).
    // It is not ours: pdf-lib's own source legitimately contains the word
    // ignoreEncryption, and the guards below are about OUR code's behaviour.
    if (entry.isDirectory()) { if (entry.name !== 'vendor') out.push(...sourceFiles(p)); }
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = sourceFiles();

test('there is source to check', () => {
  assert.ok(files.length > 15, `expected the app's modules, found ${files.length}`);
});

/**
 * Strips comments so these guards test the CODE and not the prose about it.
 * Several files explain why mupdf is not used and why ignoreEncryption never
 * is; a naive text search flags those explanations as violations and, worse,
 * creates pressure to delete the explanation.
 */
function codeOnly(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('mupdf is not imported or called anywhere', () => {
  const offenders = files.filter((f) => /mupdf/i.test(codeOnly(f)));
  assert.deepEqual(
    offenders.map((f) => path.relative(repoRoot, f)),
    [],
    'mupdf is AGPL-3.0-or-later and must not be linked into this product',
  );
});

test('ignoreEncryption is never passed', () => {
  // The flag does not decrypt anything. It makes pdf-lib carry on with content
  // streams that are still ciphertext, and the pages come out blank: the
  // worst possible failure in a court bundle, because it looks fine.
  const offenders = files.filter((f) => /ignoreEncryption/.test(codeOnly(f)));
  assert.deepEqual(offenders.map((f) => path.relative(repoRoot, f)), []);
});

test('stock pdf-lib is not loaded alongside @cantoo/pdf-lib', () => {
  const offenders = files.filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return /cdn\.jsdelivr\.net\/npm\/pdf-lib@/.test(src);
  });
  assert.deepEqual(offenders.map((f) => path.relative(repoRoot, f)), []);
});

test('the PDF engine is imported in exactly one file', () => {
  // One import site, so one place a version is pinned.
  const pinning = files.filter((f) => /vendor\/cantoo-pdf-lib\.js/.test(codeOnly(f)));
  assert.deepEqual(
    pinning.map((f) => path.basename(f)),
    ['bundletoolPdfLib.js'],
    'every module must import the engine through bundletoolPdfLib.js',
  );
});

test('no module loads anything from a third-party CDN at runtime', () => {
  // The dependencies are self-hosted under public/js/vendor/ precisely so the
  // app works with no third party up and discloses nothing to one. A CDN URL
  // anywhere in app code would undo that silently.
  const offenders = files.filter((f) => /(cdn\.jsdelivr\.net|esm\.sh|unpkg\.com)/.test(codeOnly(f)));
  assert.deepEqual(offenders.map((f) => path.relative(repoRoot, f)), []);
  // The page templates must not name a CDN either.
  const templateFiles = ['layouts/partials/bundletool.html', 'layouts/partials/header.html',
    'layouts/partials/footer.html', 'layouts/_default/baseof.html', 'layouts/index.html'];
  for (const rel of templateFiles) {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.ok(!/(cdn\.jsdelivr\.net|esm\.sh|unpkg\.com)/.test(src), `${rel} references a CDN`);
  }
});

/**
 * Every file carried over from BunTool with an MPL-2.0 header, by its current
 * name.
 *
 * MPL-2.0 section 3.4 forbids removing the licence and copyright notices from a
 * covered file. These files carry new names, and most have been rewritten or
 * split in two: exactly the circumstances in which a header goes missing
 * without anyone noticing.
 */
const MUST_KEEP_MPL_HEADER = [
  'bundletoolAutosave.js', 'bundletoolConfig.js', 'bundletoolFontSettings.js',
  'bundletoolIndexData.js', 'bundletoolMain.js', 'bundletoolMerge.js',
  'bundletoolMeta.js', 'bundletoolPages.js', 'bundletoolRestore.js',
  'bundletoolToc.js', 'frontend.js',
  'workers/bundletoolFooterWorker.js', 'workers/bundletoolMergeWorker.js',
  // There is no separate metadata worker: the metadata pass runs inside the
  // single-pass build worker, and its logic is in bundletoolMeta.js, which is
  // on this list. MPL 3.4 forbids stripping notices from a file that ships,
  // not leaving a file out.
];

test('every file that had an MPL-2.0 header still has one', () => {
  const missing = [];
  for (const rel of MUST_KEEP_MPL_HEADER) {
    const file = path.join(jsRoot, rel);
    assert.ok(fs.existsSync(file), `${rel} is missing entirely`);
    const head = fs.readFileSync(file, 'utf8').slice(0, 1200);
    if (!/Mozilla Public License/i.test(head)) missing.push(rel);
  }
  assert.deepEqual(missing, [], 'these files lost their MPL-2.0 header');
});

test('new modules split out of MPL-covered files carry the licence too', () => {
  // These hold code taken from files that carry the notice, so they are
  // covered files in their own right.
  const derived = [
    'bundletoolFooter.js', 'bundletoolOutline.js', 'bundletoolLinks.js',
    'bundletoolPdfLib.js', 'bundletoolPdfLoad.js', 'frontend/crashGuard.js',
    // The single-pass build holds the merge loop and stage orchestration
    // taken from bundletoolMerge.js and bundletoolMain.js.
    'bundletoolBuild.js', 'workers/bundletoolBuildWorker.js',
  ];
  const missing = derived.filter((rel) => {
    const head = fs.readFileSync(path.join(jsRoot, rel), 'utf8').slice(0, 1200);
    return !/Mozilla Public License/i.test(head);
  });
  assert.deepEqual(missing, []);
});

test('files carried over from BunTool keep the upstream copyright line', () => {
  // Files whose code originated upstream must still name Tris Sherliker.
  const carriedOver = [
    'bundletoolAutosave.js', 'bundletoolConfig.js', 'bundletoolFontSettings.js',
    'bundletoolIndexData.js', 'bundletoolMain.js', 'bundletoolMerge.js',
    'bundletoolMeta.js', 'bundletoolPages.js', 'bundletoolRestore.js',
    'bundletoolToc.js', 'bundletoolFooter.js', 'frontend.js',
  ];
  const missing = [];
  for (const name of carriedOver) {
    const p = path.join(jsRoot, name);
    assert.ok(fs.existsSync(p), `${name} should exist`);
    const head = fs.readFileSync(p, 'utf8').slice(0, 1200);
    if (!/Sherliker/i.test(head)) missing.push(name);
  }
  assert.deepEqual(missing, [], 'these carried-over files lost the upstream copyright notice');
});

test('the upstream attribution stays in the page footer', () => {
  const footer = fs.readFileSync(path.join(repoRoot, 'layouts', 'partials', 'footer.html'), 'utf8');
  assert.match(footer, /Based on <a[^>]*>BunTool<\/a> by Tris Sherliker/);
});

test('the MPL LICENSE file is still present', () => {
  const licence = fs.readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8');
  assert.match(licence, /Mozilla Public License Version 2\.0/);
});

test('storage keys that name existing user data are unchanged', () => {
  // Renaming any of these does not migrate the data, it abandons it. See the
  // comments at each definition.
  // buntool_tutorial_seen and buntool_autosave_welcomed are not on this list:
  // the tutorial is on demand and there is no autosave welcome, so nothing
  // reads either flag and the keys are simply left unused (one stale boolean
  // each). That is not a rename, which is what this guard exists to prevent.
  const expectations = [
    ['bundletoolTheme.js', "'buntool_theme'"],
    ['bundletoolAutosave.js', "'buntool-autosave'"],
  ];
  for (const [file, key] of expectations) {
    const src = fs.readFileSync(path.join(jsRoot, file), 'utf8');
    assert.ok(src.includes(key), `${file} must still use ${key}`);
  }
  // The saved-defaults code lives in the page script (the Content-Security-Policy allows no
  // inline script).
  const pageScript = fs.readFileSync(path.join(jsRoot, 'bundletoolPage.js'), 'utf8');
  assert.ok(pageScript.includes("'buntool-default-config'"));
});

test('no buntool-prefixed source files remain', () => {
  const stragglers = files
    .map((f) => path.basename(f))
    .filter((n) => /^buntool/i.test(n));
  assert.deepEqual(stragglers, []);
});

test('console messages carry no document names, titles or dates', () => {
  // The browser console outlives the page on a shared machine, so what a
  // message may say is counts and states, never what a document is called.
  const risky = /\b(filename|fileName|entryDate|tocEntries|rowCoordinates|\.title|\.name)\b(?!\.length)/;
  const offenders = [];
  for (const f of files) {
    codeOnly(f).split('\n').forEach((line, i) => {
      if (/console\.(log|info|debug|warn|error)\(/.test(line) && risky.test(line)) {
        offenders.push(`${path.relative(repoRoot, f)}:${i + 1}: ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
