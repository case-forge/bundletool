/**
 * The Review Table's Download button: hidden until there is a document (frontend/reviewTableHeader.js), built as
 * Share is beside Reset, and its picker and output (frontend/documentDownload.js): the choices offered, one PDF for
 * one document, otherwise a zip in bundle order with "01 - <title>.pdf" names, a folder per section for "All
 * documents", and the bundle title in the zip's name. The bytes are the ones BundleTool holds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeDocument, FakeElement } from './fakeDom.mjs';
import { makePdf } from './fixtures.mjs';

const doc = new FakeDocument();
globalThis.document = doc;

const { syncReviewTableHeader, HEADER_BUTTONS } = await import('../public/js/frontend/reviewTableHeader.js');
const { readGroups, downloadChoices, downloadPlan, downloadBytes, openDownloadPicker, changedByBundleTool } = await import('../public/js/frontend/documentDownload.js');
const { state } = await import('../public/js/frontend/state.js');

const html = fs.readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../assets/css/bundletool.css', import.meta.url), 'utf8');

/** Reads a zip back with no help from the writer: end record, central directory, then each entry. */
function readZip(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    out.push({ name, bytes: zip.subarray(start, start + size) });
    at += 46 + nameLength;
  }
  return out;
}

// ── The button ──────────────────────────────────────────────────────────────────

/** A Review Table: header buttons and one tbody per section, as the page builds them. */
function table(sections) {
  const root = new FakeElement(doc, 'div', 'file-table');
  doc.body.replaceChildren(root);
  for (const id of HEADER_BUTTONS) root.appendChild(new FakeElement(doc, 'button', id)).hidden = true;
  const tableEl = root.appendChild(new FakeElement(doc, 'table'));
  for (const s of sections) {
    const tbody = tableEl.appendChild(new FakeElement(doc, 'tbody'));
    tbody.className = 'section-tbody';
    if (s.label !== undefined) {
      const header = tbody.appendChild(new FakeElement(doc, 'tr'));
      header.className = 'section-header-row';
      const label = header.appendChild(new FakeElement(doc, 'input'));
      label.className = 'section-label-input';
      label.value = s.label;
      label.placeholder = s.placeholder ?? '';
      const name = header.appendChild(new FakeElement(doc, 'input'));
      name.className = 'section-name-input';
      name.value = s.name ?? '';
    }
    for (const f of s.files ?? []) {
      const row = tbody.appendChild(new FakeElement(doc, 'tr'));
      row.className = 'file-row';
      row.dataset.filename = f;
    }
    for (const t of s.tutorial ?? []) tbody.appendChild(new FakeElement(doc, 'tr')).className = 'tutorial-row';
  }
  return root;
}

test('Download and Clear All are hidden while there is no document and shown as soon as there is one', () => {
  table([{ files: [] }]);
  assert.equal(syncReviewTableHeader(doc), false);
  for (const id of HEADER_BUTTONS) assert.equal(doc.getElementById(id).hidden, true, `${id} hidden`);
  table([{ tutorial: ['x', 'y'] }]);
  syncReviewTableHeader(doc);
  assert.equal(doc.getElementById('download-docs-btn').hidden, true, 'the tutorial\'s example rows are not documents');
  table([{ files: ['one.pdf'] }]);
  assert.equal(syncReviewTableHeader(doc), true);
  for (const id of HEADER_BUTTONS) assert.equal(doc.getElementById(id).hidden, false, `${id} shown`);
  doc.querySelector('tr.file-row').remove();
  syncReviewTableHeader(doc);
  assert.equal(doc.getElementById('download-docs-btn').hidden, true, 'hidden again once the last one goes');
});

