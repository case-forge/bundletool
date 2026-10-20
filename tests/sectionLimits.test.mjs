/**
 * A bundle holds at most MAX_SECTIONS (100) sections, and a section's label at most MAX_SECTION_LABEL_CHARS (10)
 * characters (frontend/limits.js). Add Section stops at the limit and says why; a section layout, a manifest or a
 * reopened bundle with more sections is refused whole, with nothing changed; a longer label from any of them is cut
 * to fit; and the pickers still list every section once there are 100.
 *
 * The Review Table's rows are built by frontend/sections.js with innerHTML, so the fake DOM parses markup here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, PDFName, PDFHexString } from '@cantoo/pdf-lib';
import { FakeDocument, FakeElement, templateBlock } from './fakeDom.mjs';
import { makePdf } from './fixtures.mjs';
import { MAX_SECTIONS, MAX_SECTION_LABEL_CHARS, sectionLimitProblem } from '../public/js/frontend/limits.js';
import { cleanSectionLabel } from '../public/js/frontend/sectionId.js';

const doc = new FakeDocument({ parseHtml: true });
globalThis.document = doc;
globalThis.window ??= { addEventListener() {}, requestAnimationFrame: (fn) => setTimeout(fn, 0) };
globalThis.CSS ??= { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };

const html = fs.readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../assets/css/bundletool.css', import.meta.url), 'utf8');

// The settings a manifest or a reopened bundle writes into the form: plain inputs, made when first asked for.
const fields = new Map();
const byId = doc.getElementById.bind(doc);
doc.getElementById = (id) => byId(id) ?? (/^config-/.test(id) ? (fields.get(id) ?? fields.set(id, new FakeElement(doc, 'input', id)).get(id)) : null);

/** The Review Table as the page has it: #file-table, its table, section A's tbody, and Add Section from the template. */
function freshTable() {
  doc.body.replaceChildren();
  const root = doc.body.appendChild(new FakeElement(doc, 'div', 'file-table'));
  const table = root.appendChild(new FakeElement(doc, 'table'));
  const s0 = table.appendChild(new FakeElement(doc, 'tbody', 'tbody-section-0000'));
  s0.className = 'section-tbody';
  s0.dataset.sectionId = '0000';
  const holder = doc.body.appendChild(new FakeElement(doc, 'div'));
  holder.innerHTML = templateBlock(html, 'add-section-btn');
  for (const id of ['section-picker-popover', 'upload-warning-modal']) {
    doc.body.appendChild(new FakeElement(doc, 'div')).innerHTML = templateBlock(html, id);
  }
  return table;
}

const { state } = await import('../public/js/frontend/state.js');
const sections = await import('../public/js/frontend/sections.js');
const { addSection, deleteSection, createSectionTbody, createSection0000HeaderRow, sectionCount, showSectionPicker, SECTION_LIMIT_TITLE } = sections;
const { parseManifest, importManifest, ManifestLimitError } = await import('../public/js/frontend/manifestIO.js');
const { handleBundleRestore } = await import('../public/js/frontend/bundleGeneration.js');

function reset() {
  state.isSectioned = false;
  state.nextSectionNum = 1;
  state.filesMap.clear();
  for (const k of Object.keys(state.frontendInputData)) delete state.frontendInputData[k];
  return freshTable();
}
const addButton = () => doc.getElementById('add-section-btn');
const labels = () => doc.querySelectorAll('.section-label-input');

// ── The numbers ─────────────────────────────────────────────────────────────────

test('the limits: 100 sections in a bundle, 10 characters in a label', () => {
  assert.equal(MAX_SECTIONS, 100);
  assert.equal(MAX_SECTION_LABEL_CHARS, 10);
  assert.equal(sectionLimitProblem(100), null, 'exactly the limit fits');
  const layout = sectionLimitProblem(101);
  assert.equal(layout.kind, 'warning');
  assert.equal(layout.title, 'Too many sections');
  assert.match(layout.message, /This section layout has 101 sections\. A bundle holds up to 100, so none of it was imported/);
  assert.match(sectionLimitProblem(250, 'bundle').message, /This bundle has 250 sections\. A bundle holds up to 100, so it was not opened/);
});

