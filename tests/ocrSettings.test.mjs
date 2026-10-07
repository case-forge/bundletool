/**
 * The two optional OCR settings, ocr.turnUpright and ocr.straighten (flat ocrTurnUpright and ocrStraighten), reach
 * every place settings go: the Config defaults and checks, Advanced Settings, saved defaults, share links and QR
 * codes, autosave snapshots, the bundle's embedded config, the browser's manifest export and import, both OCR paths
 * in the browser, and the command line with its schema and generated docs. The form functions are the real exported
 * ones, driven against a small stand-in for the page's controls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from './fixtures.mjs';
import Config from '../public/js/bundletoolConfig.js';
import { flattenConfig, setMetadata } from '../public/js/bundletoolMeta.js';
import { PDFDocument } from '../public/js/bundletoolPdfLib.js';
import { openBundle } from '../public/js/bundletoolRestore.js';
import { sanitiseConfig, sanitiseNestedConfig, DEFAULTS_KEYS } from '../public/js/frontend/configSanitise.js';
import { encodeSettingsCode, decodeSettingsCode, CODE_PREFIX_V1 } from '../public/js/frontend/settingsCode.js';
import { flattenManifestConfig, nestManifestConfig } from '../public/js/manifestSchema.js';
import { loadOcrRuntime } from '../scripts/cliOcrEngine.mjs';
import { scanCanvas, scanPdf } from './ocrScans.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');
const KEYS = { turnUpright: 'ocrTurnUpright', straighten: 'ocrStraighten' };

/** A stand-in for the page's controls: every id answers with one lasting element. */
function stubPage() {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, value: '', checked: false, dataset: {}, style: {}, dispatchEvent() {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      });
    }
    return els.get(id);
  };
  globalThis.document = { getElementById: el, querySelector: () => null, querySelectorAll: () => [] };
  globalThis.window = globalThis;
  return el;
}
const unstub = () => { delete globalThis.document; delete globalThis.window; };

// ── The engine's own settings ─────────────────────────────────────────────────────────────────────────────

test('both settings default to false, are checked like every other setting, and travel in the flattened config', () => {
  const config = new Config();
  assert.equal(config.getOption('ocr.turnUpright'), false);
  assert.equal(config.getOption('ocr.straighten'), false);
  config.validateStructure();
  config.validateOptions();
  assert.equal(flattenConfig(config)['ocr.turnUpright'], false);
  for (const field of Object.keys(KEYS)) {
    const bad = new Config();
    bad.updateOptions({ ocr: { [field]: 'yes' } });
    assert.throws(() => bad.validateOptions(), new RegExp(field === 'turnUpright' ? 'turn upright' : 'straighten'));
    const on = new Config();
    on.updateOptions({ ocr: { [field]: true } });
    on.validateOptions();
    assert.equal(flattenConfig(on)[`ocr.${field}`], true);
  }
});

// ── Advanced Settings ─────────────────────────────────────────────────────────────────────────────────────

test('Advanced Settings has both toggles, off unless set, each with help saying it is off by default and for scanned pages only', () => {
  const html = read('layouts/partials/bundletool.html');
  for (const [id, label] of [['config-ocrTurnUpright', 'Turn Sideways Scanned Pages Upright'], ['config-ocrStraighten', 'Straighten Tilted Scanned Pages']]) {
    const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(input, id);
    assert.doesNotMatch(input, /\bchecked\b/, `${id} starts off`);
    assert.match(input, new RegExp(`aria-label="${label}"`));
    const after = html.slice(html.indexOf(input));
    const hint = after.match(/<p class="bt-hint[^"]*">([^<]*)<\/p>/)?.[1] ?? '';
    assert.match(hint, /^Off by default\./, `${id} help`);
    assert.match(hint, /Scanned pages only/, `${id} help`);
  }
  // Both sit in the OCR panel, after the automatic check.
  const panel = html.slice(html.indexOf('OCR (Searchable Text)'), html.indexOf('Split for Email</h4>'));
  assert.ok(panel.includes('config-ocrAutoDetect') && panel.includes('config-ocrTurnUpright') && panel.includes('config-ocrStraighten'));
});

