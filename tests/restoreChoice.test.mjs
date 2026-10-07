/**
 * Which saved copy a tab restores, when its form draft may be laid over it, and how the crash flag
 * behaves across tabs. Refreshing one tab must never show another matter's documents under this
 * tab's title and parties.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSnapshotToRestore, setCurrentSnapshot, getCurrentSnapshot } from '../public/js/frontend/tabSession.js';
import { makeDraft, usableDraft } from '../public/js/frontend/draftFormat.js';

const snap = (timestamp, tabId) => ({ timestamp, tabId });
const base = { tabId: 'A', hasDraft: false, crashed: false, clearedAt: 0 };

test('a tab restores its OWN newest copy even when another tab saved later', () => {
  const snapshots = [snap(300, 'B'), snap(200, 'A'), snap(100, 'A')];
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots, hasDraft: true }).timestamp, 200);
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots }).timestamp, 200);
});

test('a continuing tab (it has a draft) with no copy of its own restores nothing, never another tab\'s', () => {
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots: [snap(300, 'B')], hasDraft: true }), null);
});

test('a brand new tab restores the newest copy anywhere: the last session', () => {
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots: [snap(300, 'B'), snap(200, 'C')] }).timestamp, 300);
  // a copy that carries no tab id counts too
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots: [{ timestamp: 50 }] }).timestamp, 50);
});

test('emptying the table on purpose stops older copies coming back, except after a crash', () => {
  const snapshots = [snap(100, 'A')];
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots, clearedAt: 100 }), null);
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots, clearedAt: 500, crashed: true }).timestamp, 100);
});

test('one tab clearing its table does not hide another tab\'s saved work', () => {
  const snapshots = [snap(300, 'B'), snap(100, 'A')];
  // tab B cleared at 400: shared marker moves, tab A's own marker does not
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots, hasDraft: true, clearedAt: { tab: 0, global: 400 } }).timestamp, 100);
  // ...but a brand new tab does not bring back a session that was just cleared
  assert.equal(chooseSnapshotToRestore({ ...base, tabId: 'C', snapshots, clearedAt: { tab: 0, global: 400 } }), null);
  // and a tab that cleared itself does not get its own older copy back
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots, hasDraft: true, clearedAt: { tab: 150, global: 150 } }), null);
});

test('after a crash a tab with a draft but no copy of its own may use the newest copy', () => {
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots: [snap(300, 'B')], hasDraft: true, crashed: true }).timestamp, 300);
});

test('nothing saved: nothing restored', () => {
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots: [] }), null);
});

test('a draft is laid over the snapshot it was taken with, and over no other', () => {
  const draft = makeDraft({ bundleTitle: 'Matter A' }, 200);
  assert.deepEqual(usableDraft(draft, 200), { bundleTitle: 'Matter A' });
  assert.equal(usableDraft(draft, 300), null);   // another snapshot was restored
  assert.equal(usableDraft(draft, null), null);  // none restored
  const early = makeDraft({ bundleTitle: 'typed with no documents' }, null);
  assert.deepEqual(usableDraft(early, null), { bundleTitle: 'typed with no documents' });
  assert.equal(usableDraft(early, 100), null);
});

test('drafts in an old or damaged format are ignored', () => {
  for (const d of [null, undefined, 5, 'x', [], { bundleTitle: 'old plain draft' }, { v: 1, config: {} }, { v: 2, snapshotTs: null }, { v: 2, snapshotTs: null, config: [] }]) {
    assert.equal(usableDraft(d, null), null);
  }
});

test('the tab remembers which snapshot its form matches', () => {
  setCurrentSnapshot(42);
  assert.equal(getCurrentSnapshot(), 42);
  setCurrentSnapshot(null);
  assert.equal(getCurrentSnapshot(), null);
  setCurrentSnapshot('x');
  assert.equal(getCurrentSnapshot(), null);
});

// ── crash flag across tabs ───────────────────────────────────────────────────
function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('the crash flag: own tab and dead tabs count, a live build in another tab does not', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: session, configurable: true });
  try {
    const { getTabId } = await import('../public/js/frontend/tabSession.js');
    const { markBuildStarted, markBuildFinished, readUnfinishedBuild, HEARTBEAT_STALE_MS } = await import('../public/js/frontend/crashGuard.js');
    const me = getTabId();
    const KEY = 'buntool_build_in_progress';

    // This tab started a build and was refreshed: a crash to report.
    markBuildStarted({ files: 3 });
    assert.equal(readUnfinishedBuild()?.files, 3);
    markBuildFinished();
    assert.equal(readUnfinishedBuild(), null);
    assert.equal(local.getItem(KEY), null);

    // Another tab is building right now: not a crash, and its flag is not deleted by us.
    local.setItem(KEY, JSON.stringify({ startedAt: Date.now(), heartbeat: Date.now(), tabId: 'someone-else', files: 9 }));
    assert.equal(readUnfinishedBuild(), null);
    markBuildFinished();
    assert.ok(local.getItem(KEY), 'a live build in another tab must keep its flag');

    // Another tab that stopped beating (it died): a crash to report, and ours to clear.
    const old = Date.now() - HEARTBEAT_STALE_MS - 1000;
    local.setItem(KEY, JSON.stringify({ startedAt: old, heartbeat: old, tabId: 'someone-else', files: 9 }));
    assert.equal(readUnfinishedBuild()?.files, 9);
    markBuildFinished();
    assert.equal(local.getItem(KEY), null);

    // A flag with no tab id is treated as a crash.
    local.setItem(KEY, JSON.stringify({ startedAt: Date.now(), files: 1 }));
    assert.equal(readUnfinishedBuild()?.files, 1);
    assert.ok(me);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
  }
});

// ── a dead tab's crash, and what counts as a form draft ──────────────────────

test('a new tab that finds a dead tab\'s crash flag restores THAT tab\'s copies, not the newest anywhere', () => {
  const snapshots = [snap(300, 'C'), snap(200, 'DEAD'), snap(100, 'DEAD')];
  const chosen = chooseSnapshotToRestore({ ...base, snapshots, crashed: true, crashedTabId: 'DEAD', clearedAt: 250 });
  assert.equal(chosen.timestamp, 200);   // and a clearing does not hide a crashed build's copies
  // a crash with no copies from the dead tab falls back to the newest anywhere
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots: [snap(300, 'C')], crashed: true, crashedTabId: 'DEAD' }).timestamp, 300);
});

test('an emptied table is not resurrected by a dead tab\'s crash flag, except its own crashed build', () => {
  const snapshots = [snap(100, 'DEAD')];
  assert.equal(chooseSnapshotToRestore({ ...base, snapshots, crashed: false, clearedAt: 500 }), null);
});

test('a draft in an older format is no draft at all', async () => {
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const { hasFormDraft, DRAFT_KEY } = await import('../public/js/frontend/draftFormat.js');
  try {
    assert.equal(hasFormDraft(), false);
    store.set(DRAFT_KEY, JSON.stringify({ claimNumber: 'old flat shape' }));            // written by an older build
    assert.equal(hasFormDraft(), false);
    store.set(DRAFT_KEY, '{not json');
    assert.equal(hasFormDraft(), false);
    store.set(DRAFT_KEY, JSON.stringify(makeDraft({ claimNumber: 'X' }, null)));
    assert.equal(hasFormDraft(), true);
  } finally { delete globalThis.sessionStorage; }
});

test('blocked storage does not throw: the tab id is per page load and nothing is remembered as cleared', async () => {
  const blocked = { get() { throw new DOMException('blocked', 'SecurityError'); } };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: blocked.get });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: blocked.get });
  try {
    const t = await import('../public/js/frontend/tabSession.js');
    const id = t.getTabId();
    assert.equal(typeof id, 'string');
    assert.equal(t.getTabId(), id);
    assert.deepEqual(t.getClearedAt(), { tab: 0, global: 0 });
    assert.doesNotThrow(() => t.markClearedNow());
  } finally { delete globalThis.sessionStorage; delete globalThis.localStorage; }
});
