/**
 * autoRestore.js
 * Puts the last session back when the page opens, without asking.
 *
 * There is no "restore?" question. Autosave already writes the source
 * documents and the form to IndexedDB, so on load the newest save is applied and a notice
 * says so; Clear all documents in the Review Table wipes this tab's saved copies (and "Delete all saved
 * copies" in Rewind or Bundles wipes everything) if it is not wanted. If the last build never finished (the tab closed or ran out of memory), the
 * save from just before it is put back and the notice says that instead.
 *
 * "Not wanted" has to stick: emptying the Review Table leaves the last save behind in
 * IndexedDB (autosave writes nothing while there are no documents), so it would come straight
 * back on the next load. bt-cleared-at records when the table was last emptied on purpose, and
 * only a save newer than that is restored. (A crash restores regardless.)
 */
import { state } from './state.js';
import { readUnfinishedBuild, markBuildFinished } from './crashGuard.js';
import { showProcessingOverlay, hideProcessingOverlay } from './bundleUI.js';
import { getTabId, tabIdReady, getCurrentSnapshot, markClearedNow, getClearedAt, chooseSnapshotToRestore } from './tabSession.js';
import { hasFormDraft } from './draftFormat.js';
import { showPageNotice } from './modals.js';

/** Records that the table was emptied on purpose, so older saves are not brought back. */
export function markTableCleared() {
  markClearedNow();
}

/**
 * @param {Object} deps
 * @param {() => Promise<Array>} deps.listSnapshots
 * @param {(ts: number) => Promise<Object|undefined>} deps.loadSnapshot
 * @param {(snapshot: Object) => Promise<void>} deps.applySnapshot
 * @returns {Promise<number|null>} resolves once anything to restore has been restored, with the
 *   timestamp of the snapshot this tab's form now matches (null when none): the form draft is only
 *   laid over that one
 */
export async function runAutoRestore({ listSnapshots, loadSnapshot, applySnapshot }) {
  // A build flag left by ANOTHER tab that has since died is only this tab's business when this tab is
  // new (no draft, no saved copies of its own): a tab in the middle of a different matter must not be
  // handed a stranger's crash notice or documents. Its flag stays for the next new tab to find.
  const flag = readUnfinishedBuild();
  const foreignFlag = !!flag && !!flag.tabId && flag.tabId !== getTabId();
  document.getElementById('restore-notice-dismiss')?.addEventListener('click', () => {
    document.getElementById('restore-notice')?.classList.add('hidden');
  });

  // Which tab this is has to be settled first: a duplicated tab starts with the original's id.
  await tabIdReady();

  let snapshots = [];
  try {
    snapshots = await listSnapshots();
  } catch (err) {
    console.warn('[autoRestore] could not list snapshots:', err);
  }
  const isNewTab = !hasFormDraft() && !snapshots.some((s) => s.tabId === getTabId());
  const crashed = flag && (!foreignFlag || isNewTab) ? flag : null;
  const newest = chooseSnapshotToRestore({
    snapshots, tabId: getTabId(), hasDraft: hasFormDraft(), crashed: !!crashed, clearedAt: getClearedAt(),
    crashedTabId: crashed && foreignFlag ? flag.tabId : undefined,
  });

  // Documents already in the table (added before this finished) are the user's; leave them.
  if (state.filesMap.size > 0) {
    if (crashed) markBuildFinished();
    return getCurrentSnapshot();
  }

  if (!newest) {
    if (crashed) {
      showPageNotice({
        code: 'BT-RESTORE-01',
        title: "Your last bundle didn't finish",
        message: 'BundleTool was building a bundle when this tab closed or ran out of memory, and no saved copy of the documents was found. You will need to add them again.',
      });
      markBuildFinished();
    }
    return getCurrentSnapshot();
  }

  showProcessingOverlay('Restoring your last session…');
  try {
    const snapshot = await loadSnapshot(newest.timestamp);
    if (!snapshot) return getCurrentSnapshot();
    await applySnapshot(snapshot);
    const time = new Date(newest.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const n = snapshot.files?.length || 0;
    const what = `${n} document${n === 1 ? '' : 's'} and your settings, as saved at ${time}`;
    if (crashed) {
      showPageNotice({
        code: 'BT-RESTORE-02',
        title: "Your last bundle didn't finish",
        message: `BundleTool was building a bundle when this tab closed or ran out of memory. ${what[0].toUpperCase()}${what.slice(1)} (just before the build) are back. You can try again.`,
      });
    } else {
      showPageNotice({
        code: null,
        title: 'Your last session is back',
        message: `${what[0].toUpperCase()}${what.slice(1)}. To start clean, use the bin icons in Basic Information and the Review Table, or Delete saved copies in the menu to remove what this browser has stored.`,
      });
    }
  } catch (err) {
    console.error('[autoRestore] restore failed:', err);
  } finally {
    hideProcessingOverlay();
    if (crashed) markBuildFinished();
  }
  return getCurrentSnapshot();
}
