/**
 * A save already in flight must not lose a second document added while it is still reading or
 * writing the first. `_saveOnce()` clears the module's single `_dirty` flag on the way out only
 * when no new change arrived mid-save: the `beforeunload` prompt and the pagehide flush both read
 * that flag, and a cleared flag tells them there is nothing left to lose. Needs a real IndexedDB to
 * exercise the actual save path, not just the pure helpers savedCopies.test.mjs covers:
 * fake-indexeddb (Apache-2.0, test-only devDependency) stands in for the browser's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { init, markDirty, isSavePending, saveNow, listSnapshots, loadSnapshot } from '../public/js/bundletoolAutosave.js';
import { bumpGeneration } from '../public/js/frontend/tabSession.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fileState(names) {
  return {
    files: names.map((filename) => ({ filename, file: new File([`${filename} bytes`], filename) })),
    inputData: {}, tableOrder: [], config: {}, coversheet: null, isSectioned: false,
  };
}

test('a second document added while the first is still saving is not lost', async () => {
  bumpGeneration();
  const first = deferred();
  let call = 0;
  // Call 1 (the race): hangs until the test lets it through, by which point the second document
  // has already been added. Call 2 (the follow-up save markDirty's own timer schedules): returns
  // the real, current state, both documents.
  init(async () => { call++; return call === 1 ? (await first.promise, fileState(['a.pdf'])) : fileState(['a.pdf', 'b.pdf']); },
    { hasDocuments: () => true, hasPendingRows: () => false });

  markDirty({ immediate: true });                 // document 1: starts a save at once (SETTLE_MS 0)
  // _lastStart is shared module state. A save this test's own markDirty triggers can still be
  // delayed up to MIN_GAP_MS if another test in this file saved recently, so poll for it to have
  // actually reached the hung getState() rather than assume a fixed wait is always enough.
  while (call < 1) await new Promise((r) => setTimeout(r, 5));
  markDirty({ immediate: true });                  // document 2: arrives while call 1 is still in flight
  assert.equal(isSavePending(), true, 'a change mid-save must still read as pending');
  first.resolve();                                 // let the first save finish, writing only document 1

  // The window that matters: the first save has finished (so isSavePending() is not true merely
  // because a save is running), but the follow-up timer for document 2 (scheduled for up to
  // MIN_GAP_MS, 250ms, after its own markDirty) has not fired yet. beforeunload and the pagehide
  // flush both read this flag here, and must not be told that nothing is left to lose.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(isSavePending(), true, 'the first save finishing must not make the still-unsaved second document look safe to lose');

  // The follow-up save markDirty's own timer scheduled must still run on its own and must see this
  // not-yet-captured change. No forced saveNow() here: it would save regardless of _dirty's state
  // and hide a lost change.
  await new Promise((r) => setTimeout(r, 300));

  const [snap] = await listSnapshots();
  assert.ok(snap, 'something was saved');
  assert.equal(snap.fileCount, 2, 'both documents must be in the final saved copy, not just the first');
  const loaded = await loadSnapshot(snap.timestamp);
  assert.deepEqual(loaded.files.map((f) => f.filename).sort(), ['a.pdf', 'b.pdf']);
});

test('a save that captures everything cleanly does mark the table saved', async () => {
  bumpGeneration();
  init(async () => fileState(['only.pdf']), { hasDocuments: () => true, hasPendingRows: () => false });
  await saveNow();
  assert.equal(isSavePending(), false, 'nothing changed after the save finished, so nothing should be pending');
});

// A validated file sits in state.filesMap for up to the row batcher's own gap (rowBatch.js) before
// its row is inserted and markDirty() fires for it. In that window _dirty is false and no save is
// running, so the pending rows themselves must count, or a reload would warn no one.
test('a pending row batch reads as save-pending even though nothing is dirty yet', async () => {
  bumpGeneration();
  let getStateCalls = 0;
  init(async () => { getStateCalls++; throw new Error('must not be called: nothing is dirty, a save has nothing to read'); },
    { hasDocuments: () => false, hasPendingRows: () => true });
  assert.equal(isSavePending(), true, 'a pending, not-yet-inserted row must itself count as something to warn about');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getStateCalls, 0, 'reporting as pending must not itself trigger a save: there is no row yet for one to describe');
});

test('once the batch clears, a false hasPendingRows does not keep the warning up by itself', async () => {
  bumpGeneration();
  init(async () => fileState(['only.pdf']), { hasDocuments: () => false, hasPendingRows: () => false });
  assert.equal(isSavePending(), false);
});

// The empty-table branch clears _dirty the same way the success branch does, and needs the same
// seq guard: re-adding a document while an emptied-table save is still running must not have that
// save's own "nothing to save" conclusion silently win.
test('a document re-added while an emptying save is still in flight is not lost either', async () => {
  bumpGeneration();
  const clearing = deferred();
  let call = 0;
  init(async () => {
    call++;
    if (call === 1) { await clearing.promise; return fileState([]); }      // the table had just been emptied
    return fileState(['back-again.pdf']);                                  // by the time this read happens, something is there again
  }, { hasDocuments: () => true, hasPendingRows: () => false });

  markDirty({ immediate: true });                   // the clear itself is a change
  // _lastStart is shared module state, left over from whatever this process last saved: a save
  // triggered by this test's own markDirty can be delayed up to MIN_GAP_MS by an earlier test's
  // recent save, rather than start "at once" as it would in a fresh process. Poll for the save
  // to have actually reached the hung getState(), rather than assume a fixed wait is enough.
  while (call < 1) await new Promise((r) => setTimeout(r, 5));
  markDirty({ immediate: true });                    // a document is added back while the empty-table save is still in flight
  clearing.resolve();                                // let the first save conclude "nothing to save"

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(isSavePending(), true, 'the empty-table save concluding must not hide the document added back afterward');
  await new Promise((r) => setTimeout(r, 400));

  const [snap] = await listSnapshots();
  assert.ok(snap, 'the re-added document must still get its own save');
  assert.equal(snap.fileCount, 1);
});

// ── An empty state while rows are still being added is not a cleared table.
// getAutosaveState() returns null while documents are in state but no row lists them yet. That must not be
// read as "the table was emptied", which would write the cleared-at stamp and drop the current saved copy.

import { getGeneration } from '../public/js/frontend/tabSession.js';

test('a null state during the row-batch gap leaves the saved copy restorable', async () => {
  bumpGeneration();
  let phase = 'has-files';
  let pendingRows = false;
  init(async () => (phase === 'has-files' ? fileState(['a.pdf']) : null),
    { hasDocuments: () => true, hasPendingRows: () => pendingRows });
  markDirty({ immediate: true });
  await saveNow();
  const before = (await listSnapshots()).length;
  assert.ok(before >= 1, 'a saved copy exists');
  const generation = getGeneration();

  // A file is added: its row is held back, so the state reads as empty for now.
  phase = 'gap'; pendingRows = true;
  markDirty({ immediate: true });
  await saveNow();
  assert.equal(getGeneration(), generation, 'nothing was marked cleared');
  assert.equal((await listSnapshots()).length, before, 'the saved copy is still there');
  assert.equal(isSavePending(), true, 'and the change is still pending, for the save the first row triggers');
});

test('a null state with nothing pending is still a real clear', async () => {
  bumpGeneration();
  init(async () => null, { hasDocuments: () => false, hasPendingRows: () => false });
  const generation = getGeneration();
  markDirty({ immediate: true });
  await saveNow();
  assert.ok(getGeneration() > generation, 'an emptied table still marks the saved copies cleared');
});
