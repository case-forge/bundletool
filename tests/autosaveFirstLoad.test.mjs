/**
 * A new tab's first save must not hide the last session from its own restore.
 *
 * On load, a settings or draft change calls markDirty() and, a moment later, a save runs. If that save finds the table
 * empty (the last session has not been put back yet, or never will be) it used to stamp "the table was emptied by
 * hand", and the restore, reading that stamp, found every saved copy older than it and brought nothing back (seen on a
 * busy machine, where the save beat the restore). Only a table that has held documents can be emptied by hand.
 *
 * Its own file: the "has this table ever held a document" flag is module state, and node runs each test file in its
 * own process, so this starts with a table that never had one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { init, markDirty, saveNow } from '../public/js/bundletoolAutosave.js';
import { bumpGeneration, getGeneration } from '../public/js/frontend/tabSession.js';

const fileState = (names) => ({
  files: names.map((filename) => ({ filename, file: new File([`${filename} bytes`], filename) })),
  inputData: {}, tableOrder: [], config: {}, coversheet: null, isSectioned: false,
});

test('an empty save before the table ever held a document does not mark the saved copies cleared', async () => {
  bumpGeneration();
  init(async () => null, { hasDocuments: () => false, hasPendingRows: () => false });
  const generation = getGeneration();
  markDirty({ immediate: true });               // a settings change on load
  await saveNow();
  assert.equal(getGeneration(), generation, 'nothing was cleared, because nothing was ever in the table');
});

test('once the table has held a document, emptying it still marks the saved copies cleared', async () => {
  bumpGeneration();
  let phase = 'full';
  init(async () => (phase === 'full' ? fileState(['a.pdf']) : null), { hasDocuments: () => phase === 'full', hasPendingRows: () => false });
  markDirty({ immediate: true });
  await saveNow();
  phase = 'empty';
  const generation = getGeneration();
  markDirty({ immediate: true });
  await saveNow();
  assert.ok(getGeneration() > generation, 'an emptied table hides the older saved copies from the next load');
});