test('a label is cut to 10 characters, trimmed, never split inside a character, and is text or nothing', () => {
  assert.equal(cleanSectionLabel('x'.repeat(30)), 'x'.repeat(10));
  assert.equal(cleanSectionLabel('  B  '), 'B');
  assert.equal(cleanSectionLabel('ABCDEFGHI J'), 'ABCDEFGHI', 'a space left at the cut is dropped');
  assert.equal(cleanSectionLabel('ABCDEFGHI\u{1F600}'), 'ABCDEFGHI', 'an emoji that would be cut in half is left out');
  assert.equal(cleanSectionLabel('ABCDEFGH\u{1F600}'), 'ABCDEFGH\u{1F600}', 'one that fits whole is kept');
  for (const bad of [undefined, null, 5, {}, ['A']]) assert.equal(cleanSectionLabel(bad), '');
});

// ── Add Section ─────────────────────────────────────────────────────────────────

test('Add Section adds up to 100 sections, then is off with a title saying why, and adds nothing more', () => {
  reset();
  assert.match(templateBlock(html, 'add-section-btn'), /class="add-section-btn /, 'the page\'s Add Section is the button sections.js looks for');
  for (let i = 0; i < MAX_SECTIONS - 1; i++) addSection();
  assert.equal(sectionCount(), 99);
  assert.equal(addButton().disabled, false, 'on below the limit');
  assert.equal(addButton().getAttribute('title'), null);
  addSection();
  assert.equal(sectionCount(), 100);
  assert.equal(addButton().disabled, true, 'off at the limit');
  assert.equal(addButton().getAttribute('title'), SECTION_LIMIT_TITLE);
  assert.equal(SECTION_LIMIT_TITLE, 'A bundle holds up to 100 sections.');
  addSection();
  addSection();
  assert.equal(sectionCount(), 100, 'a call past the limit adds nothing');
  assert.equal(doc.querySelectorAll('.section-tbody').length, 100);
});

test('deleting a section at the limit turns Add Section back on, and adding one turns it off again', async () => {
  // Carries on from the 100 sections above.
  if (sectionCount() !== MAX_SECTIONS) { reset(); for (let i = 0; i < MAX_SECTIONS; i++) addSection(); }
  const tbodies = doc.querySelectorAll('.section-tbody');
  await deleteSection(tbodies[tbodies.length - 1]);
  assert.equal(sectionCount(), 99);
  assert.equal(addButton().disabled, false);
  assert.equal(addButton().getAttribute('title'), null, 'no title once it can be pressed');
  addSection();
  assert.equal(sectionCount(), 100);
  assert.equal(addButton().disabled, true);
});

test('with 100 sections the picker lists all of them, and "Create new section" is off with the same title', () => {
  if (sectionCount() !== MAX_SECTIONS) { reset(); for (let i = 0; i < MAX_SECTIONS; i++) addSection(); }
  showSectionPicker([]);
  const list = doc.getElementById('section-picker-list');
  const choices = list.children;
  assert.equal(choices.length, MAX_SECTIONS + 1, 'every section, then Create new section');
  assert.ok(choices.slice(0, MAX_SECTIONS).every((b) => !b.disabled), 'each section can still be picked');
  const create = choices[MAX_SECTIONS];
  assert.equal(create.textContent, '+ Create new section');
  assert.equal(create.disabled, true);
  assert.equal(create.getAttribute('title'), SECTION_LIMIT_TITLE);
  // The list scrolls inside the screen however long it is, and a choice that is off looks it.
  assert.match(templateBlock(html, 'section-picker-list'), /class="bt-picker-list /);
  assert.match(css, /\.bt-picker-list \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.bt-picker-list button:disabled \{ opacity: 0\.5; cursor: not-allowed; \}/);
  assert.match(css, /#add-section-btn:disabled \{ opacity: 0\.5; cursor: not-allowed; \}/);
});

// ── Labels ──────────────────────────────────────────────────────────────────────

test('every label box is built to hold 10 characters, both section A\'s and every other section\'s', () => {
  reset();
  addSection();
  addSection();
  addSection();
  const boxes = labels();
  assert.equal(boxes.length, 3);
  for (const box of boxes) assert.equal(box.getAttribute('maxlength'), '10');
  for (const box of doc.querySelectorAll('.section-name-input')) assert.equal(box.getAttribute('maxlength'), '500', 'names keep their limit');
  const source = fs.readFileSync(new URL('../public/js/frontend/sections.js', import.meta.url), 'utf8');
  assert.equal((source.match(/class="section-label-input"[^>]*maxlength="\$\{MAX_SECTION_LABEL_CHARS\}"/g) || []).length, 2, 'both places that build the box');
  assert.doesNotMatch(source, /section-label-input"[^>]*maxlength="500"/);
});

test('a 30-character label given to a section, or to section A, is cut to 10', () => {
  reset();
  const long = 'Applications and orders 123';
  const tbody = createSectionTbody('0007', long, 'Name kept whole, however long it runs on for');
  assert.equal(tbody.querySelector('.section-label-input').value, 'Applicatio');
  assert.equal(tbody.querySelector('.section-name-input').value, 'Name kept whole, however long it runs on for');
  const s0 = doc.getElementById('tbody-section-0000');
  createSection0000HeaderRow(s0, 'x'.repeat(30), 'First');
  assert.equal(s0.querySelector('.section-label-input').value, 'x'.repeat(10));
});

// ── Imports ─────────────────────────────────────────────────────────────────────

const layout = (n, label = (i) => String.fromCharCode(65 + (i % 26))) => ({
  sections: Array.from({ length: n }, (_, i) => ({ sectionLabel: label(i), sectionName: `Section ${i + 1}`, files: [] })),
});
const jsonFile = (obj) => new File([JSON.stringify(obj)], 'layout.json', { type: 'application/json' });

test('a section layout or manifest with 101 sections is refused whole, as a limit, and the table is left as it was', async () => {
  reset();
  addSection();
  addSection();
  const before = sectionCount();
  await assert.rejects(() => parseManifest(jsonFile(layout(101))), (error) => {
    assert.ok(error instanceof ManifestLimitError, 'a limit, shown as a warning, not a broken file');
    assert.equal(error.kind, 'warning');
    assert.equal(error.title, 'Too many sections');
    assert.match(error.message, /101 sections\. A bundle holds up to 100, so none of it was imported/);
    return true;
  });
  await assert.rejects(() => importManifest(layout(101), []), ManifestLimitError, 'importManifest refuses it too, for any other caller');
  assert.equal(sectionCount(), before, 'nothing was added or replaced');
  assert.ok(await parseManifest(jsonFile(layout(100))), 'exactly 100 is accepted');
});

test('the drop and the import button both show an over-limit layout as the limit\'s own warning', () => {
  const drop = fs.readFileSync(new URL('../public/js/frontend/fileProcessing.js', import.meta.url), 'utf8');
  assert.match(drop, /try \{[\s\S]{0,200}imported = await importManifest\(await parseManifest\(manifestFile\), pdfFiles\);\s*\} catch \(limit\) \{\s*if \(!\(limit instanceof ManifestLimitError\)\) throw limit;/);
  const button = fs.readFileSync(new URL('../public/js/frontend.js', import.meta.url), 'utf8');
  assert.match(button, /manifest = await parseManifest\(file\);\s*\} catch \(err\) \{\s*if \(!refusedForLimit\(err\)\)/);
  assert.match(button, /const refusedForLimit = \(err\) => \{\s*if \(!\(err instanceof ManifestLimitError\)\) return false;\s*showLimitNotice\(err\);/);
  assert.match(drop, /if \(!\(limit instanceof ManifestLimitError\)\) throw limit;\s*showLimitNotice\(limit\);/);
  // showLimitNotice shows the limit as the error box or the warning by its kind, with the limit's own code.
  const modals = fs.readFileSync(new URL('../public/js/frontend/modals.js', import.meta.url), 'utf8');
  assert.match(modals, /export function showLimitNotice\(\{ kind, code, title, message \}\) \{\s*if \(kind === 'error'\) showErrorModal\(\{ code, title, message \}\);\s*else showUploadWarningModal\(\{ code, title, message \}\);/);
});

/**
 * The browser tells sections.js about every change to the table through a MutationObserver (an import, a reopened
 * bundle, a saved copy, Clear All). Node has none, so this records what setup() asks to watch and delivers the change
 * the way the browser would once the import has finished.
 */
class RecordingObserver {
  static last = null;
  constructor(callback) { this.callback = callback; RecordingObserver.last = this; }
  observe(target, options) { this.target = target; this.options = options; }
  deliver() { this.callback([], this); }
}

test('a layout with 100 sections imports, its 30-character labels arrive cut to 10, and Add Section turns off', async () => {
  const table = reset();
  globalThis.MutationObserver = RecordingObserver;
  try {
    sections.setup();
  } finally {
    delete globalThis.MutationObserver;
  }
  const watcher = RecordingObserver.last;
  assert.equal(watcher.target, table, 'the Review Table is watched');
  assert.deepEqual(watcher.options, { childList: true, subtree: true }, 'sections and their header rows coming and going');
  const long = (i) => `Section label number ${String(i).padStart(3, '0')}`.padEnd(30, 'x');
  assert.equal(long(0).length, 30);
  const { added } = await importManifest(layout(100, long), []);
  assert.equal(added, 0);
  assert.equal(sectionCount(), 100);
  const values = labels().map((b) => b.value);
  assert.equal(values.length, 100);
  assert.ok(values.every((v) => v === 'Section la'), `every label cut to 10: ${values.slice(0, 3).join(', ')}`);
  watcher.deliver();
  assert.equal(addButton().disabled, true, 'Add Section is off with a full layout imported');
  assert.equal(addButton().getAttribute('title'), SECTION_LIMIT_TITLE);
});

/** A PDF carrying a v3 bundle index with `n` sections, as a bundle reopened by BundleTool would. */
async function bundleWithSections(n) {
  const pdf = await PDFDocument.load(await makePdf(1, 'BUNDLE'));
  const payload = { version: 3, config: {}, sections: Array.from({ length: n }, (_, i) => ({ sectionID: String(i + 1).padStart(4, '0'), sectionLabel: 'L', sectionName: `S${i}`, files: [] })) };
  pdf.getInfoDict().set(PDFName.of('BundleIndex'), PDFHexString.fromText(JSON.stringify(payload)));
  return new File([await pdf.save()], 'bundle.pdf', { type: 'application/pdf' });
}

test('a bundle with 101 sections is not reopened: the warning says why and the table and its documents stay as they were', async () => {
  reset();
  addSection();
  state.filesMap.set('kept.pdf', new File([new Uint8Array(8)], 'kept.pdf'));
  state.frontendInputData['kept.pdf'] = { title: 'Kept', date: '', pageCount: 1 };
  const before = sectionCount();
  await handleBundleRestore(await bundleWithSections(101));
  const modal = doc.getElementById('upload-warning-modal');
  assert.equal(modal.classList.contains('hidden'), false, 'the warning is shown');
  assert.equal(doc.getElementById('upload-warning-modal-title').textContent, 'Too many sections');
  assert.match(doc.getElementById('upload-warning-modal-msg').textContent, /This bundle has 101 sections\. A bundle holds up to 100, so it was not opened/);
  assert.equal(sectionCount(), before, 'no section was replaced');
  assert.deepEqual([...state.filesMap.keys()], ['kept.pdf'], 'the documents on the page are untouched');
  assert.equal(state.frontendInputData['kept.pdf'].title, 'Kept');
});
