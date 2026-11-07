/**
 * Just assemble: the engine keys pageOptions.leaveOutIndex, leaveOutPageNumbers and leaveOutBookmarks (each off
 * by default, also the command line's --no-index, --no-page-numbers and --no-bookmarks) and the browser's one
 * Just Assemble button, which has no settings. The option wiring, the numbering rule (no index: the first
 * document page is page 1, a cover unnumbered), real builds through the shipped engine and through the command
 * line, and the button.
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
import { JUST_ASSEMBLE_OPTIONS, assembledFilename } from '../public/js/frontend/justAssemble.js';

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

test('the bundle remembers all three in its embedded config, and the page does not take them back as settings', async () => {
  const c = new Config();
  c.updateOptions({ pageOptions: { leaveOutIndex: true, leaveOutPageNumbers: true, leaveOutBookmarks: true } });
  const payload = buildBundleIndexPayload([], flattenConfig(c));
  for (const k of KEYS) assert.equal(payload.config.pageOptions[k], true);
  const doc = await PDFDocument.load(await fx.makePdf(2, 'B'));
  setMetadata(doc, [{ sectionID: '0000', entries: [{ tabNumber: 1, title: 'A', date: '', filename: 'a.pdf', pageCount: 2, beginsOnPdfPage: 1, actualPdfStartPageWithToc: 1 }] }], flattenConfig(c));
  const opened = await openBundle(await doc.save());
  for (const k of KEYS) assert.equal(opened.config.pageOptions[k], true, 'the reopened bundle still reads them (the command line and --unpack use them)');
  const nested = sanitiseNestedConfig(opened.config);
  for (const k of KEYS) assert.equal(nested.pageOptions[k], undefined, 'the page has no switch for them, so it never takes them');
});

test('the email splitter reads a bundle with its page numbers left out as one with none printed', () => {
  const payload = { config: { pageNumbering: { numberingStyle: 'PageX' }, pageOptions: { leaveOutPageNumbers: true } }, sections: [{ files: [{ page: 1 }] }] };
  assert.equal(describePartPages(payload, 1, 4, 10).printed, false);
  delete payload.config.pageOptions.leaveOutPageNumbers;
  assert.equal(describePartPages(payload, 1, 4, 10).printed, true);
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

// ── The button ──────────────────────────────────────────────────────────────────────────────────────────

test('Just Assemble is not a setting: saved settings, share codes and the autosave carry none of the three', async () => {
  for (const k of [...KEYS, 'justAssembleOnce']) {
    assert.ok(!DEFAULTS_KEYS.includes(k), `${k} is not a saved setting`);
    assert.deepEqual(sanitiseConfig({ [k]: true }, { only: DEFAULTS_KEYS }), {}, `an older saved ${k} is dropped`);
  }
  assert.deepEqual(await decodeSettingsCode(await encodeSettingsCode({ fontFace: 'serif' })), { fontFace: 'serif' });
  const el = stubPage();
  try {
    const { collectFormConfig } = await import('../public/js/frontend/autosave.js');
    for (const k of [...KEYS, 'justAssembleOnce']) el(`config-${k}`).checked = true;
    const snap = JSON.parse(JSON.stringify(collectFormConfig()));
    for (const k of [...KEYS, 'justAssembleOnce']) assert.ok(!(k in snap), `${k} is not autosaved`);
  } finally { unstub(); }
});

test('Create Bundle and Preview Index never leave anything out, whatever an old page or bundle said', async () => {
  const el = stubPage();
  try {
    const { gatherConfigOptions, applyExtractedConfig } = await import('../public/js/frontend/bundleGeneration.js');
    for (const k of KEYS) el(`config-${k}`).checked = true;
    const flat = flattenManifestConfig(gatherConfigOptions());
    for (const k of KEYS) assert.equal(flat[`pageOptions.${k}`], false, k);
    assert.equal(flat['pageNumbering.numberingStyle'] !== 'None', true, 'the numbering style is never touched');
    // A bundle made with them on reopens as a normal one: there is no switch to carry them.
    applyExtractedConfig({ pageOptions: { leaveOutIndex: true, leaveOutPageNumbers: true, leaveOutBookmarks: true } });
    for (const k of KEYS) assert.equal(flattenManifestConfig(gatherConfigOptions())[`pageOptions.${k}`], false, k);
  } finally { unstub(); }
});

test('the button: one Just Assemble beside Create Bundle and Preview Index, and no panel or switch in Advanced Settings', () => {
  const html = read('layouts/partials/bundletool.html');
  const step4 = html.slice(html.indexOf('id="step-4-choice"'), html.indexOf('<!-- Step 5: Advanced Settings -->'));
  assert.ok(step4.indexOf('id="create-bundle-btn"') < step4.indexOf('id="preview-index-btn"') && step4.indexOf('id="preview-index-btn"') < step4.indexOf('id="just-assemble-btn"'));
  const btn = step4.match(/<button[^>]*id="just-assemble-btn"[^>]*>/)[0];
  assert.match(btn, /btn-needs-docs/, 'inactive until there are documents, like the other two');
  assert.match(step4, /Just Assemble\s*<\/button>/);
  assert.doesNotMatch(html, /config-leaveOut|config-justAssembleOnce|Just This Once|Just Assemble<\/h4>/);
  const gen = read('public/js/frontend/bundleGeneration.js');
  assert.match(gen, /getElementById\('just-assemble-btn'\)\?\.addEventListener\('click', \(\) => runJustAssemble\(\)\)/);
});

test('a Just Assemble run turns all three on, shows the same Save and Preview panel, and puts the three back off', () => {
  assert.deepEqual({ ...JUST_ASSEMBLE_OPTIONS }, { leaveOutIndex: true, leaveOutPageNumbers: true, leaveOutBookmarks: true });
  const gen = read('public/js/frontend/bundleGeneration.js');
  const run = gen.slice(gen.indexOf('export async function runJustAssemble'), gen.indexOf('export function setup'));
  assert.match(run, /\.\.\.JUST_ASSEMBLE_OPTIONS/);
  assert.match(run, /generateCover: false, coversheet: false, printableBundle: false, watermark: false, watermarkText: ''/, 'no cover, watermark or blank pages added');
  assert.match(run, /assembleIndexData, state\.config, onProgress, null\)/, 'no coversheet file is handed to the build');
  assert.match(run, /showBundleReadyState\(pdfBytes, assembledFilename\(/);
  assert.match(run, /finally \{[\s\S]*leaveOutIndex: false, leaveOutPageNumbers: false, leaveOutBookmarks: false/);
  assert.ok(!/confirmMissingInfo|confirmStructureWarning|confirmUnnamedSections/.test(run), 'no case-detail questions: nothing is drawn from them');
  assert.ok(!/saveFinishedBundle|markBuildStarted/.test(run), 'it is not a bundle, so it is not kept as the last bundle');
});

test('an assembled PDF is named for the bundle title when there is one, and the date', () => {
  assert.equal(assembledFilename('Hearing on 4 Nov', '2026-11-01'), 'Hearing on 4 Nov-assembled-2026-11-01.pdf');
  assert.equal(assembledFilename('', '2026-11-01'), 'assembled-2026-11-01.pdf');
  assert.equal(assembledFilename('A/B: C.D', '2026-11-01'), 'A-B- C-D-assembled-2026-11-01.pdf');
  assert.ok(assembledFilename('x'.repeat(400), '2026-11-01').length <= 251);
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
