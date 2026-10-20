/**
 * A saved copy's label (bundleTitle / projectName) is the title as typed, with no build needed. Inside
 * _saveOnce, `state` is the snapshot getAutosaveState() has just built, not the app's state module, and its
 * `config` is collectFormConfig(), which reads the live form fields, so the label is neither empty nor
 * stale between builds. These tests pin that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { init, markDirty, saveNow, listSnapshots } from '../public/js/bundletoolAutosave.js';
import { bumpGeneration } from '../public/js/frontend/tabSession.js';

test('a saved copy is labelled with the title and parties as they were when it was saved', async () => {
  bumpGeneration();
  let live = { bundleTitle: 'Trial Bundle', projectName: 'A v B' };   // what the form fields say now
  init(async () => ({
    files: [{ filename: 'a.pdf', file: new File(['a bytes'], 'a.pdf') }],
    inputData: {}, tableOrder: [], config: { ...live }, coversheet: null, isSectioned: false,
  }), { hasDocuments: () => true, hasPendingRows: () => false });

  markDirty({ immediate: true });
  await saveNow();
  let [newest] = (await listSnapshots()).sort((x, y) => y.timestamp - x.timestamp);
  assert.equal(newest.bundleTitle, 'Trial Bundle');
  assert.equal(newest.projectName, 'A v B');

  // Retyped with no build in between: the next saved copy carries the new text.
  live = { bundleTitle: 'Final Bundle', projectName: 'C v D' };
  markDirty({ immediate: true });
  await saveNow();
  [newest] = (await listSnapshots()).sort((x, y) => y.timestamp - x.timestamp);
  assert.equal(newest.bundleTitle, 'Final Bundle');
  assert.equal(newest.projectName, 'C v D');
});

test('the keys the label reads are the ones the real form collector produces, flat, from the live fields', async () => {
  // The test above stubs the snapshot's shape; this pins the shape against the real collectFormConfig().
  const values = { 'config-bundleTitle': 'Trial Bundle', 'config-projectName': 'A v B' };
  globalThis.document = {
    getElementById: (id) => (id in values ? { value: values[id] } : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  try {
    const { collectFormConfig } = await import('../public/js/frontend/autosave.js');
    const config = collectFormConfig();
    assert.equal(config.bundleTitle, 'Trial Bundle');
    assert.equal(config.projectName, 'A v B');
    values['config-bundleTitle'] = 'Final Bundle';
    assert.equal(collectFormConfig().bundleTitle, 'Final Bundle', 'read from the live field every time, not cached');
  } finally {
    delete globalThis.document;
  }
});