test('the Download button sits beside Clear All as Share sits beside Reset: same markup, classes, icon size and nudge', () => {
  const tag = (id) => new RegExp(`<button id="${id}"[\\s\\S]*?</button>`).exec(html)?.[0] ?? '';
  const download = tag('download-docs-btn');
  const share = tag('share-advanced-btn');
  const cls = (t) => /class="([^"]*)"/.exec(t)?.[1];
  const iconCls = (t) => /"class" "([^"]*)"/.exec(t)?.[1];
  assert.ok(download, 'the button is in the template');
  assert.match(download, /<button id="download-docs-btn" type="button" hidden\s/, 'hidden until there is a document');
  assert.match(download, /"name" "download"/, 'the shared icon set\'s download icon');
  assert.equal(cls(download), cls(share), 'the same classes as Share');
  assert.equal(iconCls(download), iconCls(share), 'the same icon size as Share');
  const header = /<div id="file-table"[\s\S]*?<div class="([^"]*)">\s*<!--[\s\S]*?-->\s*<button id="download-docs-btn"[\s\S]*?<\/button>\s*<button id="clear-all-rows-btn"/.exec(html);
  assert.ok(header, 'Download comes straight before Clear All');
  assert.match(header[1], /\bflex items-center gap-2 shrink-0\b/, 'in a row with the same gap and alignment as Advanced Settings');
  assert.match(css, /#share-advanced-btn,\s*#download-docs-btn\s*\{\s*margin-right: -\.25rem;/, 'the same nudge towards its neighbour');
  assert.match(css, /\.bt-icon-circle--accent:hover\s*\{/);
  assert.match(css, /\[data-palette=modern\] \.bt-icon-circle--accent:hover\s*\{/);
});

// ── The picker ──────────────────────────────────────────────────────────────────

const bundle = () => [
  { label: 'A', name: 'Applications', files: ['form.pdf', 'order.pdf'] },
  { label: 'B', name: 'Evidence', files: ['photos.pdf'] },
  { label: 'C', name: 'Empty', files: [] },
];

test('the groups are read from the table in order, with documents outside any section in a group of their own', () => {
  table([{ files: ['stray.pdf'] }, ...bundle(), { label: '', placeholder: 'D', name: 'Late', files: ['late.pdf'] }]);
  assert.deepEqual(readGroups(doc, true), [
    { section: null, files: ['stray.pdf'] },
    { section: { label: 'A', name: 'Applications' }, files: ['form.pdf', 'order.pdf'] },
    { section: { label: 'B', name: 'Evidence' }, files: ['photos.pdf'] },
    { section: { label: 'C', name: 'Empty' }, files: [] },
    { section: { label: 'D', name: 'Late' }, files: ['late.pdf'] },
  ]);
  table([{ files: ['a.pdf', 'b.pdf'] }]);
  assert.deepEqual(readGroups(doc, false), [{ section: null, files: ['a.pdf', 'b.pdf'] }]);
});

test('the choices: each section with documents by label and name, Not in a section only when there are such, then All documents', () => {
  const groups = [{ section: null, files: ['stray.pdf'] }, ...bundle().map(({ label, name, files }) => ({ section: { label, name }, files }))];
  const none = { isChanged: () => false };
  assert.deepEqual(downloadChoices(groups, none).map((c) => c.label), ['A: Applications', 'B: Evidence', 'Not in a section', 'All documents']);
  assert.deepEqual(downloadChoices(groups.slice(1), none).map((c) => c.label), ['A: Applications', 'B: Evidence', 'All documents'], 'no "Not in a section" when every document is in one');
  assert.deepEqual(downloadChoices([{ section: { label: '', name: 'Orders' }, files: ['x.pdf'] }, { section: { label: 'B', name: '' }, files: ['y.pdf'] }], none).map((c) => c.label), ['Orders', 'B', 'All documents']);
  assert.deepEqual(downloadChoices([{ section: null, files: ['a.pdf', 'b.pdf'] }], none).map((c) => c.label), ['All documents'], 'with no sections there is nothing to split by');
  assert.deepEqual(downloadChoices(groups, { isChanged: (f) => f === 'order.pdf' }).map((c) => c.label),
    ['A: Applications', 'B: Evidence', 'Not in a section', 'Only documents BundleTool changed', 'All documents'], 'offered once there is a changed document');
});

const titles = { 'form.pdf': 'Application form', 'order.pdf': 'Order: 3/4 "final"', 'photos.pdf': 'Photographs', 'stray.pdf': 'Letter', 'late.pdf': 'Late' };
const titleOf = (f) => titles[f] ?? '';

test('one document gives that PDF, named by its title', () => {
  const groups = bundle().map(({ label, name, files }) => ({ section: { label, name }, files }));
  const plan = downloadPlan({ kind: 'section', index: 1 }, groups, { bundleTitle: 'Final hearing', titleOf });
  assert.deepEqual(plan, { zip: false, name: 'Photographs.pdf', files: [{ filename: 'photos.pdf', path: '01 - Photographs.pdf' }] });
  const only = downloadPlan({ kind: 'all' }, [{ section: null, files: ['form.pdf'] }], { titleOf });
  assert.equal(only.zip, false, '"All documents" of a one-document bundle is that PDF too');
});

test('a section gives a zip in bundle order, numbered and named by title, after the bundle title', () => {
  const groups = bundle().map(({ label, name, files }) => ({ section: { label, name }, files }));
  const plan = downloadPlan({ kind: 'section', index: 0 }, groups, { bundleTitle: 'Final hearing: bundle', titleOf });
  assert.equal(plan.zip, true);
  assert.equal(plan.name, 'Final hearing bundle - A - Applications.zip');
  assert.deepEqual(plan.files.map((f) => f.path), ['01 - Application form.pdf', '02 - Order 3 4 final.pdf']);
  assert.equal(downloadPlan({ kind: 'section', index: 0 }, groups, { titleOf }).name, 'A - Applications.zip', 'no bundle title, no prefix');
});

test('All documents gives a folder per section, in order, and Not in a section when needed', () => {
  const groups = [{ section: null, files: ['stray.pdf'] }, ...bundle().map(({ label, name, files }) => ({ section: { label, name }, files }))];
  const plan = downloadPlan({ kind: 'all' }, groups, { bundleTitle: 'Final hearing', titleOf });
  assert.equal(plan.name, 'Final hearing - All documents.zip');
  assert.deepEqual(plan.files.map((f) => f.path), [
    'Not in a section/01 - Letter.pdf',
    'A - Applications/01 - Application form.pdf',
    'A - Applications/02 - Order 3 4 final.pdf',
    'B - Evidence/01 - Photographs.pdf',
  ]);
  const flat = downloadPlan({ kind: 'all' }, [{ section: null, files: ['form.pdf', 'order.pdf'] }], { titleOf });
  assert.deepEqual(flat.files.map((f) => f.path), ['01 - Application form.pdf', '02 - Order 3 4 final.pdf'], 'no sections, no folders');
  assert.equal(flat.name, 'All documents.zip');
});

test('names stay distinct and safe: numbers widen past 99, two sections called the same get their own folders, no path escapes', () => {
  const many = Array.from({ length: 120 }, (_, i) => `d${i}.pdf`);
  const wide = downloadPlan({ kind: 'all' }, [{ section: null, files: many }], { titleOf: (f) => `Doc ${f}` });
  assert.equal(wide.files[0].path, '001 - Doc d0.pdf');
  assert.equal(wide.files[119].path, '120 - Doc d119.pdf');
  const twins = [
    { section: { label: 'A', name: 'Evidence' }, files: ['form.pdf'] },
    { section: { label: 'A', name: 'Evidence' }, files: ['photos.pdf'] },
    { section: { label: '../..', name: '' }, files: ['late.pdf'] },
  ];
  const paths = downloadPlan({ kind: 'all' }, twins, { titleOf: () => '../../etc/passwd' }).files.map((f) => f.path);
  assert.deepEqual(paths, ['A - Evidence/01 - .. .. etc passwd.pdf', 'A - Evidence (2)/01 - .. .. etc passwd.pdf', 'Section/01 - .. .. etc passwd.pdf']);
  for (const p of paths) {
    const parts = p.split('/');
    assert.equal(parts.length, 2, `${p} is one folder deep`);
    assert.ok(parts.every((part) => part !== '..' && part !== '.' && part.trim() === part && part), `${p} names no parent folder`);
  }
  assert.equal(downloadPlan({ kind: 'section', index: 0 }, [{ section: { label: 'A', name: 'X' }, files: ['nameless.pdf', 'x.pdf'] }], { titleOf: () => '' }).files[0].path, '01 - nameless.pdf', 'a document with no title is named by its file');
});

test('the zip holds the bytes BundleTool holds, under those names and in that order', async () => {
  const held = new Map();
  for (const [f, label] of [['stray.pdf', 'S'], ['form.pdf', 'F'], ['order.pdf', 'O'], ['photos.pdf', 'P']]) {
    held.set(f, new File([await makePdf(1, label)], f, { type: 'application/pdf' }));
  }
  const groups = [{ section: null, files: ['stray.pdf'] }, ...bundle().map(({ label, name, files }) => ({ section: { label, name }, files }))];
  const out = await downloadBytes(downloadPlan({ kind: 'all' }, groups, { bundleTitle: 'Final hearing', titleOf }), held);
  assert.equal(out.type, 'application/zip');
  assert.equal(out.name, 'Final hearing - All documents.zip');
  const entries = readZip(out.bytes);
  assert.deepEqual(entries.map((e) => e.name), ['Not in a section/01 - Letter.pdf', 'A - Applications/01 - Application form.pdf', 'A - Applications/02 - Order 3 4 final.pdf', 'B - Evidence/01 - Photographs.pdf']);
  const order = ['stray.pdf', 'form.pdf', 'order.pdf', 'photos.pdf'];
  for (const [i, e] of entries.entries()) {
    assert.deepEqual(Buffer.from(e.bytes), Buffer.from(await held.get(order[i]).arrayBuffer()), `${e.name} is the held file, byte for byte`);
  }
  const one = await downloadBytes(downloadPlan({ kind: 'section', index: 2 }, groups, { titleOf }), held);
  assert.deepEqual([one.name, one.type], ['Photographs.pdf', 'application/pdf']);
  assert.deepEqual(Buffer.from(one.bytes), Buffer.from(await held.get('photos.pdf').arrayBuffer()));
});

test('the picker lists the choices as text, and a choice downloads through the shared helper', async () => {
  table([...bundle()]);
  state.isSectioned = true;
  for (const f of ['form.pdf', 'order.pdf', 'photos.pdf']) {
    state.filesMap.set(f, new File([await makePdf(1, f)], f, { type: 'application/pdf' }));
    state.frontendInputData[f] = { title: titles[f], pageCount: 1 };
  }
  const popover = doc.body.appendChild(new FakeElement(doc, 'div', 'download-picker-popover'));
  popover.className = 'hidden';
  popover.appendChild(new FakeElement(doc, 'div', 'download-picker-list'));
  const cancel = popover.appendChild(new FakeElement(doc, 'button', 'download-picker-cancel'));
  const titleBox = doc.body.appendChild(new FakeElement(doc, 'textarea', 'config-bundleTitle'));
  titleBox.value = 'Final hearing';
  doc.getElementById('download-picker-list').appendChild(new FakeElement(doc, 'button')).textContent = 'left over';

  openDownloadPicker();
  assert.equal(popover.classList.contains('hidden'), false);
  const buttons = doc.getElementById('download-picker-list').children;
  assert.deepEqual(buttons.map((b) => b.textContent), ['A: Applications', 'B: Evidence', 'All documents']);
  cancel.click();
  assert.equal(popover.classList.contains('hidden'), true, 'Cancel closes it');

  const saved = [];
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => { saved.push(blob); return 'blob:test'; };
  const anchors = [];
  const realAppend = doc.body.appendChild.bind(doc.body);
  doc.body.appendChild = (el) => { if (el.tagName === 'A') anchors.push(el); return realAppend(el); };
  try {
    openDownloadPicker();
    doc.getElementById('download-picker-list').children[0].click();
    assert.equal(popover.classList.contains('hidden'), true, 'choosing closes the picker');
    const end = Date.now() + 5000;
    while (!saved.length && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    assert.equal(anchors[0]?.download, 'Final hearing - A - Applications.zip');
    assert.deepEqual(readZip(new Uint8Array(await saved[0].arrayBuffer())).map((e) => e.name), ['01 - Application form.pdf', '02 - Order 3 4 final.pdf']);
  } finally {
    URL.createObjectURL = realCreate;
    doc.body.appendChild = realAppend;
    state.isSectioned = false;
  }
});

test('the section rows keep Remove, Move up, Move down and the witness statement cover, and no download', () => {
  const sections = fs.readFileSync(new URL('../public/js/frontend/sections.js', import.meta.url), 'utf8');
  for (const gone of ['section-download-btn', 'downloadSection', 'downloadFile']) assert.ok(!sections.includes(gone), `no ${gone}`);
  for (const kept of ['section-delete-btn', 'move-up-btn', 'move-down-btn', 'section-add-ws-btn']) {
    assert.equal((sections.match(new RegExp(`class="${kept}\\b`, 'g')) || []).length, 2, `${kept} on both kinds of section header`);
  }
  const helpers = fs.readFileSync(new URL('../public/js/frontend/helpers.js', import.meta.url), 'utf8');
  assert.ok(!helpers.includes('downloadFile'), 'triggerDownload is the one download helper');
});

// ── Only documents BundleTool changed ───────────────────────────────────────────

test('a document counts as changed when it was converted, given an OCR layer, turned or had a page removed', () => {
  for (const flag of ['convertedFromDocx', 'convertedFromImage', 'ocrApplied', 'pagesChanged']) {
    assert.equal(changedByBundleTool({ title: 'x', [flag]: true }), true, flag);
  }
  for (const plain of [undefined, {}, { title: 'x', pageCount: 3 }, { recovered: true }, { redactedPages: [2] }, { expanding: true }]) {
    assert.equal(changedByBundleTool(plain), false, JSON.stringify(plain));
  }
});

test('each kind of change sets its flag where the held file is made or replaced', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const adding = read('../public/js/frontend/fileProcessing.js');
  assert.match(adding, /\.\.\.\(admission\.route === 'photo' \? \{ convertedFromImage: true \} : \{\}\)/, 'a photo wrapped into a PDF');
  assert.match(adding, /\.\.\.\(convertedFromDocx \? \{ convertedFromDocx \} : \{\}\)/, 'a Word document converted');
  for (const rel of ['../public/js/frontend/ocrForce.js', '../public/js/frontend/ocrAuto.js']) {
    assert.match(read(rel), /state\.filesMap\.set\(filename[\s\S]{0,200}\.ocrApplied = true/, `${rel}: an OCR layer written`);
  }
  // The window's turns (and page removal) go through one place that sets pagesChanged: documentWindow.test.mjs
  // presses the buttons and checks the flag.
  const window = read('../public/js/frontend/rotate.js');
  assert.match(window, /function storeChangedFile\([\s\S]{0,300}\.pagesChanged = true/);
  assert.equal((window.match(/state\.filesMap\.set\(/g) || []).length, 1, 'the window replaces the held file in that one place');
});

test('"Only documents BundleTool changed" holds just those, keeping their numbers and section folders', () => {
  const groups = [{ section: null, files: ['stray.pdf'] }, ...bundle().map(({ label, name, files }) => ({ section: { label, name }, files }))];
  const changed = new Set(['stray.pdf', 'order.pdf']);
  const plan = downloadPlan({ kind: 'changed' }, groups, { bundleTitle: 'Final hearing', titleOf, isChanged: (f) => changed.has(f) });
  assert.equal(plan.zip, true);
  assert.equal(plan.name, 'Final hearing - Changed documents.zip');
  assert.deepEqual(plan.files.map((f) => f.path), ['Not in a section/01 - Letter.pdf', 'A - Applications/02 - Order 3 4 final.pdf'],
    'the order keeps its place in its section, as in "All documents"');
  const one = downloadPlan({ kind: 'changed' }, groups, { titleOf, isChanged: (f) => f === 'photos.pdf' });
  assert.deepEqual([one.zip, one.name], [false, 'Photographs.pdf'], 'one changed document is that PDF');
  const flat = downloadPlan({ kind: 'changed' }, [{ section: null, files: ['form.pdf', 'order.pdf', 'photos.pdf'] }], { titleOf, isChanged: (f) => f !== 'order.pdf' });
  assert.deepEqual(flat.files.map((f) => f.path), ['01 - Application form.pdf', '03 - Photographs.pdf']);
  assert.equal(flat.name, 'Changed documents.zip');
});

test('the choice reads the held documents\' own flags, and is not offered when nothing has changed', () => {
  const groups = [{ section: null, files: ['p1.pdf', 'p2.pdf'] }];
  state.frontendInputData['p1.pdf'] = { title: 'P1' };
  state.frontendInputData['p2.pdf'] = { title: 'P2' };
  assert.ok(!downloadChoices(groups).some((c) => c.kind === 'changed'));
  state.frontendInputData['p2.pdf'].pagesChanged = true;
  assert.ok(downloadChoices(groups).some((c) => c.kind === 'changed'));
  assert.deepEqual(downloadPlan({ kind: 'changed' }, groups).files.map((f) => f.filename), ['p2.pdf']);
});