// ── Saved defaults and share links ────────────────────────────────────────────────────────────────────────

test('saved defaults keep both settings, and drop anything that is not true or false', () => {
  assert.ok(DEFAULTS_KEYS.includes('ocrTurnUpright') && DEFAULTS_KEYS.includes('ocrStraighten'));
  const stored = JSON.parse(JSON.stringify({ fontFace: 'serif', ocrTurnUpright: true, ocrStraighten: true }));
  assert.deepEqual(sanitiseConfig(stored, { only: DEFAULTS_KEYS }), { fontFace: 'serif', ocrTurnUpright: true, ocrStraighten: true });
  assert.deepEqual(sanitiseConfig({ ocrTurnUpright: 'true', ocrStraighten: 1 }, { only: DEFAULTS_KEYS }), {});
  // The page reads, factory-sets and applies both, by these ids and keys.
  const page = read('public/js/bundletoolPage.js');
  assert.match(page, /FACTORY = \{[\s\S]*ocrTurnUpright: false, ocrStraighten: false/);
  assert.match(page, /ocrTurnUpright: document\.getElementById\('config-ocrTurnUpright'\)\?\.checked === true/);
  assert.match(page, /ocrStraighten: document\.getElementById\('config-ocrStraighten'\)\?\.checked === true/);
  assert.match(page, /for \(const key of \['ocrTurnUpright', 'ocrStraighten'\]\)[\s\S]{0,120}getElementById\(`config-\$\{key\}`\)[\s\S]{0,80}el\.checked = d\[key\]/);
});

test('a share link or QR code carries both settings, compressed and plain', async () => {
  const diff = { ocrTurnUpright: true, ocrStraighten: true, dateStyle: 'DD-MM-YYYY' };
  const code = await encodeSettingsCode(diff);
  assert.match(code, /^BT2\./);
  assert.deepEqual(await decodeSettingsCode(code), diff);
  const v1 = CODE_PREFIX_V1 + Buffer.from(JSON.stringify({ ocrStraighten: true })).toString('base64url');
  assert.deepEqual(await decodeSettingsCode(v1), { ocrStraighten: true });
  const bad = CODE_PREFIX_V1 + Buffer.from(JSON.stringify({ ocrTurnUpright: 'on' })).toString('base64url');
  assert.deepEqual(await decodeSettingsCode(bad), {});
});

// ── Autosave, the embedded config and the manifest ────────────────────────────────────────────────────────

test('an autosave snapshot keeps both settings and puts them back', async () => {
  const el = stubPage();
  try {
    const { collectFormConfig, applyFormConfig } = await import('../public/js/frontend/autosave.js');
    el('config-ocrTurnUpright').checked = true;
    el('config-ocrStraighten').checked = true;
    const snap = JSON.parse(JSON.stringify(collectFormConfig()));
    assert.equal(snap.ocrTurnUpright, true);
    assert.equal(snap.ocrStraighten, true);
    el('config-ocrTurnUpright').checked = false;
    el('config-ocrStraighten').checked = false;
    applyFormConfig(snap);
    assert.equal(el('config-ocrTurnUpright').checked, true);
    assert.equal(el('config-ocrStraighten').checked, true);
  } finally { unstub(); }
});

const TOC = [{
  sectionID: '0001', sectionNumber: 1, sectionLabel: 'A', sectionTitle: 'Docs', beginsOnPdfPage: 2, actualPdfStartPageWithToc: 2,
  entries: [{ tabNumber: 1, title: 'Scan', date: '', filename: 'scan.pdf', pageCount: 1, beginsOnPdfPage: 2, beginsOnPageOfSection: 1, actualPdfStartPageWithToc: 2 }],
}];

/** A bundle's metadata written from the config, saved, and opened again as the page opens a bundle. */
async function reopened(ocr) {
  const config = new Config();
  config.updateOptions({ ocr });
  const doc = await PDFDocument.load(await fx.makePdf(2, 'B'));
  setMetadata(doc, TOC, flattenConfig(config));
  return openBundle(await doc.save());
}

test('a bundle made with either setting on reopens with them; one made with both off carries no ocr group and reopens with both off', async () => {
  const el = stubPage();
  try {
    const { applyExtractedConfig } = await import('../public/js/frontend/bundleGeneration.js');
    const on = await reopened({ turnUpright: true, straighten: false });
    assert.deepEqual(on.config.ocr, { turnUpright: true, straighten: false });
    assert.deepEqual(sanitiseNestedConfig(on.config).ocr, { turnUpright: true, straighten: false });
    applyExtractedConfig(on.config);
    assert.equal(el('config-ocrTurnUpright').checked, true);
    assert.equal(el('config-ocrStraighten').checked, false);

    const off = await reopened({});
    assert.equal(off.config.ocr, undefined, 'no ocr group');
    el('config-ocrStraighten').checked = true;
    applyExtractedConfig(off.config);
    assert.equal(el('config-ocrTurnUpright').checked, false);
    assert.equal(el('config-ocrStraighten').checked, false, 'the bundle says off, so off');
  } finally { unstub(); }
});

test('the browser\'s manifest export carries both settings, and importing it sets them', async () => {
  const el = stubPage();
  try {
    const { gatherConfigOptions, applyExtractedConfig } = await import('../public/js/frontend/bundleGeneration.js');
    el('config-ocrTurnUpright').checked = true;
    el('config-ocrStraighten').checked = true;
    const flat = flattenManifestConfig(gatherConfigOptions());
    assert.equal(flat['ocr.turnUpright'], true);
    assert.equal(flat['ocr.straighten'], true);
    el('config-ocrTurnUpright').checked = false;
    el('config-ocrStraighten').checked = false;
    applyExtractedConfig(nestManifestConfig(JSON.parse(JSON.stringify(flat))));
    assert.equal(el('config-ocrTurnUpright').checked, true);
    assert.equal(el('config-ocrStraighten').checked, true);
  } finally { unstub(); }
});

// ── The browser's two OCR paths ───────────────────────────────────────────────────────────────────────────

test('the automatic check and Force OCR both read the settings live and pass them to the reader', async () => {
  const el = stubPage();
  try {
    const { reorientChoice, noteReoriented } = await import('../public/js/frontend/ocrReorient.js');
    assert.deepEqual(reorientChoice(), { turnUpright: false, straighten: false, keepAsScanned: [] });
    el('config-ocrStraighten').checked = true;
    assert.deepEqual(reorientChoice(), { turnUpright: false, straighten: true, keepAsScanned: [] });
    const { state } = await import('../public/js/frontend/state.js');
    state.frontendInputData['a.pdf'] = { title: 'A' };
    noteReoriented('a.pdf', { turned: [], straightened: [], notStraightened: [], sideways: [[2, 90]] });
    assert.equal(state.frontendInputData['a.pdf'].pagesChanged, undefined, 'a note alone changes no page');
    noteReoriented('a.pdf', { turned: [[1, 270]], straightened: [], notStraightened: [], sideways: [] });
    assert.equal(state.frontendInputData['a.pdf'].pagesChanged, true, 'the document window\'s own changed flag');
    assert.deepEqual(state.frontendInputData['a.pdf'].ocrPages.turned, [[1, 270]]);
    delete state.frontendInputData['a.pdf'];
  } finally { unstub(); }
  for (const file of ['public/js/frontend/ocrAuto.js', 'public/js/frontend/ocrForce.js']) {
    const code = read(file);
    assert.match(code, /(ocrDocument|ocr)\(bytes, \{[^}]*reorient: reorientChoice\(filename\)/, file);
    assert.match(code, /noteReoriented\(filename, result\.reoriented\)/, file);
  }
});

// ── The command line ──────────────────────────────────────────────────────────────────────────────────────

const CLI = path.join(here, '..', 'scripts', 'build-cli.mjs');
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

test('--config-keys, --help settings and the schema describe both settings, off by default', () => {
  const keys = cli(['--json', '--config-keys']).json.configKeys;
  assert.equal(keys['ocr.turnUpright'], false);
  assert.equal(keys['ocr.straighten'], false);
  const help = cli(['--help', 'settings']).stdout;
  assert.match(help, /ocr\.turnUpright/);
  assert.match(help, /ocr\.straighten/);
  const schema = JSON.parse(read('manifest.schema.json')).properties.config.description;
  assert.match(schema, /ocr\.turnUpright and ocr\.straighten \(true or false, both false by default\)/);
  assert.match(cli(['--help', 'errors']).stdout, /ocr_not_straightened/);
  assert.match(read('README.md'), /\| `ocr\.turnUpright` \| true or false \| `false` \|/);
  assert.match(read('README.md'), /\| `ocr\.straighten` \| true or false \| `false` \|/);
});

async function build(dir, files, config) {
  const docs = path.join(dir, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(docs, name), bytes);
  const manifest = {
    schemaVersion: 1,
    config: { 'heading.bundleTitle': 'T', 'heading.projectName': 'R', 'heading.claimNumber': 'C', ...config },
    sections: [{ sectionLabel: 'A', sectionName: 'Docs', files: Object.keys(files).map((filename) => ({ filename, title: filename })) }],
  };
  fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify(manifest));
  const out = path.join(dir, 'out.pdf');
  return { r: cli(['--json', path.join(dir, 'm.json'), docs, out]), out };
}

test('the command line refuses a setting that is not true or false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btocrset-'));
  try {
    const { r } = await build(dir, { 'a.pdf': await fx.makePdf(1, 'A') }, { 'ocr.straighten': 'yes', 'ocr.mode': 'off' });
    assert.equal(r.status, 3);
    assert.equal(r.json.error.code, 'invalid_config');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the command line turns a sideways scan upright, straightens a tilted one, and warns for a tilted page with a link', async (t) => {
  if (!(await loadOcrRuntime()).available) return t.skip('@napi-rs/canvas / tesseract-wasm not available on this machine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btocrset-'));
  try {
    const files = {
      'side.pdf': await scanPdf(scanCanvas({ turn: 90 })),
      'tilt.pdf': await scanPdf(scanCanvas({ tilt: 6 })),
      'linked.pdf': await scanPdf(scanCanvas({ tilt: 6 }), { link: true }),
    };
    const off = await build(path.join(dir, 'off'), files, {});
    assert.equal(off.r.status, 0, off.r.stderr);
    assert.deepEqual(off.r.json.warnings, []);
    const on = await build(path.join(dir, 'on'), files, { 'ocr.turnUpright': true, 'ocr.straighten': true });
    assert.equal(on.r.status, 0, on.r.stderr);
    assert.deepEqual(on.r.json.warnings.map((w) => [w.code, w.file, w.page]), [['ocr_not_straightened', 'linked.pdf', 1]]);
    // The bundle's pages after the index: the sideways scan now carries /Rotate 90, the others none; only the
    // straightened scan's content gained a rotation.
    const pages = async (file) => (await PDFDocument.load(fs.readFileSync(file))).getPages();
    const [offPages, onPages] = [await pages(off.out), await pages(on.out)];
    assert.equal(onPages.length, offPages.length);
    const docs = onPages.slice(-3);
    assert.deepEqual(docs.map((p) => p.getRotation().angle), [90, 0, 0]);
    assert.deepEqual(offPages.slice(-3).map((p) => p.getRotation().angle), [0, 0, 0]);
    const reopenedConfig = (await openBundle(new Uint8Array(fs.readFileSync(on.out)))).config;
    assert.deepEqual(reopenedConfig.ocr, { turnUpright: true, straighten: true }, 'the bundle remembers the settings');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
