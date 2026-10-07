/**
 * While the row batcher holds rows back, a validated document is already in state.filesMap and
 * state.frontendInputData but has no table row yet. A snapshot taken then must not hold a document no row
 * lists: restoring it would bring back an invisible file that is built into the bundle and refused as
 * "Already added". Both ends check the table: the save leaves such documents out, and the restore
 * ignores any a snapshot still carries.
 *
 * No DOM library is installed, so `document` is the smallest stub the two functions read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** A table of sections, each a list of filenames, as getAutosaveState reads it off the page. */
function stubDocument(sections) {
  const row = (filename) => ({ dataset: { filename } });
  const tbody = ([sectionID, filenames]) => ({
    dataset: { sectionId: sectionID },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === 'tr.file-row' ? filenames.map(row) : []),
  });
  globalThis.document = {
    querySelectorAll: (sel) => (sel === '.section-tbody' ? Object.entries(sections).map(tbody) : []),
    getElementById: () => null,
    querySelector: () => null,
  };
}

stubDocument({});   // some modules read `document` as they load
const { state } = await import('../public/js/frontend/state.js');
const { getAutosaveState, restorableParts } = await import('../public/js/frontend/autosave.js');

const pdf = (name) => new File([`${name} bytes`], name, { type: 'application/pdf' });

test('a document with no row yet is left out of the snapshot, files and row data both', async () => {
  stubDocument({ '0000': ['a.pdf'] });
  state.filesMap = new Map([['a.pdf', pdf('a.pdf')], ['b.pdf', pdf('b.pdf')]]);   // b.pdf: validated, row not inserted yet
  state.frontendInputData = { 'a.pdf': { title: 'A' }, 'b.pdf': { title: 'B' } };
  const snap = await getAutosaveState();
  assert.deepEqual(snap.files.map((f) => f.filename), ['a.pdf']);
  assert.deepEqual(Object.keys(snap.inputData), ['a.pdf']);
  assert.deepEqual(snap.tableOrder[0].filenames, ['a.pdf']);
});

test('every document still waiting for its row means there is nothing to save yet', async () => {
  stubDocument({ '0000': [] });
  state.filesMap = new Map([['b.pdf', pdf('b.pdf')]]);
  state.frontendInputData = { 'b.pdf': { title: 'B' } };
  assert.equal(await getAutosaveState(), null);
});

test('documents in several sections are all kept', async () => {
  stubDocument({ '0000': ['a.pdf'], '0001': ['c.pdf'] });
  state.filesMap = new Map([['a.pdf', pdf('a.pdf')], ['c.pdf', pdf('c.pdf')]]);
  state.frontendInputData = { 'a.pdf': {}, 'c.pdf': {} };
  const snap = await getAutosaveState();
  assert.deepEqual(snap.files.map((f) => f.filename).sort(), ['a.pdf', 'c.pdf']);
});

// ── Restore: a snapshot that already holds an unlisted document (written by a racing save, for example)

const snapshotWith = (listed, files, inputData) => ({
  files: files.map((filename) => ({ filename, bytes: new Uint8Array([1]), key: `k-${filename}` })),
  inputData: Object.fromEntries(inputData.map((n) => [n, {}])),
  tableOrder: [{ type: 'section', sectionID: '0000', label: '', name: '', filenames: listed }],
});

test('a document in files and row data but in no row is not restored, and so can be added again', () => {
  const r = restorableParts(snapshotWith(['a.pdf'], ['a.pdf', 'b.pdf'], ['a.pdf', 'b.pdf']));
  assert.deepEqual(r.files.map((f) => f.filename), ['a.pdf']);
  assert.deepEqual(Object.keys(r.inputData), ['a.pdf']);
  // "Already added" is decided from this row data and the files map: nothing of b.pdf comes back
  assert.ok(!('b.pdf' in r.inputData));
});

test('a document with a row but no row data is not restored either', () => {
  const r = restorableParts(snapshotWith(['a.pdf', 'b.pdf'], ['a.pdf', 'b.pdf'], ['a.pdf']));
  assert.deepEqual(r.files.map((f) => f.filename), ['a.pdf']);
});

test('a snapshot that lists every document restores every document', () => {
  const r = restorableParts({ ...snapshotWith(['a.pdf'], ['a.pdf', 'c.pdf'], ['a.pdf', 'c.pdf']),
    tableOrder: [{ type: 'section', sectionID: '0000', filenames: ['a.pdf'] }, { type: 'section', sectionID: '0001', filenames: ['c.pdf'] }] });
  assert.deepEqual(r.files.map((f) => f.filename), ['a.pdf', 'c.pdf']);
});
