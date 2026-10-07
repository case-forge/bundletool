/**
 * A Review Table document row's actions (frontend/fileRows.js): exactly four, Remove, Move up, Move down and the eye
 * that opens the document window, each naming its document; and Force OCR (frontend/ocrForce.js), which the window
 * runs, reporting its progress to the window and marking the row's OCR badge when it writes a text layer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeDocument, FakeElement } from './fakeDom.mjs';
import { makePdf } from './fixtures.mjs';

const doc = new FakeDocument();
globalThis.document = doc;
globalThis.CSS ??= { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };

const { ROW_ACTIONS, rowActionsMarkup, labelRowActions } = await import('../public/js/frontend/fileRows.js');
const { forceOcr } = await import('../public/js/frontend/ocrForce.js');
const { state } = await import('../public/js/frontend/state.js');

const source = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('a document row has exactly four actions, in order: Remove, Move up, Move down and the eye', () => {
  const markup = rowActionsMarkup();
  const buttons = [...markup.matchAll(/<button\b[^>]*class="([^"]*)"/g)].map((m) => m[1].split(' ')[0]);
  assert.deepEqual(buttons, ['delete-row-btn', 'move-up-btn', 'move-down-btn', 'preview-row-btn']);
  assert.deepEqual(ROW_ACTIONS.map((a) => a.icon), ['close', 'keyboard_arrow_up', 'keyboard_arrow_down', 'visibility']);
  assert.doesNotMatch(markup, /rotate|ocr|download/i, 'no turn, Force OCR or download icon on the row');
  const rows = source('../public/js/frontend/fileRows.js');
  for (const gone of ['rotate-row-btn', 'ocr-row-btn', 'download-pdf-btn', 'downloadFile']) {
    assert.ok(!rows.includes(gone), `fileRows.js has no ${gone}`);
  }
});

test('each action names its document; the eye says "Preview <name>" in its aria-label and its title', () => {
  const row = new FakeElement(doc, 'tr');
  for (const a of ROW_ACTIONS) {
    const b = row.appendChild(new FakeElement(doc, 'button'));
    b.className = a.cls;
    b.setAttribute('title', a.title);
  }
  labelRowActions(row, 'Exhibit "A" <1>.pdf');
  const eye = row.querySelector('.preview-row-btn');
  assert.equal(eye.getAttribute('aria-label'), 'Preview Exhibit "A" <1>.pdf');
  assert.equal(eye.getAttribute('title'), 'Preview Exhibit "A" <1>.pdf');
  assert.equal(row.querySelector('.delete-row-btn').getAttribute('aria-label'), 'Remove Exhibit "A" <1>.pdf from bundle');
  assert.equal(row.querySelector('.move-up-btn').getAttribute('aria-label'), 'Move Exhibit "A" <1>.pdf up');
  assert.equal(row.querySelector('.move-down-btn').getAttribute('aria-label'), 'Move Exhibit "A" <1>.pdf down');
  assert.equal(row.querySelector('.move-up-btn').getAttribute('title'), 'Move up', 'the arrows keep their short tooltip');
  assert.ok(!rowActionsMarkup().includes('Exhibit'), 'the name is set through the DOM, never written into the markup');
});

test('the eye opens the document window, loaded only when it is pressed', () => {
  const rows = source('../public/js/frontend/fileRows.js');
  assert.match(rows, /closest\('\.preview-row-btn'\)/);
  assert.match(rows, /lazyImport\(new URL\('\.\/rotate\.js', import\.meta\.url\)\)\.then\(\(\{ openDocumentWindow \}\)/);
  assert.doesNotMatch(rows, /from '\.\/rotate\.js'/, 'never a static import');
  assert.doesNotMatch(rows, /ocrForce\.js/, 'Force OCR is reached through the window, not the row');
});

function tableRow(filename) {
  const tr = doc.body.appendChild(new FakeElement(doc, 'tr'));
  tr.className = 'file-row';
  tr.dataset.filename = filename;
  const cell = tr.appendChild(new FakeElement(doc, 'td'));
  cell.className = 'filename-cell';
  return { tr, cell };
}

test('Force OCR reports its progress to the window, writes the text layer, marks the row and says so', async () => {
  const name = 'scan.pdf';
  const before = new File([await makePdf(2)], name, { type: 'application/pdf' });
  state.filesMap.set(name, before);
  state.frontendInputData[name] = { title: 'Scan', pageCount: 2 };
  const { cell } = tableRow(name);
  const opener = new FakeElement(doc, 'button');
  const said = [];
  const read = await makePdf(2, 'READ');
  const fakeOcr = async (bytes, { force, onPage }) => {
    assert.equal(force, true, 'every page is read');
    onPage(1, 2);
    onPage(2, 2);
    return { bytes: read, ocredPages: 2, skippedPages: [] };
  };
  const written = await forceOcr(name, opener, { onProgress: (t) => said.push(t), ocr: fakeOcr });
  assert.equal(written, true);
  assert.deepEqual(said, ['Reading text…', 'Reading text… page 1 of 2', 'Reading text… page 2 of 2']);
  assert.notEqual(state.filesMap.get(name), before);
  assert.deepEqual(new Uint8Array(await state.filesMap.get(name).arrayBuffer()), read);
  assert.equal(state.frontendInputData[name].ocrApplied, true);
  assert.equal(cell.querySelectorAll('.bt-badge-ocr').length, 1, 'the row shows its OCR badge');
  assert.equal(doc.activeElement, opener, 'focus goes back to the button that asked');
  await forceOcr(name, opener, { ocr: fakeOcr });
  assert.equal(cell.querySelectorAll('.bt-badge-ocr').length, 1, 'one badge, however often it runs');
});

test('Force OCR on a document removed while it ran leaves everything alone', async () => {
  const name = 'gone.pdf';
  state.filesMap.set(name, new File([await makePdf(1)], name, { type: 'application/pdf' }));
  state.frontendInputData[name] = { title: 'Gone', pageCount: 1 };
  const { cell } = tableRow(name);
  const fakeOcr = async () => { state.filesMap.delete(name); return { bytes: await makePdf(1, 'READ'), ocredPages: 1, skippedPages: [] }; };
  assert.equal(await forceOcr(name, null, { ocr: fakeOcr }), false);
  assert.equal(state.filesMap.has(name), false);
  assert.equal(cell.querySelectorAll('.bt-badge-ocr').length, 0);
});
