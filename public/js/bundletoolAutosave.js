/**
 * BunTool
 * Copyright (c) 2025-2026 Tris Sherliker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * Licensed under the Mozilla Public License Version 2.0.
 *
 * bundletoolAutosave.js
 * Periodic autosave of app state (source files + form data) to IndexedDB.
 *
 * Triggers:
 *   - A document is added, turned, removed or reordered: save after SETTLE_MS
 *   - Typing: save after TYPING_MS of no further changes
 *   - The page is hidden or unloaded: save what is pending at once
 *   Only when the state has changed since the last save. While a save is pending or running, leaving
 *   the page asks first (see isSavePending); when nothing is pending it never does.
 *
 * What a save writes: the small snapshot record (settings, table order, references) plus the bytes of
 * any document that is not already stored. Each document's bytes are kept once in the 'blobs' store
 * however many snapshots refer to it, so saving after every small change costs a few KB, not a
 * re-read and re-write of every document.
 *
 * Cap: always keep at least 1 snapshot; evict oldest when total exceeds MAX_BYTES or
 *      count exceeds MAX_COUNT.
 */

// STORAGE KEY: DO NOT RENAME. This IndexedDB database holds users' saved
// working documents and finished bundles. Renaming it orphans every existing
// snapshot: the data stays on disk, invisible and unrecoverable through the UI.
const DB_NAME           = 'buntool-autosave';
const DB_VERSION        = 3;   // v3: document bytes live once in the 'blobs' store, not in every snapshot
const MAX_BYTES         = 500 * 1024 * 1024; // 500 MB
const MAX_COUNT         = 20;                // max stored snapshots, all tabs together
const MAX_PER_TAB       = 10;                // max stored snapshots one tab may keep
const INACTIVITY_MS     = 5 * 60 * 1000;    // longest back-off between retries of a failing save
const SETTLE_MS         = 0;                // after a document is added, turned, removed or reordered: at once (a burst in the same tick is still one save)
const MIN_GAP_MS        = 250;              // rapid changes after a save has just begun share the next one
const TYPING_MS         = 1500;             // after typing stops
const BLOB_GRACE_MS     = 60_000;           // a document keyed this recently is never garbage-collected

// Finished bundles are a separate concern from the working-state snapshots
// above: a completed bundle's own bytes never change again, so it gets its
// own store and its own, smaller cap rather than sharing the working-state
// budget and competing with it for eviction.
const BUNDLE_MAX_BYTES  = 300 * 1024 * 1024; // 300 MB
const BUNDLE_MAX_COUNT  = 15;                // max stored finished bundles

import { getTabId, setCurrentSnapshot, markClearedNow, getGeneration } from './frontend/tabSession.js';

let _getState   = null;
let _dirty      = false;
let _failures   = 0;     // consecutive failed saves; drives the back-off and the one-time notice
let _timer      = null;
let _db         = null;
let _saving     = null;   // the save in flight, so two never overlap
let _lastStart  = 0;      // when the latest save began, for spacing a burst of rapid changes
let _again      = false;  // something changed while a save was running
// Bumped by every markDirty(). A save captures this when it starts reading state; if the value has
// moved by the time that save finishes, something changed DURING the read/write (a second document
// added while the first was still being saved, for instance), so _dirty must not be cleared: that
// change is not in this save and still needs one of its own. Clearing it regardless would save only
// the first of two files added close together, and tell both beforeunload and the pagehide flush
// that nothing was left to lose.
let _changeSeq  = 0;
let _hasDocuments = () => true;   // set by init: is there anything in the table worth warning about
// set by init: a validated file can sit in state for up to the row batcher's own gap (rowBatch.js,
// up to 2s on a slow device) before its row is inserted and markDirty() fires for it. In that
// window _dirty is still false (nothing has told this module anything changed yet), so without
// this a reload right then would warn no one. It is only reported, and never marks dirty itself:
// there is nothing yet for a save to read a row for, so forcing one here would write a snapshot
// whose file has no row.
let _hasPendingRows = () => false;
const _blobKeys  = new WeakMap();  // File -> the key its bytes are stored under
const _storedKeys = new Set();     // keys known to be in the blobs store
let _storedKnown = false;
let _blobSeq = 0;


