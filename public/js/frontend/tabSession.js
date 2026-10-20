/**
 * tabSession.js
 * Which browser tab this is, and which autosave snapshot this tab's form was last in step with.
 *
 * Every tab of BundleTool shares one IndexedDB and one localStorage, so the newest snapshot
 * anywhere is not necessarily this tab's: restoring it when tab A is refreshed after tab B has saved
 * would put B's documents under A's title and party names. Snapshots and the crash flag are tagged with this
 * id so a tab restores its own work first, and the form draft records which snapshot it belongs
 * to so it is only laid over that one (frontend/formDraft.js, frontend/autoRestore.js).
 *
 * sessionStorage on purpose: it survives a refresh of this tab and dies with it. Where storage
 * is blocked the id is per page load, which only means the tab is treated as new.
 */

const TAB_KEY = 'bt-tab-id';
const CLEARED_TAB_KEY = 'bt-cleared-at-tab';
export const CLEARED_GLOBAL_KEY = 'bt-cleared-at';
const PRESENCE_CHANNEL = 'bt-tab-presence';
let memoryId = null;
let currentSnapshot = null;
let generation = 0;

/** sessionStorage, or null when the browser blocks it (merely reading the property can throw). */
function tabStore() {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}
function sharedStore() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * Bumped every time the table is emptied on purpose or everything saved is deleted. A save that
 * started before the bump must not be written: it holds the documents that were just cleared.
 */
export function getGeneration() { return generation; }
export function bumpGeneration() { generation++; }

function randomId() {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function getTabId() {
  try {
    const store = tabStore();
    if (store) {
      let id = store.getItem(TAB_KEY);
      if (!id) { id = randomId(); store.setItem(TAB_KEY, id); }
      return id;
    }
  } catch { /* storage blocked: fall through to a per-page id */ }
  return (memoryId ??= randomId());
}

function replaceTabId() {
  const id = randomId();
  try { tabStore()?.setItem(TAB_KEY, id); } catch { /* storage blocked */ }
  memoryId = id;
  currentSnapshot = null;   // the copies the other tab saved are not this tab's
  return id;
}

let claim = null;

/**
 * Settles which id this tab really owns, once, before anything is restored or saved.
 *
 * "Duplicate tab" in Chrome copies sessionStorage, so the copy starts with the ORIGINAL's id and
 * "Clear all" in one would delete the other's saved work. A tab that is already settled answers a
 * hello for its own id over a BroadcastChannel; a newcomer that hears an answer takes a new id. With
 * no channel (an old browser, or storage blocked) the id is trusted as it is.
 *
 * @returns {Promise<string>} the id this tab will use for the rest of the page's life
 */
export function tabIdReady({ waitMs = 200 } = {}) {
  claim ??= new Promise((resolve) => {
    let channel = null;
    try { channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(PRESENCE_CHANNEL) : null; } catch { channel = null; }
    if (!channel) { resolve(getTabId()); return; }
    const nonce = randomId();
    let settled = false;
    channel.onmessage = (event) => {
      const m = event?.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'hello' && settled && m.nonce !== nonce && m.id === getTabId()) {
        channel.postMessage({ type: 'here', id: m.id, to: m.nonce });
      } else if (m.type === 'here' && !settled && m.to === nonce && m.id === getTabId()) {
        replaceTabId();
        finish();
      }
    };
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(getTabId()); } };
    const timer = setTimeout(finish, waitMs);
    try { channel.postMessage({ type: 'hello', id: getTabId(), nonce }); } catch { finish(); }
  });
  return claim;
}

/**
 * Records that the table was emptied on purpose in this tab. Two markers: one for this tab (its own
 * saved copies older than this are not brought back on a refresh, and emptying here does not stop
 * ANOTHER tab restoring its own work) and a shared one (a brand new tab does not resurrect the last
 * session that was just cleared).
 */
export function markClearedNow() {
  const now = String(Date.now());
  try { tabStore()?.setItem(CLEARED_TAB_KEY, now); } catch { /* storage blocked */ }
  try { sharedStore()?.setItem(CLEARED_GLOBAL_KEY, now); } catch { /* storage blocked */ }
  currentSnapshot = null;
  bumpGeneration();
}

/** @returns {{ tab: number, global: number }} */
export function getClearedAt() {
  const read = (store, key) => { try { return Number(store?.getItem(key)) || 0; } catch { return 0; } };
  return { tab: read(tabStore(), CLEARED_TAB_KEY), global: read(sharedStore(), CLEARED_GLOBAL_KEY) };
}

/** Timestamp of the snapshot this tab last saved or restored, or null when none (an empty table). */
export function getCurrentSnapshot() { return currentSnapshot; }

export function setCurrentSnapshot(timestamp) {
  currentSnapshot = typeof timestamp === 'number' ? timestamp : null;
}

/**
 * Which saved working copy a freshly loaded tab should bring back, if any.
 *
 *  - This tab's own newest copy comes first.
 *  - A tab that has a form draft (it is a continuing session, not a new tab) but no copy of its own
 *    restores nothing: laying another tab's documents under this tab's typed-in title and parties
 *    would give one matter's bundle another matter's documents.
 *  - Otherwise (a new tab, or a tab whose id was lost) the newest copy anywhere is the last session.
 *  - Emptying the table on purpose stops older copies coming back, except after a crash. A copy this
 *    tab saved is hidden only by this tab's clearing, so one tab's Clear All never hides another's work.
 *
 * @param {{ snapshots: Array<{timestamp:number, tabId?:string}>, tabId: string, hasDraft: boolean,
 *           crashed: boolean, clearedAt: {tab:number, global:number}|number, crashedTabId?: string }} input
 *   snapshots newest first; crashedTabId is the dead tab whose build flag this tab is adopting
 * @returns {{timestamp:number, tabId?:string}|null}
 */
export function chooseSnapshotToRestore({ snapshots, tabId, hasDraft, crashed, clearedAt, crashedTabId }) {
  // clearedAt is { tab, global }; a bare number (as some callers and tests pass) is treated as both.
  const cleared = typeof clearedAt === 'number' ? { tab: clearedAt, global: clearedAt } : clearedAt;
  const own = snapshots.filter((s) => s.tabId === tabId);
  // A tab that died mid-build is brought back by the tab that finds its flag: the copies THAT tab saved.
  const theirs = crashed && crashedTabId && crashedTabId !== tabId ? snapshots.filter((s) => s.tabId === crashedTabId) : [];
  let pool;
  if (theirs.length) pool = theirs;
  else if (own.length) pool = own;
  else if (hasDraft && !crashed) pool = [];
  else pool = snapshots;
  const newest = pool[0];
  if (!newest) return null;
  // Copies this tab saved are only hidden by this tab's own clearing; anyone else's by either.
  const limit = own.length && !theirs.length ? cleared.tab : Math.max(cleared.tab, cleared.global);
  if (!crashed && newest.timestamp <= limit) return null;
  return newest;
}
