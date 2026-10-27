/**
 * Just assemble: three independent switches, each off by default (pageOptions.leaveOutIndex,
 * leaveOutPageNumbers, leaveOutBookmarks), and the browser's Just This Once. The option wiring, the
 * numbering rule (no index: the first document page is page 1, a cover unnumbered), real builds through
 * the shipped engine and through the command line, and the settings round trips.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from './fixtures.mjs';
import { PDFDocument, PDFName } from '../public/js/bundletoolPdfLib.js';
import Config from '../public/js/bundletoolConfig.js';
import { IndexData } from '../public/js/bundletoolIndexData.js';
import { createTocEntries, makeDummyTocPages, makeTocPages, indexLeftOut, setPhysicalStartPages } from '../public/js/bundletoolToc.js';
import { buildPageLabels, flattenFooterConfig, buildFooterTexts } from '../public/js/bundletoolPages.js';
import { flattenConfig, buildOutlineTree, buildBundleIndexPayload, setMetadata } from '../public/js/bundletoolMeta.js';
import { readOutline } from '../public/js/bundletoolOutline.js';
import { buildBundlePdf } from '../public/js/bundletoolBuild.js';
import { openBundle } from '../public/js/bundletoolRestore.js';
import { describePartPages } from '../public/js/bundletoolSplit.js';
import { sanitiseConfig, sanitiseNestedConfig, DEFAULTS_KEYS } from '../public/js/frontend/configSanitise.js';
import { encodeSettingsCode, decodeSettingsCode } from '../public/js/frontend/settingsCode.js';
import { flattenManifestConfig, nestManifestConfig } from '../public/js/manifestSchema.js';
import { resetJustAssembleAfterBuild, JUST_ASSEMBLE_IDS, ONCE_ID, BACK_OFF_NOTICE } from '../public/js/frontend/justAssemble.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');
const KEYS = ['leaveOutIndex', 'leaveOutPageNumbers', 'leaveOutBookmarks'];
const TOC_OPTIONS = {
  font: { family: 'helvetica', sizeTitle: 18, sizeProject: 14, sizeTable: 11 },
  color: { headerFill: [200, 200, 200] },
  table: { showBorders: true, cellPadding: 2, lineHeight: 1.3 },
  margins: { top: 25, right: 22, bottom: 25, left: 22 },
};

/** The page text pdf.js reads off each page, in order. */
async function pageTexts(bytes) {
  const pdfjsLib = await import('/vendor/pdfjs.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str).join(' '));
  await doc.destroy();
  return out;
}

/**
 * A build through the shipped engine, in the order bundletoolMain.js and build-cli.mjs run it: indexLeftOut()
 * decides, then either no index (setPhysicalStartPages) or the index is drawn.
 */
async function build({ docs, sections = null, options = {}, cover = false }) {
  const config = new Config();
  config.updateOptions({
    heading: { bundleTitle: 'Test bundle', projectName: 'Re: T', claimNumber: 'ZC1', author: 'A. Solicitor' },
    pageOptions: { coversheet: cover, coverSource: cover ? 'uploaded' : 'none' },
    ...options,
  });
  const files = [];
  for (const [i, d] of docs.entries()) files.push({ filename: `doc${i + 1}.pdf`, title: `Document ${i + 1}`, date: '', pageCount: (await PDFDocument.load(d)).getPageCount(), bytes: d });
  const indexData = new IndexData(sections ?? [{ sectionID: '0000', sectionLabel: '', sectionName: '', files: files.map(({ bytes, ...f }) => f) }]);
  indexData.validateIndexStructure();
  config.validateStructure();
  config.validateOptions();
  const noIndex = indexLeftOut(config);
  const tocEntries = await createTocEntries(indexData, config);
  let tocPdf = null; let rows = []; let tocLength = 0;
  if (noIndex) setPhysicalStartPages(tocEntries, 0);
  else {
    tocLength = await makeDummyTocPages(tocEntries, TOC_OPTIONS, config);
    [tocPdf, rows] = await makeTocPages(tocEntries, TOC_OPTIONS, config, tocLength);
  }
  const bytes = await buildBundlePdf({
    coverBytes: cover ? await fx.makePdf(1, 'COVER') : null,
    tocBytes: tocPdf,
    fileEntries: files.map((f) => ({ filename: f.filename, buffer: f.bytes })),
    printable: false, pageSize: 'a4',
    footerConfig: flattenFooterConfig(config),
    pageLabels: buildPageLabels(tocEntries, false),
    frontMatterCount: (cover ? 1 : 0) + tocLength,
    footerLinkPageIndex: cover ? 1 : 0,
    metaConfig: flattenConfig(config),
    tocTableRowCoordinates: rows,
    tocEntries,
  });
  return { bytes, tocLength, config };
}

// ── The settings ────────────────────────────────────────────────────────────────────────────────────────

test('the three switches default to off, are checked like every other setting and travel in both flattened configs', () => {
  const config = new Config();
  for (const k of KEYS) assert.equal(config.getOption(`pageOptions.${k}`), false, k);
  config.validateStructure();
  config.validateOptions();
  for (const k of KEYS) {
    assert.equal(flattenConfig(config)[`pageOptions.${k}`], false);
    const bad = new Config();
    bad.updateOptions({ pageOptions: { [k]: 'yes' } });
    assert.throws(() => bad.validateOptions(), /leave out/);
  }
  assert.ok('pageOptions.leaveOutPageNumbers' in flattenFooterConfig(config));
});

test('indexLeftOut: off by default; on, it numbers the front matter "skip" for that build; Preview Index wins', () => {
  const plain = new Config();
  assert.equal(indexLeftOut(plain), false);
  assert.equal(plain.getOption('pageNumbering.frontMatterNumbering'), 'continuous');
  for (const chosen of ['continuous', 'roman', 'skip']) {
    const c = new Config();
    c.updateOptions({ pageOptions: { leaveOutIndex: true }, pageNumbering: { frontMatterNumbering: chosen } });
    assert.equal(indexLeftOut(c), true);
    assert.equal(c.getOption('pageNumbering.frontMatterNumbering'), 'skip');
  }
  const preview = new Config();
  preview.updateOptions({ pageOptions: { leaveOutIndex: true }, index: { justTheIndex: true } });
  assert.equal(indexLeftOut(preview), false, 'Preview Index still makes the index');
  assert.equal(preview.getOption('pageNumbering.frontMatterNumbering'), 'continuous');
});

test('no index: documents start on page 1, or page 2 behind a cover, and the footers count from the first document page', async () => {
  for (const cover of [false, true]) {
    const c = new Config();
    c.updateOptions({ pageOptions: { leaveOutIndex: true, coversheet: cover } });
    indexLeftOut(c);
    const toc = await createTocEntries(new IndexData([{ sectionID: '0001', sectionLabel: 'A', sectionName: 'S', files: [
      { filename: 'a.pdf', title: 'A', date: '', pageCount: 2 }, { filename: 'b.pdf', title: 'B', date: '', pageCount: 3 }] }]), c);
    setPhysicalStartPages(toc, 0);
    const front = cover ? 1 : 0;
    assert.deepEqual(toc[0].entries.map((e) => e.actualPdfStartPageWithToc), [1 + front, 3 + front]);
    const { texts } = buildFooterTexts(flattenFooterConfig(c), [], front + 5, front);
    assert.deepEqual(texts, [...(cover ? [''] : []), 'Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5']);
  }
});

test('bookmarks: no Index entry with the index left out, and a bookmark page matches the printed number', () => {
  const toc = [{ sectionID: '0000', entries: [
    { tabNumber: 1, title: 'A', date: '', beginsOnPdfPage: 2, actualPdfStartPageWithToc: 2, beginsOnPageOfSection: 1 },
    { tabNumber: 2, title: 'B', date: '', beginsOnPdfPage: 4, actualPdfStartPageWithToc: 4, beginsOnPageOfSection: 3 }] }];
  const cv = { 'index.outlineItemStyle': 'withPage', 'pageOptions.leaveOutIndex': true, 'pageNumbering.frontMatterNumbering': 'skip' };
  const items = buildOutlineTree(toc, cv, 1);
  assert.deepEqual(items.map((i) => i.title), ['[1] A - pg. 1', '[2] B - pg. 3']);
  assert.deepEqual(items.map((i) => i.pageIndex), [1, 3]);
  const withIndex = buildOutlineTree(toc, { 'index.outlineItemStyle': 'withPage' }, 0);
  assert.equal(withIndex[0].title, '[0] Index');
  assert.equal(withIndex[1].title, '[1] A - pg. 2', 'continuous numbering: the physical page, as before');
});

test('the bundle remembers all three in its embedded config; one made before they existed reopens with them off', async () => {
  const c = new Config();
  c.updateOptions({ pageOptions: { leaveOutIndex: true, leaveOutPageNumbers: true, leaveOutBookmarks: true } });
  const payload = buildBundleIndexPayload([], flattenConfig(c));
  for (const k of KEYS) assert.equal(payload.config.pageOptions[k], true);
  const doc = await PDFDocument.load(await fx.makePdf(2, 'B'));
  setMetadata(doc, [{ sectionID: '0000', entries: [{ tabNumber: 1, title: 'A', date: '', filename: 'a.pdf', pageCount: 2, beginsOnPdfPage: 1, actualPdfStartPageWithToc: 1 }] }], flattenConfig(c));
  const opened = await openBundle(await doc.save());
  const nested = sanitiseNestedConfig(opened.config);
  for (const k of KEYS) assert.equal(nested.pageOptions[k], true);
  const older = sanitiseNestedConfig({ pageOptions: { printableBundle: false } });
  for (const k of KEYS) assert.equal(older.pageOptions[k], undefined, 'absent, so the page leaves the switch off');
});

test('the email splitter reads a bundle with its page numbers left out as one with none printed', () => {
  const payload = { config: { pageNumbering: { numberingStyle: 'PageX' }, pageOptions: { leaveOutPageNumbers: true } }, sections: [{ files: [{ page: 1 }] }] };
  assert.equal(describePartPages(payload, 1, 4, 10).printed, false);
  delete payload.config.pageOptions.leaveOutPageNumbers;
  assert.equal(describePartPages(payload, 1, 4, 10).printed, true);
});

test('saved settings, share links and QR codes keep all four; older saved settings load with them off', async () => {
  for (const k of [...KEYS, 'justAssembleOnce']) {
    assert.ok(DEFAULTS_KEYS.includes(k), k);
    assert.deepEqual(sanitiseConfig({ [k]: true }, { only: DEFAULTS_KEYS }), { [k]: true });
    assert.deepEqual(sanitiseConfig({ [k]: 'true' }, { only: DEFAULTS_KEYS }), {});
  }
  const all = { leaveOutIndex: true, leaveOutPageNumbers: false, leaveOutBookmarks: true, justAssembleOnce: true };
  assert.deepEqual(await decodeSettingsCode(await encodeSettingsCode(all)), all);
  assert.deepEqual(sanitiseConfig({ fontFace: 'serif' }, { only: DEFAULTS_KEYS }), { fontFace: 'serif' }, 'nothing invented for an older setting');
  const page = read('public/js/bundletoolPage.js');
  assert.match(page, /FACTORY = \{[\s\S]*leaveOutIndex: false, leaveOutPageNumbers: false, leaveOutBookmarks: false, justAssembleOnce: false/);
  for (const k of [...KEYS, 'justAssembleOnce']) assert.match(page, new RegExp(`${k}: document\\.getElementById\\('config-${k}'\\)\\?\\.checked === true`));
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

test('autosave, manifest export and import, and a reopened bundle all carry the three switches', async () => {
  const el = stubPage();
  try {
    const { collectFormConfig, applyFormConfig } = await import('../public/js/frontend/autosave.js');
    const { gatherConfigOptions, applyExtractedConfig } = await import('../public/js/frontend/bundleGeneration.js');
    for (const k of [...KEYS, 'justAssembleOnce']) el(`config-${k}`).checked = true;
    const snap = JSON.parse(JSON.stringify(collectFormConfig()));
    for (const k of [...KEYS, 'justAssembleOnce']) assert.equal(snap[k], true);
    for (const k of [...KEYS, 'justAssembleOnce']) el(`config-${k}`).checked = false;
    applyFormConfig(snap);
    for (const k of [...KEYS, 'justAssembleOnce']) assert.equal(el(`config-${k}`).checked, true, k);
    // An older snapshot, without them: all off.
    const older = { ...snap }; for (const k of [...KEYS, 'justAssembleOnce']) delete older[k];
    applyFormConfig(older);
    for (const k of [...KEYS, 'justAssembleOnce']) assert.equal(el(`config-${k}`).checked, false, k);

    el('config-leaveOutIndex').checked = true;
    el('config-leaveOutBookmarks').checked = true;
    const flat = flattenManifestConfig(gatherConfigOptions());
    assert.equal(flat['pageOptions.leaveOutIndex'], true);
    assert.equal(flat['pageOptions.leaveOutPageNumbers'], false);
    assert.equal(flat['pageOptions.leaveOutBookmarks'], true);
    assert.equal(flat['pageNumbering.numberingStyle'] !== 'None', true, 'the numbering style is never touched');
    for (const k of KEYS) el(`config-${k}`).checked = false;
    applyExtractedConfig(nestManifestConfig(JSON.parse(JSON.stringify(flat))));
    assert.deepEqual(KEYS.map((k) => el(`config-${k}`).checked), [true, false, true]);
    applyExtractedConfig({ pageOptions: {} });
    assert.deepEqual(KEYS.map((k) => el(`config-${k}`).checked), [false, false, false], 'an older bundle: all off');
  } finally { unstub(); }
});

// ── Just This Once ──────────────────────────────────────────────────────────────────────────────────────

function fakeSwitches(on, once) {
  const els = Object.fromEntries([...JUST_ASSEMBLE_IDS, ONCE_ID].map((id) => [id, { checked: id === ONCE_ID ? once : on }]));
  return { els, doc: { getElementById: (id) => els[id] ?? null } };
}

test('Just This Once: after a bundle is made, all four go back to off, are saved and a notice says so', () => {
  const { els, doc } = fakeSwitches(true, true);
  let saved = 0; let said = '';
  assert.equal(resetJustAssembleAfterBuild(doc, { save: () => { saved++; }, notify: (m) => { said = m; } }), true);
  assert.ok(Object.values(els).every((e) => e.checked === false));
  assert.equal(saved, 1);
  assert.equal(said, BACK_OFF_NOTICE);
  assert.equal(BACK_OFF_NOTICE, 'Just assemble is back off, so the next bundle is normal.');
});

test('Just This Once off: the switches stay on after a bundle, and nothing is saved or said', () => {
  const { els, doc } = fakeSwitches(true, false);
  let calls = 0;
  assert.equal(resetJustAssembleAfterBuild(doc, { save: () => { calls++; }, notify: () => { calls++; } }), false);
  assert.ok(JUST_ASSEMBLE_IDS.every((id) => els[id].checked === true));
  assert.equal(calls, 0);
});

test('Just This Once is reset only on the bundle-ready path: not by a failed or cancelled build, Preview Index or the bundle preview', () => {
  const code = read('public/js/frontend/bundleGeneration.js');
  assert.equal(code.match(/resetJustAssembleAfterBuild\(/g).length, 1, 'one call');
  const at = code.indexOf('resetJustAssembleAfterBuild(document');
  const readyAt = code.lastIndexOf('showBundleReadyState(pdfBytes, bundleFilename);', at);
  const previewAt = code.lastIndexOf('openBundlePreview(pdfBytes, bundleFilename);', at);
  const catchAt = code.indexOf('} catch (error) {', at);
  assert.ok(readyAt > previewAt && readyAt < at, 'after "Bundle ready!", in the else branch, not the bundle preview');
  assert.ok(catchAt > at && !code.slice(at, catchAt).includes('catch'), 'before the catch: a failed or cancelled build never reaches it');
  assert.ok(!code.slice(code.indexOf('export async function runPreviewIndex'), code.indexOf('function cleanOverride')).includes('resetJustAssemble'), 'not Preview Index');
  assert.match(code.slice(at, catchAt), /window\.saveDefaultConfig\?\.\(\); markDirty\(\);/, 'the off state is saved, so a reload keeps it');
});

test('after a reset, a reload brings back the off state (saved settings and the autosave snapshot both say off)', async () => {
  const el = stubPage();
  try {
    const { collectFormConfig, applyFormConfig } = await import('../public/js/frontend/autosave.js');
    for (const id of [...JUST_ASSEMBLE_IDS, ONCE_ID]) el(id).checked = true;
    let snap = null;
    resetJustAssembleAfterBuild(globalThis.document, { save: () => { snap = JSON.parse(JSON.stringify(collectFormConfig())); } });
    // "Reload": the page starts with whatever, then the saved snapshot is applied.
    for (const id of [...JUST_ASSEMBLE_IDS, ONCE_ID]) el(id).checked = true;
    applyFormConfig(snap);
    for (const id of [...JUST_ASSEMBLE_IDS, ONCE_ID]) assert.equal(el(id).checked, false, id);
    assert.deepEqual(sanitiseConfig(snap, { only: DEFAULTS_KEYS }).justAssembleOnce, false);
  } finally { unstub(); }
});

test('Advanced Settings has a Just Assemble panel with the four switches, each off, each with its own icon, before Index Options', () => {
  const html = read('layouts/partials/bundletool.html');
  const panel = html.slice(html.indexOf('Just Assemble</h4>'), html.indexOf('<!-- Index Options -->'));
  assert.ok(panel.length > 0 && html.indexOf('Just Assemble</h4>') < html.indexOf('Index Options</h3>'));
  const icons = [];
  for (const [id, label] of [['leaveOutIndex', 'Leave Out Index'], ['leaveOutPageNumbers', 'Leave Out Page Numbers'], ['leaveOutBookmarks', 'Leave Out Bookmarks'], ['justAssembleOnce', 'Just This Once']]) {
    const input = panel.match(new RegExp(`<input[^>]*id="config-${id}"[^>]*>`))?.[0];
    assert.ok(input, id);
    assert.doesNotMatch(input, /\bchecked\b/, `${id} is off by default`);
    assert.match(input, new RegExp(`aria-label="${label}"`));
    const before = panel.slice(0, panel.indexOf(input));
    icons.push(before.slice(before.lastIndexOf('"name" "') + 8).split('"')[0]);
  }
  assert.equal(new Set(icons).size, 4, 'four different icons');
  assert.match(panel, /exactly your pages/);
  assert.doesNotMatch(panel, /disabled/, 'nothing is greyed out');
});

// ── Real builds ─────────────────────────────────────────────────────────────────────────────────────────

test('real build, all three on: three sample PDFs come out as exactly their pages, with no footer and no bookmarks', async () => {
  const docs = [await fx.makePdf(2, 'ALPHA'), await fx.makePdf(3, 'BRAVO'), await fx.makePdf(1, 'CHARLIE')];
  const { bytes, tocLength } = await build({ docs, options: { pageOptions: { leaveOutIndex: true, leaveOutPageNumbers: true, leaveOutBookmarks: true } } });
  assert.equal(tocLength, 0);
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 6);
  assert.equal(out.catalog.get(PDFName.of('Outlines')), undefined, 'no outline at all');
  const texts = await pageTexts(bytes);
  assert.ok(texts[0].includes('ALPHA') && texts[2].includes('BRAVO') && texts[5].includes('CHARLIE'), 'in order');
  assert.ok(texts.every((t) => !/Page \d/.test(t)), 'no page numbers');
});

test('real build, index left out alone: no index page, footers from Page 1, bookmarks to the right pages, no Index bookmark', async () => {
  const docs = [await fx.makePdf(2, 'ALPHA'), await fx.makePdf(3, 'BRAVO')];
  const { bytes } = await build({ docs, options: { pageOptions: { leaveOutIndex: true } } });
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 5);
  const texts = await pageTexts(bytes);
  for (let i = 0; i < 5; i++) assert.match(texts[i], new RegExp(`Page ${i + 1}\\b`));
  assert.ok(texts[0].includes('ALPHA') && texts[2].includes('BRAVO'));
  const outline = readOutline(out);
  assert.deepEqual(outline.map((o) => o.pageIndex), [0, 2]);
  assert.ok(outline.every((o) => !/Index/.test(o.title)));
});

test('real build with a cover and the index left out: the cover is unnumbered and the first document page is Page 1', async () => {
  const docs = [await fx.makePdf(2, 'ALPHA'), await fx.makePdf(1, 'BRAVO')];
  const { bytes } = await build({ docs, cover: true, options: { pageOptions: { leaveOutIndex: true }, pageNumbering: { frontMatterNumbering: 'continuous' } } });
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 4);
  const texts = await pageTexts(bytes);
  assert.doesNotMatch(texts[0], /Page \d/);
  assert.match(texts[1], /Page 1\b/);
  assert.match(texts[3], /Page 3\b/);
});

test('real build, page numbers and bookmarks left out with the index kept: the index is there, nothing else is added', async () => {
  const docs = [await fx.makePdf(2, 'ALPHA'), await fx.makePdf(1, 'BRAVO')];
  const { bytes, tocLength, config } = await build({ docs, options: { pageOptions: { leaveOutPageNumbers: true, leaveOutBookmarks: true } } });
  assert.equal(tocLength, 1);
  assert.equal(config.getOption('pageNumbering.numberingStyle'), 'PageX', 'the style is kept');
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 4);
  assert.equal(out.catalog.get(PDFName.of('Outlines')), undefined);
  assert.ok((await pageTexts(bytes)).every((t) => !/Page \d/.test(t)));
});

test('everything off (the default): the bundle is as before, index, footers and an Index bookmark', async () => {
  const docs = [await fx.makePdf(2, 'ALPHA')];
  const { bytes, tocLength } = await build({ docs });
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 2 + tocLength);
  assert.match(readOutline(out)[0].title, /Index/);
  assert.match((await pageTexts(bytes))[0], /Page 1\b/);
});

