/**
 * Which saved working copies are deleted to stay within the limits, and the "generation" that stops a
 * save that started before a clear from being written after it. Both are pure or in-memory, so they
 * run under Node without a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseCopiesToDelete, orphanBlobs, isSavePending, init, markDirty } from '../public/js/bundletoolAutosave.js';
import { getGeneration, bumpGeneration, markClearedNow } from '../public/js/frontend/tabSession.js';

const copy = (timestamp, tabId, sizeBytes = 100) => ({ timestamp, tabId, sizeBytes });

test('nothing is deleted while every limit holds', () => {
  assert.deepEqual(chooseCopiesToDelete([copy(1, 'A'), copy(2, 'B'), copy(3, 'A')]), []);
});

test('one tab that saves often is held to its own share and cannot fill the store', () => {
  const all = [];
  for (let i = 1; i <= 15; i++) all.push(copy(i, 'A'));
  all.push(copy(100, 'B'));
  const doomed = chooseCopiesToDelete(all, { maxPerTab: 10 }).sort((a, b) => a - b);
  assert.deepEqual(doomed, [1, 2, 3, 4, 5]);           // A's five oldest
  assert.ok(!doomed.includes(100));                     // B's only copy is untouched
});

test('the total limit never deletes a tab\'s newest copy, however old', () => {
  // B's only copy is the oldest of all; A has many newer ones
  const all = [copy(1, 'B')];
  for (let i = 2; i <= 12; i++) all.push(copy(i, 'A'));
  const doomed = chooseCopiesToDelete(all, { maxCount: 5, maxPerTab: 100 });
  assert.ok(!doomed.includes(1), 'B\'s only copy survives');
  assert.ok(!doomed.includes(12), 'A\'s newest copy survives');
  assert.equal(all.length - doomed.length, 5);
});

test('the byte limit also spares each tab\'s newest copy, even when it alone is over the limit', () => {
  const all = [copy(1, 'A', 600), copy(2, 'B', 600)];
  assert.deepEqual(chooseCopiesToDelete(all, { maxBytes: 100, maxCount: 20 }), []);
  const more = [...all, copy(3, 'A', 600)];
  assert.deepEqual(chooseCopiesToDelete(more, { maxBytes: 1300, maxCount: 20 }), [1]);
});

test('copies with no tab id are one group and are handled like any other tab', () => {
  const all = [{ timestamp: 1, sizeBytes: 10 }, { timestamp: 2, sizeBytes: 10 }, { timestamp: 3, sizeBytes: 10 }];
  assert.deepEqual(chooseCopiesToDelete(all, { maxCount: 2, maxPerTab: 100 }), [1]);
});

test('emptying the table or deleting everything bumps the generation, so an in-flight save discards itself', () => {
  const before = getGeneration();
  markClearedNow();
  assert.equal(getGeneration(), before + 1);
  bumpGeneration();
  assert.equal(getGeneration(), before + 2);
});

const keyAt = (tab, ms, n = 1, size = 10) => `${tab}-${ms.toString(36)}-${n.toString(36)}-${size}`;

test('a stored document no saved copy refers to is garbage, but only once it is old enough', () => {
  const now = 1_790_000_000_000;
  const old = keyAt('A', now - 10 * 60_000);
  const recent = keyAt('B', now - 5_000);
  const kept = keyAt('A', now - 20 * 60_000, 2);
  const orphans = orphanBlobs([old, recent, kept], [{ blobKeys: [kept] }, {}], now);
  assert.deepEqual(orphans, [old], 'the old unreferenced one only: the recent one may be about to be referenced');
});

test('a document shared by several saved copies stays while any of them exists', () => {
  const now = 1_790_000_000_000;
  const shared = keyAt('A', now - 60 * 60_000);
  assert.deepEqual(orphanBlobs([shared], [{ blobKeys: [shared] }, { blobKeys: [shared] }], now), []);
  assert.deepEqual(orphanBlobs([shared], [{ blobKeys: [shared] }], now), []);
  assert.deepEqual(orphanBlobs([shared], [], now), [shared], 'when the last copy is gone it goes too');
});

test('a key that cannot be read is never collected', () => {
  assert.deepEqual(orphanBlobs(['odd', 'a-b', 'a-b-c-d'], [], 1_790_000_000_000), []);
});

test('nothing asks the person to stay while nothing is waiting to be saved', () => {
  assert.equal(isSavePending(), false);
});

// beforeunload's own handler (bundletoolAutosave.js init()) only warns when isSavePending() is
// true, so these pin the "unnecessary" side directly: a change here changes what the page warns
// about, not just this pure helper.
test('an empty table never asks to stay, even mid-edit', () => {
  init(async () => null, { hasDocuments: () => false });
  markDirty({ immediate: true });
  assert.equal(isSavePending(), false);
});

test('a dirty table with documents does ask to stay', () => {
  init(async () => null, { hasDocuments: () => true });
  markDirty({ immediate: true });
  assert.equal(isSavePending(), true);
});