// ── IndexedDB helpers ─────────────────────────────────────────────────────────

function _openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = ({ target: { result: db } }) => {
      // Full snapshot data (includes ArrayBuffers for PDF bytes)
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'timestamp' });
      }
      // Lightweight metadata for listing without loading file bytes
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'timestamp' });
      }
      // v2: completed bundles (the generated PDF itself), separate from the
      // working-state snapshots above: see saveFinishedBundle().
      if (!db.objectStoreNames.contains('bundles')) {
        db.createObjectStore('bundles', { keyPath: 'timestamp' });
      }
      if (!db.objectStoreNames.contains('bundlesMeta')) {
        db.createObjectStore('bundlesMeta', { keyPath: 'timestamp' });
      }
      // v3: each document's bytes, once, however many snapshots refer to it.
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'key' });
      }
    };
    req.onsuccess = ({ target: { result: db } }) => { _db = db; resolve(db); };
    req.onerror   = ({ target: { error } })       => reject(error);
  });
}

function _req(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

function _txDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
    tx.onabort    = () => rej(tx.error);
  });
}


// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise with an async callback that returns the current app state to
 * snapshot, or null if there is nothing worth saving.
 * Call this once at app startup.
 *
 * @param {() => Promise<Object|null>} getState
 */
export function init(getState, { hasDocuments, hasPendingRows } = {}) {
  _getState = getState;
  if (hasDocuments) _hasDocuments = hasDocuments;
  if (hasPendingRows) _hasPendingRows = hasPendingRows;
  // Save what is pending the moment the page is hidden or unloaded (tab switch,
  // refresh, close), so a refresh does not throw away what was typed since the
  // last save. Only when something has changed: _performSave() returns at once
  // when nothing is dirty. The write
  // is asynchronous, so on a tab close it is best-effort; visibilitychange
  // fires earlier than pagehide and is the one that normally completes.
  if (typeof document !== 'undefined' && !init._flushBound) {
    init._flushBound = true;
    let flushing = false;
    const flush = async () => {
      // visibilitychange and pagehide both fire on a refresh; one save is enough.
      if (flushing || !_dirty) return;
      flushing = true;
      clearTimeout(_timer);
      try { await _performSave(); } finally { flushing = false; }
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    // Leaving while a save is pending or running asks first, so a refresh a moment after adding or
    // turning a document cannot silently lose it. Never while nothing is pending (no needless warning),
    // and never when saving is failing (the person could not be helped by staying).
    window.addEventListener('beforeunload', (event) => {
      if (!isSavePending()) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }
}

/**
 * True while a change has not reached storage yet: something changed since the last save, or a save
 * is running, and there are documents in the table; OR a validated file is sitting in state with its
 * row not inserted yet (the row batcher's own gap), which a save could not describe correctly even
 * if it tried. False when saving keeps failing: staying could not help either case.
 */
export function isSavePending() {
  if (_failures !== 0) return false;
  return ((_saving !== null || _dirty) && _hasDocuments()) || _hasPendingRows();
}

/**
 * Mark state as changed and schedule an autosave.
 *
 * @param {{ immediate?: boolean }} opts
 *   immediate=true: a document was added, turned, removed or reordered; save at once (SETTLE_MS is 0,
 *                     which still lets changes made in the same tick share one save)
 *   immediate=false: an edit (typing); save after TYPING_MS of quiet
 */
export function markDirty({ immediate = false } = {}) {
  _dirty = true;
  _changeSeq++;
  // While saving keeps failing, edits do not trigger saves at all: a back-off timer (set by the
  // failed save) owns the retry, so a failing save is not repeated after every edit.
  if (_failures > 0) return;
  // A document change is saved a moment later; typing waits until it pauses. Either way one timer,
  // reset by each change, so a burst of edits is one save.
  clearTimeout(_timer);
  // The first change after a quiet moment is saved at once. Changes that follow within MIN_GAP_MS of a
  // save beginning wait for that gap, so forty quick moves are a handful of saves, not forty.
  const wait = immediate ? Math.max(SETTLE_MS, MIN_GAP_MS - (Date.now() - _lastStart)) : TYPING_MS;
  _timer = setTimeout(_performSave, wait);
}

/**
 * Save immediately, bypassing the dirty flag and any pending timer.
 */
export async function saveNow() {
  clearTimeout(_timer);
  _dirty = true;
  await _performSave();
}

/**
 * List saved snapshots, newest first. Returns lightweight metadata only
 * (no file bytes) so callers can show a list without loading large data.
 *
 * @returns {Promise<Array<{ timestamp: number, sizeBytes: number, fileCount: number }>>}
 */
export async function listSnapshots() {
  const db  = await _openDb();
  const all = await _req(db.transaction('meta', 'readonly').objectStore('meta').getAll());
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Load the full snapshot for a given timestamp, including file bytes.
 *
 * @param {number} timestamp
 * @returns {Promise<Object|undefined>}
 */
export async function loadSnapshot(timestamp) {
  const db = await _openDb();
  const snapshot = await _req(db.transaction('snapshots', 'readonly').objectStore('snapshots').get(timestamp));
  if (!snapshot) return snapshot;
  // A copy refers to its documents by key, or holds their bytes inline; both load.
  const blobs = db.transaction('blobs', 'readonly').objectStore('blobs');
  const withBytes = async (entry) => {
    if (!entry?.key) return entry;
    const record = await _req(blobs.get(entry.key));
    if (!record) throw new Error(`saved document ${entry.filename} is missing from storage`);
    return { ...entry, bytes: record.bytes };
  };
  if (snapshot.files?.some((f) => f.key)) snapshot.files = await Promise.all(snapshot.files.map(withBytes));
  if (snapshot.coversheet?.key) snapshot.coversheet = await withBytes(snapshot.coversheet);
  return snapshot;
}

/**
 * Delete a single snapshot by timestamp.
 */
export async function deleteSnapshot(timestamp) {
  const db = await _openDb();
  const tx = db.transaction(['snapshots', 'meta'], 'readwrite');
  tx.objectStore('snapshots').delete(timestamp);
  tx.objectStore('meta').delete(timestamp);
  await _txDone(tx);
  _gcBlobs().catch(() => {});
}

/**
 * Delete all snapshots.
 */
export async function clearAll() {
  const db = await _openDb();
  const tx = db.transaction(['snapshots', 'meta', 'blobs'], 'readwrite');
  tx.objectStore('snapshots').clear();
  tx.objectStore('meta').clear();
  tx.objectStore('blobs').clear();
  _storedKeys.clear();
  return _txDone(tx);
}

/**
 * Deletes the working copies THIS tab saved (and any copy that carries no tab id), leaving
 * other tabs' copies alone: emptying the table in one tab must not destroy another tab's saved work.
 * "Delete all saved copies" (below) is the wipe of everything.
 */
export async function deleteThisTabsSnapshots() {
  const db = await _openDb();
  const all = await _req(db.transaction('meta', 'readonly').objectStore('meta').getAll());
  const mine = getTabId();
  const doomed = all.filter((m) => !m.tabId || m.tabId === mine).map((m) => m.timestamp);
  if (!doomed.length) return;
  const tx = db.transaction(['snapshots', 'meta'], 'readwrite');
  for (const ts of doomed) {
    tx.objectStore('snapshots').delete(ts);
    tx.objectStore('meta').delete(ts);
  }
  await _txDone(tx);
  _gcBlobs().catch(() => {});
}

/**
 * Deletes every copy of the person's work kept on this device: the saved working copies AND the
 * finished bundles. This is what "Delete saved copies" and the bins call; emptying the table on
 * its own only stops the last work coming back; it does not remove what is stored.
 */
export async function deleteAllSavedCopies() {
  const db = await _openDb();
  const stores = ['snapshots', 'meta', 'bundles', 'bundlesMeta', 'blobs'];
  const wipe = async () => {
    const tx = db.transaction(stores, 'readwrite');
    for (const name of stores) tx.objectStore(name).clear();
    await _txDone(tx);
  };
  await wipe();
  // Nothing is saved again until the person changes something: no save may be pending or in flight
  // (the generation bump makes a save already reading documents discard itself), and a tab that is
  // hidden or closed afterwards must not write the table straight back.
  _storedKeys.clear();
  _dirty = false;
  _again = false;
  clearTimeout(_timer);
  markClearedNow();
  // A save that was already writing documents may have finished after the wipe (it discards its own
  // snapshot, but its documents' bytes are already in): wait for it, then wipe again so nothing stays.
  if (_saving) {
    await _saving.catch(() => {});
    await wipe();
    _storedKeys.clear();
  }
}


// ── Finished bundles ─────────────────────────────────────────────────────────
// The generated PDF is otherwise only ever held in memory as a Uint8Array for
// download: a refresh loses it and the whole bundle has to be rebuilt from
// scratch. This persists it the same way source files already are: locally,
// in IndexedDB, never uploaded anywhere. Call from the same place the
// "bundle ready" state is shown, so it's saved by the time the user sees it.

/**
 * @param {Uint8Array} pdfBytes
 * @param {string} filename
 */
export async function saveFinishedBundle(pdfBytes, filename) {
  const timestamp = Date.now();
  const sizeBytes  = pdfBytes.byteLength;

  try {
    const db = await _openDb();
    const tx = db.transaction(['bundles', 'bundlesMeta'], 'readwrite');
    tx.objectStore('bundles').put({ timestamp, filename, bytes: pdfBytes });
    tx.objectStore('bundlesMeta').put({ timestamp, filename, sizeBytes });
    await _txDone(tx);
    await _enforceBundleCap();
    // The filename is the case name plus the claim number; size alone is
    // enough for a console line on a shared machine.
    console.log(`[autosave] Saved finished bundle · ${_fmtBytes(sizeBytes)}`);
  } catch (err) {
    // Non-fatal: the user already has the PDF via the download button that
    // triggered this, so a failed local save must not surface as an error.
    console.warn('[autosave] Finished-bundle save failed:', err);
  }
}

/**
 * List saved finished bundles, newest first. Metadata only (no bytes).
 * @returns {Promise<Array<{ timestamp: number, filename: string, sizeBytes: number }>>}
 */
export async function listFinishedBundles() {
  const db  = await _openDb();
  const all = await _req(db.transaction('bundlesMeta', 'readonly').objectStore('bundlesMeta').getAll());
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Load a finished bundle's full bytes for a given timestamp.
 * @returns {Promise<{ timestamp: number, filename: string, bytes: Uint8Array }|undefined>}
 */
export async function loadFinishedBundle(timestamp) {
  const db = await _openDb();
  return _req(db.transaction('bundles', 'readonly').objectStore('bundles').get(timestamp));
}

export async function deleteFinishedBundle(timestamp) {
  const db = await _openDb();
  const tx = db.transaction(['bundles', 'bundlesMeta'], 'readwrite');
  tx.objectStore('bundles').delete(timestamp);
  tx.objectStore('bundlesMeta').delete(timestamp);
  return _txDone(tx);
}

async function _enforceBundleCap() {
  const db  = await _openDb();
  const all = await _req(db.transaction('bundlesMeta', 'readonly').objectStore('bundlesMeta').getAll());
  all.sort((a, b) => a.timestamp - b.timestamp); // oldest first

  let total      = all.reduce((s, m) => s + m.sizeBytes, 0);
  const toDelete = [];

  while (
    (total > BUNDLE_MAX_BYTES || all.length - toDelete.length > BUNDLE_MAX_COUNT) &&
    all.length - toDelete.length > 1
  ) {
    const oldest = all[toDelete.length];
    total -= oldest.sizeBytes;
    toDelete.push(oldest.timestamp);
  }

  if (!toDelete.length) return;

  const tx = db.transaction(['bundles', 'bundlesMeta'], 'readwrite');
  for (const ts of toDelete) {
    tx.objectStore('bundles').delete(ts);
    tx.objectStore('bundlesMeta').delete(ts);
  }
  await _txDone(tx);
  console.log(`[autosave] Evicted ${toDelete.length} old finished bundle(s) to stay under cap`);
}


// ── Internal ──────────────────────────────────────────────────────────────────

/**
 * One save at a time. A change that arrives while one is running is picked up by a follow-up save
 * when it ends, never by a second save running beside it.
 */
function _performSave() {
  if (_saving) { _again = true; return _saving; }
  _lastStart = Date.now();
  _saving = (async () => {
    try { await _withWriteLock(_saveOnce); }
    finally {
      _saving = null;
      if (_again) { _again = false; if (_dirty) _performSave(); }
    }
  })();
  return _saving;
}

/** One writer at a time across every tab of this site (where the browser has Web Locks). */
function _withWriteLock(fn) {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('buntool-autosave-write', fn);
  return fn();
}

async function _saveOnce() {
  if (!_dirty || !_getState) return;

  // Captured before anything async runs: if markDirty() bumps this again before the save below
  // finishes, a real change arrived mid-save that this save's own _getState() read may or may not
  // have seen, and _dirty must stay true so it gets a save of its own rather than being silently
  // declared "saved" alongside this one.
  const seqAtStart = _changeSeq;

  // The table can be emptied, or every saved copy deleted, while this save is still reading documents.
  // Such a save describes what was just cleared and must not be written (getGeneration is bumped by both).
  const generation = getGeneration();
  let state;
  try {
    state = await _getState();
  } catch (err) {
    console.warn('[autosave] getState() threw:', err);
    return;
  }
  if (generation !== getGeneration()) return;
  if (!state?.files?.length) {
    // Rows still being added (the row batcher's gap) have documents in state but none in the table yet, so
    // the state reads as empty without anything having been cleared: leave the saved copies alone, and
    // leave the change pending for the save the first inserted row triggers.
    if (_hasPendingRows()) return;
    // Nothing to save: the table is empty. If it was emptied by hand (something changed since the
    // last save), older saves must not come back on the next load (frontend/autoRestore.js).
    markClearedNow();
    if (_changeSeq === seqAtStart) _dirty = false;
    return;
  }

  const timestamp   = Date.now();
  const fileCount   = state.files.length;
  const bundleTitle = state.config?.bundleTitle || state.config?.heading?.bundleTitle || '';
  const projectName = state.config?.projectName || state.config?.heading?.projectName || '';

  try {
    const db = await _openDb();
    // The documents' bytes go in once each (only those not stored yet); the snapshot then refers to
    // them by key, so it is a few KB however large the bundle is.
    const stored = await _storeBlobs(db, state, generation);
    if (!stored) return;   // cleared while the bytes were being written
    const { files, coversheet, blobKeys, sizeBytes } = stored;
    const tx = db.transaction(['snapshots', 'meta'], 'readwrite');
    // tabId: which tab wrote this (frontend/tabSession.js), so a refresh restores its own work first.
    const tabId = getTabId();
    tx.objectStore('snapshots').put({ timestamp, tabId, ...state, files, coversheet });
    tx.objectStore('meta').put({ timestamp, tabId, sizeBytes, fileCount, bundleTitle, projectName, blobKeys });
    await _txDone(tx);

    // Cleared while the write was under way: take the copy straight back out again.
    if (generation !== getGeneration()) {
      await deleteSnapshot(timestamp).catch(() => {});
      return;
    }

    await _enforceCap();

    // Only declare the table clean if nothing changed while this save was reading and writing it.
    // If markDirty() ran again in between, that change is not in the snapshot just written, so
    // _dirty must stay true: the pending timer markDirty() already scheduled for it will call
    // _performSave() again, and this time _dirty correctly still says there is work to do.
    if (_changeSeq === seqAtStart) _dirty = false;
    _failures = 0;
    setCurrentSnapshot(timestamp);
    console.log(`[autosave] Saved ${new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${fileCount} doc(s) · ${_fmtBytes(sizeBytes)}`);
    // The header's Autosaved note listens for this. Guarded: this module is
    // also imported under Node, where there is no document.
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('bundletool:autosaved', { detail: { fileCount, sizeBytes } }));
    }
  } catch (err) {
    console.warn('[autosave] Save failed:', err);
    _failures++;
    // Storage full: free room by dropping the oldest saved copy (never the only one) before the retry.
    const quota = err?.name === 'QuotaExceededError';
    if (quota) { try { await _evictOldest(); } catch { /* the retry will report it */ } }
    // Back off instead of retrying on every edit, which would re-read every document each time.
    clearTimeout(_timer);
    _timer = setTimeout(_performSave, Math.min(30_000 * 2 ** (_failures - 1), INACTIVITY_MS * 2));
    if (_failures === 1 && typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('bundletool:autosave-failed', { detail: { quota } }));
    }
  }
}

/** Deletes the oldest saved working copy that is not some tab's newest (a tab's only way back). */
async function _evictOldest() {
  const db  = await _openDb();
  const all = await _req(db.transaction('meta', 'readonly').objectStore('meta').getAll());
  if (all.length < 2) return;
  const [oldest] = chooseCopiesToDelete(all, { maxCount: all.length - 1, maxBytes: Infinity, maxPerTab: Infinity })
    .sort((x, y) => x - y);
  if (oldest !== undefined) await deleteSnapshot(oldest);
}

/**
 * Which saved copies to delete so the store stays within its limits, oldest first.
 *
 *  - A tab keeps at most MAX_PER_TAB copies, so one tab that saves often cannot fill the store.
 *  - Then the total is brought under MAX_COUNT and MAX_BYTES, but a tab's newest copy is never chosen:
 *    it is that tab's only way back, and another tab's churn must not delete it.
 *
 * Pure, so it is tested. Copies with no tab id count as one group.
 *
 * @param {Array<{timestamp:number, sizeBytes:number, tabId?:string}>} all
 * @returns {number[]} timestamps to delete
 */
export function chooseCopiesToDelete(all, { maxCount = MAX_COUNT, maxBytes = MAX_BYTES, maxPerTab = MAX_PER_TAB } = {}) {
  const sorted = [...all].sort((a, b) => a.timestamp - b.timestamp);   // oldest first
  const doomed = new Set();
  const newestOf = new Map();
  for (const m of sorted) newestOf.set(m.tabId ?? '', m.timestamp);
  const isNewestOfItsTab = (m) => newestOf.get(m.tabId ?? '') === m.timestamp;

  const perTab = new Map();
  for (const m of [...sorted].reverse()) {           // newest first within each tab
    const key = m.tabId ?? '';
    const n = (perTab.get(key) ?? 0) + 1;
    perTab.set(key, n);
    if (n > maxPerTab) doomed.add(m.timestamp);
  }

  let total = sorted.reduce((sum, m) => sum + (doomed.has(m.timestamp) ? 0 : m.sizeBytes), 0);
  let count = sorted.length - doomed.size;
  for (const m of sorted) {
    if (count <= maxCount && total <= maxBytes) break;
    if (doomed.has(m.timestamp) || isNewestOfItsTab(m)) continue;
    doomed.add(m.timestamp);
    total -= m.sizeBytes;
    count--;
  }
  return [...doomed];
}

async function _enforceCap() {
  const db  = await _openDb();
  const all = await _req(db.transaction('meta', 'readonly').objectStore('meta').getAll());
  const toDelete = chooseCopiesToDelete(all);
  if (!toDelete.length) return;

  const tx = db.transaction(['snapshots', 'meta'], 'readwrite');
  for (const ts of toDelete) {
    tx.objectStore('snapshots').delete(ts);
    tx.objectStore('meta').delete(ts);
  }
  await _txDone(tx);
  console.log(`[autosave] Evicted ${toDelete.length} old snapshot(s) to stay under cap`);
  _gcBlobs().catch(() => {});
}

/**
 * Writes the bytes of every document (and the coversheet) that is not stored yet, one at a time so only
 * one document's bytes are in memory. Returns the references the snapshot keeps in their place, or null
 * if everything was cleared meanwhile.
 */
async function _storeBlobs(db, state, generation) {
  if (!_storedKnown) {
    for (const key of await _req(db.transaction('blobs', 'readonly').objectStore('blobs').getAllKeys())) _storedKeys.add(key);
    _storedKnown = true;
  }
  let sizeBytes = 10_000;   // about 10 KB for the settings and table order
  const blobKeys = [];
  const put = async (file) => {
    const key = blobKeyFor(file);
    // _storedKeys is this tab's memory of what is stored. Another tab's clean-up may have removed a blob
    // since (once no saved copy referred to it), so a remembered key is confirmed against the store
    // before it is trusted: a snapshot must never point at bytes that are gone.
    let present = _storedKeys.has(key);
    if (present) {
      present = (await _req(db.transaction('blobs', 'readonly').objectStore('blobs').count(key))) > 0;
      if (!present) _storedKeys.delete(key);
    }
    if (!present) {
      const bytes = await file.arrayBuffer();
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put({ key, bytes, size: bytes.byteLength });
      await _txDone(tx);
      _storedKeys.add(key);
    }
    blobKeys.push(key);
    sizeBytes += file.size;
    return { key, size: file.size };
  };
  const files = [];
  for (const { filename, file } of state.files) {
    if (generation !== getGeneration()) return null;
    files.push({ filename, ...(await put(file)) });
  }
  let coversheet = null;
  if (state.coversheet) {
    const { filename, file, converted } = state.coversheet;
    coversheet = { filename, ...(await put(file)), ...(converted ? { converted: true } : {}) };
  }
  return { files, coversheet, blobKeys, sizeBytes };
}

/** The key a document's bytes are (or will be) stored under: the same File is always the same key. */
export function blobKeyFor(file) {
  let key = _blobKeys.get(file);
  if (!key) {
    key = `${getTabId()}-${Date.now().toString(36)}-${(++_blobSeq).toString(36)}-${file.size}`;
    _blobKeys.set(file, key);
  }
  return key;
}

/** Tells the autosave a restored File is already stored under this key, so it is not written again. */
export function rememberBlobKey(file, key) {
  if (!key) return;
  _blobKeys.set(file, key);
  _storedKeys.add(key);
}

/**
 * Which stored documents no saved copy refers to any more, and are old enough to be sure nobody is
 * about to refer to them. Pure, so it is tested.
 *
 * @param {string[]} stored every key in the blobs store
 * @param {Array<{blobKeys?: string[]}>} metas the saved copies
 * @param {number} now
 * @returns {string[]}
 */
export function orphanBlobs(stored, metas, now = Date.now(), grace = BLOB_GRACE_MS) {
  const live = new Set();
  for (const m of metas) for (const key of m.blobKeys || []) live.add(key);
  return stored.filter((key) => {
    if (live.has(key)) return false;
    const stamp = parseInt(key.split('-')[1] || '', 36);   // when the File was first keyed
    return Number.isFinite(stamp) && stamp > 1e11 && now - stamp > grace;   // a key that cannot be dated is left alone
  });
}

/**
 * Deletes stored documents no saved copy refers to. Done under a lock shared by every tab, so it never
 * runs between another tab writing a document and writing the snapshot that refers to it.
 */
async function _gcBlobs() {
  if (typeof navigator === 'undefined' || !navigator.locks) return;   // without locks, leave them: a small waste, never a loss
  await navigator.locks.request('buntool-autosave-write', async () => {
    const db = await _openDb();
    const metas = await _req(db.transaction('meta', 'readonly').objectStore('meta').getAll());
    const stored = await _req(db.transaction('blobs', 'readonly').objectStore('blobs').getAllKeys());
    const doomed = orphanBlobs(stored, metas);
    if (!doomed.length) return;
    const tx = db.transaction('blobs', 'readwrite');
    for (const key of doomed) { tx.objectStore('blobs').delete(key); _storedKeys.delete(key); }
    await _txDone(tx);
  });
}

function _fmtBytes(n) {
  if (n < 1024)       return `${n} B`;
  if (n < 1024 ** 2)  return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