// ── The command line ────────────────────────────────────────────────────────────────────────────────────

const CLI = path.join(here, '..', 'scripts', 'build-cli.mjs');
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

test('command line: photos and PDFs with --no-index --no-page-numbers --no-bookmarks give exactly the input pages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btassemble-'));
  try {
    const docs = path.join(dir, 'docs');
    fs.mkdirSync(docs);
    fs.copyFileSync(path.join(here, 'fixtures', 'photo', 'plain.jpg'), path.join(docs, 'photo-1.jpg'));
    fs.copyFileSync(path.join(here, 'fixtures', 'photo', 'upright.png'), path.join(docs, 'photo-2.png'));
    fs.copyFileSync(path.join(here, 'fixtures', 'photo', 'orientation-6.jpg'), path.join(docs, 'photo-3.jpg'));
    fs.writeFileSync(path.join(docs, 'notes.pdf'), await fx.makePdf(2, 'NOTES'));
    fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ schemaVersion: 1, config: { 'ocr.mode': 'off' },
      sections: [{ files: [{ filename: 'photo-1.jpg' }, { filename: 'photo-2.png' }, { filename: 'photo-3.jpg' }, { filename: 'notes.pdf' }] }] }));
    const r = cli(['--json', '--no-index', '--no-page-numbers', '--no-bookmarks', path.join(dir, 'm.json'), docs, path.join(dir, 'out.pdf')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json.pages, { total: 5, cover: 0, index: 0, source: 5 });
    const bytes = fs.readFileSync(path.join(dir, 'out.pdf'));
    const out = await PDFDocument.load(bytes);
    assert.equal(out.getPageCount(), 5);
    assert.equal(out.catalog.get(PDFName.of('Outlines')), undefined);
    assert.ok((await pageTexts(bytes)).every((t) => !/Page \d/.test(t)));
    const cfg = (await openBundle(new Uint8Array(bytes))).config.pageOptions;
    assert.deepEqual([cfg.leaveOutIndex, cfg.leaveOutPageNumbers, cfg.leaveOutBookmarks], [true, true, true]);

    // The same through the config keys, one switch only: the index goes, the footers stay.
    fs.writeFileSync(path.join(dir, 'k.json'), JSON.stringify({ schemaVersion: 1, config: { 'ocr.mode': 'off', 'pageOptions.leaveOutIndex': true },
      sections: [{ files: [{ filename: 'notes.pdf' }] }] }));
    const k = cli(['--json', path.join(dir, 'k.json'), docs, path.join(dir, 'k.pdf')]);
    assert.equal(k.status, 0, k.stdout + k.stderr);
    assert.equal(k.json.pages.index, 0);
    const kt = await pageTexts(fs.readFileSync(path.join(dir, 'k.pdf')));
    assert.equal(kt.length, 2);
    assert.match(kt[0], /Page 1\b/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('command line: the help, --config-keys, the schema and the README describe all three, off by default', () => {
  const keys = cli(['--json', '--config-keys']).json.configKeys;
  for (const k of KEYS) assert.equal(keys[`pageOptions.${k}`], false);
  const help = cli(['--help']).stdout;
  for (const f of ['--no-index', '--no-page-numbers', '--no-bookmarks']) assert.ok(help.includes(f), f);
  assert.match(cli(['--help', 'settings']).stdout, /pageOptions\.leaveOutBookmarks/);
  assert.match(JSON.parse(read('manifest.schema.json')).properties.config.description, /all three true give exactly the input pages/);
  for (const k of KEYS) assert.match(read('README.md'), new RegExp(`\\| \`pageOptions\\.${k}\` \\| true or false \\| \`false\` \\|`));
  assert.match(read('layouts/_default/guide.html'), /id="just-assemble"[^>]*>Just assemble</);
});
