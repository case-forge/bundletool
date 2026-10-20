/**
 * processFiles() is called from several independent entry points (the drop handlers,
 * sections.js, wsCover.js), and nothing stops two calls overlapping: a drop landing while a
 * witness-statement cover is still batching its own rows, for instance. With one module variable
 * for the active batch, the FIRST call's own finally would clear it the moment that call's loop
 * finished, even while a SECOND call's batch still had pending rows, so hasPendingRowBatches()
 * (and through it, isSavePending()) would report nothing pending for work not yet saved: the
 * autosave race in autosaveRace.test.mjs, by a different path. Each call tracks its own batch.
 *
 * processFiles() itself needs a real page (makeFileRow() parses real HTML into real DOM nodes,
 * which the Node tests do not stub), so that add, validate and render flow is checked in a
 * browser. The tracking logic is `trackRowBatch()`, factored out of processFiles() so it can be
 * exercised directly, with two real row batchers, without a page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRowBatcher } from '../public/js/frontend/rowBatch.js';
import { hasPendingRowBatches, trackRowBatch } from '../public/js/frontend/fileProcessing.js';

function fakeBatcher() {
  let t = 0; const timers = new Map(); let nextId = 1;
  return createRowBatcher({
    insert: () => {},
    now: () => t,
    schedule: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
    cancel: (id) => timers.delete(id),
  });
}

test('two overlapping batches: finishing the first does not hide the second\'s still-pending rows', () => {
  const batch1 = fakeBatcher();
  const release1 = trackRowBatch(batch1);
  batch1.add({});   // call 1's own loop has validated a file and is holding its row back
  assert.equal(hasPendingRowBatches(), true, 'the first call alone must already read as pending');

  const batch2 = fakeBatcher();
  const release2 = trackRowBatch(batch2);
  batch2.add({});   // call 2 starts, its own loop overlapping call 1's, and also holds a row back

  // Call 1 finishes its own loop and runs its finally: flush empties ITS OWN batch, then releases
  // it. Call 2's batch is a completely different object and must be unaffected either way.
  batch1.flush();
  batch1.cancel();
  release1();
  assert.equal(hasPendingRowBatches(), true, 'call 2\'s own still-pending row must not vanish because call 1 finished');

  // Now call 2 finishes the same way. Nothing is pending from either call.
  batch2.flush();
  batch2.cancel();
  release2();
  assert.equal(hasPendingRowBatches(), false);
});

test('release only ever removes its own batch, whichever order the two calls finish in', () => {
  const batch1 = fakeBatcher();
  const release1 = trackRowBatch(batch1);
  batch1.add({});

  const batch2 = fakeBatcher();
  const release2 = trackRowBatch(batch2);
  batch2.add({});

  // This time call 2 (the later one) finishes first.
  batch2.flush();
  batch2.cancel();
  release2();
  assert.equal(hasPendingRowBatches(), true, 'call 1\'s still-pending row must survive call 2 finishing first');

  batch1.flush();
  batch1.cancel();
  release1();
  assert.equal(hasPendingRowBatches(), false);
});
