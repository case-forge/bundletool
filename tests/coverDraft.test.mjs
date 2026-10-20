/**
 * coverDraft.js: the cover editor's per-tab draft, kept so closing the coversheet maker without
 * pressing "Use this coversheet" (or a crash mid-edit) does not lose what was typed.
 *
 * sessionStorage is undefined under plain Node, so it is stubbed here for the round-trip tests
 * and removed again afterwards; collectDraftFields()/applyDraftFields() take an explicit root
 * rather than reaching for `document`, so they are tested with a small hand-built DOM stand-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDraftFields, applyDraftFields, saveDraft, loadDraft, clearDraft } from '../public/js/frontend/coverDraft.js';

// applyDraftFields wraps every id in CSS.escape(); Node has no CSS global, so a plain stand-in
// (none of the ids used here need real escaping).
globalThis.CSS ??= { escape: (s) => s };

/** The tiny slice of a DOM element the module actually reads or writes. */
function makeField(id, { type = 'text', value = '', checked = false } = {}) {
  return { id, tagName: type === 'button' ? 'BUTTON' : 'INPUT', type, value, checked };
}
/** The tiny slice of an Element/Document the module actually calls: querySelectorAll('[id]') and querySelector('#id'). */
function makeRoot(fields) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return {
    querySelectorAll: () => fields,
    querySelector: (sel) => byId.get(sel.slice(1)) ?? null, // sel is always "#id" here
  };
}

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

/** Runs fn with a fresh in-memory sessionStorage, then restores whatever was there before. */
function withSessionStorage(fn) {
  const prev = globalThis.sessionStorage;
  globalThis.sessionStorage = new FakeStorage();
  try { fn(); } finally {
    if (prev === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = prev;
  }
}

test('collectDraftFields reads text fields by value and checkboxes/radios by checked, and skips buttons', () => {
  const root = makeRoot([
    makeField('ce-courtName', { value: 'IN THE FAMILY COURT' }),
    makeField('ce-bundleTitle', { value: '' }),
    makeField('ce-printable', { type: 'checkbox', checked: true }),
    makeField('cover-editor-use', { type: 'button' }),
  ]);
  assert.deepEqual(collectDraftFields(root), { 'ce-courtName': 'IN THE FAMILY COURT', 'ce-bundleTitle': '', 'ce-printable': true });
});

test('collectDraftFields on a missing root, and applyDraftFields with no draft or no root, do nothing and do not throw', () => {
  assert.deepEqual(collectDraftFields(null), {});
  const root = makeRoot([makeField('ce-courtName', { value: 'unchanged' })]);
  applyDraftFields(root, null);
  assert.equal(root.querySelector('#ce-courtName').value, 'unchanged');
  assert.doesNotThrow(() => applyDraftFields(null, { 'ce-courtName': 'ignored' }));
});

test('applyDraftFields writes text fields and checkbox state back, and silently skips an id the root no longer has', () => {
  const root = makeRoot([
    makeField('ce-courtName', { value: '' }),
    makeField('ce-printable', { type: 'checkbox', checked: false }),
  ]);
  applyDraftFields(root, { 'ce-courtName': 'IN THE FAMILY COURT', 'ce-printable': true, 'ce-removed-setting': 'x' });
  assert.equal(root.querySelector('#ce-courtName').value, 'IN THE FAMILY COURT');
  assert.equal(root.querySelector('#ce-printable').checked, true);
});

test('saveDraft then loadDraft round-trips the same fields, timestamped', () => {
  withSessionStorage(() => {
    const root = makeRoot([makeField('ce-courtName', { value: 'IN THE FAMILY COURT' })]);
    const before = Date.now();
    saveDraft(root);
    const draft = loadDraft();
    assert.ok(draft, 'a draft was saved');
    assert.deepEqual(draft.fields, { 'ce-courtName': 'IN THE FAMILY COURT' });
    assert.ok(draft.savedAt >= before);
  });
});

test('loadDraft is null when nothing was saved, and again after clearDraft removes what was', () => {
  withSessionStorage(() => {
    assert.equal(loadDraft(), null);
    saveDraft(makeRoot([makeField('ce-courtName', { value: 'x' })]));
    assert.ok(loadDraft());
    clearDraft();
    assert.equal(loadDraft(), null);
  });
});

test('loadDraft never throws on corrupt or shaped-wrong stored JSON, and returns null for it', () => {
  withSessionStorage(() => {
    saveDraft(makeRoot([])); // learns the real key, whatever tab id this process fell back to
    const [key] = globalThis.sessionStorage.map.keys();
    for (const bad of ['{not valid json', '"just a string"', '42', 'null', '{}', '{"fields": "not an object"}', '{"fields": [1, 2]}']) {
      globalThis.sessionStorage.setItem(key, bad);
      assert.equal(loadDraft(), null, bad);
    }
  });
});

test('with sessionStorage blocked entirely (no global at all), saveDraft/loadDraft/clearDraft are safe no-ops', () => {
  const prev = globalThis.sessionStorage;
  delete globalThis.sessionStorage;
  try {
    assert.doesNotThrow(() => saveDraft(makeRoot([makeField('ce-courtName', { value: 'x' })])));
    assert.equal(loadDraft(), null);
    assert.doesNotThrow(() => clearDraft());
  } finally {
    if (prev !== undefined) globalThis.sessionStorage = prev;
  }
});
