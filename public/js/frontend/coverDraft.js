/**
 * coverDraft.js
 *
 * What is typed into the coversheet maker would be lost the moment it is closed without pressing
 * "Use this coversheet" (Cancel, the close button, or a crash mid-edit), because coverEditor.js only
 * writes the fields back to the real bundle inside useCoversheet() itself (deliberately: a draft
 * must never become the real cover on its own). This keeps a copy of what was typed, per tab, in
 * sessionStorage: the same tier tabSession.js uses for "survives a refresh of this tab and dies
 * with it", so a draft is exactly as durable as the rest of the tab's own state and no more.
 *
 * A draft is read back into the dialog on open, never into the real bundle: the person still has
 * to press "Use this coversheet" to make it real, same as any other edit here.
 */
import { getTabId } from './tabSession.js';

function draftStore() {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

function draftKey() {
  return `bt-cover-draft-${getTabId()}`;
}

/** Every field inside the cover editor's own fields area, by id: its value, or its checked state for a checkbox or radio. */
export function collectDraftFields(fieldsRoot) {
  const out = {};
  if (!fieldsRoot) return out;
  fieldsRoot.querySelectorAll('[id]').forEach((el) => {
    if (el.tagName === 'BUTTON') return;
    if (el.type === 'checkbox' || el.type === 'radio') out[el.id] = el.checked;
    else if ('value' in el) out[el.id] = el.value;
  });
  return out;
}

/** Writes every field back onto the elements they came from. Unknown ids (an old draft, a removed setting) are skipped. */
export function applyDraftFields(fieldsRoot, fields) {
  if (!fieldsRoot || !fields) return;
  for (const [id, value] of Object.entries(fields)) {
    const el = fieldsRoot.querySelector(`#${CSS.escape(id)}`);
    if (!el) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!value;
    else if ('value' in el) el.value = value;
  }
}

export function saveDraft(fieldsRoot) {
  const store = draftStore();
  if (!store) return;
  try {
    store.setItem(draftKey(), JSON.stringify({ fields: collectDraftFields(fieldsRoot), savedAt: Date.now() }));
  } catch { /* storage full or blocked: the draft is best effort */ }
}

/** @returns {{fields: Object, savedAt: number}|null} */
export function loadDraft() {
  const store = draftStore();
  if (!store) return null;
  try {
    const raw = store.getItem(draftKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    return isPlainObject(parsed) && isPlainObject(parsed.fields) ? parsed : null;
  } catch { return null; }
}

export function clearDraft() {
  const store = draftStore();
  if (!store) return;
  try { store.removeItem(draftKey()); } catch { /* storage blocked */ }
}
