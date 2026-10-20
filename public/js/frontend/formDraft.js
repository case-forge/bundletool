/**
 * formDraft.js
 * Keeps what is typed in the form across a refresh of the same tab.
 *
 * Autosave snapshots (bundletoolAutosave.js) exist only once documents have
 * been added, so a refresh with no documents, or a refresh inside the autosave
 * window, would come back with only the remembered firm defaults (court, statute
 * line, party labels) and lose the rest of the cover details, Basic Information
 * and the other settings.
 *
 * The draft is the form's fields only, written synchronously when the page is
 * hidden or unloaded and read back once on the next load. sessionStorage, not
 * localStorage, on purpose: it survives a refresh and dies with the tab, so one
 * matter's party names can never be carried into the next session's bundle.
 * Files are not kept here; documents come back through the last-session restore (autoRestore.js).
 *
 * A draft records the autosave snapshot its tab was in step with and is only applied over that same
 * snapshot (draftFormat.js), so refreshing one tab can never lay its typing over another tab's documents.
 */
import { collectFormConfig, applyFormConfig } from './autosave.js';
import { refreshCoverStatus } from './coversheet.js';
import { getCurrentSnapshot } from './tabSession.js';
import { makeDraft, usableDraft, hasFormDraft, DRAFT_KEY } from './draftFormat.js';

export { hasFormDraft };

const KEY = DRAFT_KEY;

function saveDraft() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(makeDraft(collectFormConfig(), getCurrentSnapshot())));
  } catch { /* storage blocked or full: a refresh simply loses the draft */ }
}

/** Reads the draft back into the form. Call once the page has settled. */
export function restoreFormDraft() {
  let draft = null;
  try {
    const raw = sessionStorage.getItem(KEY);
    draft = raw ? JSON.parse(raw) : null;
  } catch { draft = null; }
  const config = usableDraft(draft, getCurrentSnapshot());
  if (!config) return;
  applyFormConfig(config);
  // The cover status line reads the generateCover checkbox just restored. Only
  // re-render it: setCoversheetSelected(null) would also throw away an uploaded
  // coversheet that the restore just brought back.
  refreshCoverStatus();
}

/** Starts writing the draft whenever the page is hidden or unloaded. */
export function setupFormDraft() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveDraft();
  });
  window.addEventListener('pagehide', saveDraft);
}
