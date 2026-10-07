/**
 * draftFormat.js
 * The shape of the form draft kept in sessionStorage (formDraft.js), and the rule for when it may be
 * laid over what the page has restored. Pure, so the rule is unit tested.
 *
 * A draft is the form as typed at the moment this tab was hidden or closed. It records which autosave
 * snapshot (if any) the form matched when it was written. It is applied only when the page has just
 * restored that same snapshot (or, for a draft written before any snapshot existed, restored none):
 * a draft laid over a different snapshot mixes one matter's typing with another matter's documents.
 */

const DRAFT_VERSION = 2;
export const DRAFT_KEY = 'bt-form-draft';

/**
 * True when this tab has a form draft in the current format: it is a continuing session, not a new tab.
 * A draft from an older build (a tab left open across a deploy) does not count: it cannot be laid over
 * anything, and treating it as a draft would stop the tab restoring its own work.
 */
export function hasFormDraft() {
  try {
    const raw = globalThis.sessionStorage?.getItem(DRAFT_KEY);
    if (raw == null) return false;
    const draft = JSON.parse(raw);
    return !!draft && typeof draft === 'object' && draft.v === DRAFT_VERSION
      && !!draft.config && typeof draft.config === 'object' && !Array.isArray(draft.config);
  } catch { return false; }
}

/** @param {object} config the form's fields @param {number|null} snapshotTs the snapshot it matched */
export function makeDraft(config, snapshotTs) {
  return { v: DRAFT_VERSION, snapshotTs: typeof snapshotTs === 'number' ? snapshotTs : null, config };
}

/** @returns {object|null} the draft's config when it may be applied over `currentSnapshotTs`, else null */
export function usableDraft(draft, currentSnapshotTs) {
  if (!draft || typeof draft !== 'object' || draft.v !== DRAFT_VERSION) return null;
  if (!draft.config || typeof draft.config !== 'object' || Array.isArray(draft.config)) return null;
  const wanted = typeof currentSnapshotTs === 'number' ? currentSnapshotTs : null;
  return draft.snapshotTs === wanted ? draft.config : null;
}
