/**
 * refreshBundleTotals() (frontend/bundleTotals.js): the Review Table's own running total, and the
 * PD27A note. Exercised with no DOM, the same way reportAdded.test.mjs and inputData.test.mjs do:
 * document.getElementById is never reached, which is the point of the "no DOM" guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../public/js/frontend/state.js';
import { refreshBundleTotals } from '../public/js/frontend/bundleTotals.js';
import { PD27A_PAGE_LIMIT, isOverPd27aLimit, pd27aNote } from '../public/js/frontend/limits.js';

function reset() {
  for (const k of Object.keys(state.frontendInputData)) delete state.frontendInputData[k];
}

test('empty bundle: zero documents, zero pages, never over the PD27A limit', () => {
  reset();
  const r = refreshBundleTotals();
  assert.deepEqual(r, { documentCount: 0, pageCount: 0, overPd27aLimit: false, pd27aLimit: PD27A_PAGE_LIMIT });
});

test('the total follows every add, remove and clear, and rotate does not need to touch it', () => {
  reset();
  state.frontendInputData['a.pdf'] = { title: 'A', date: '', pageCount: 10 };
  state.frontendInputData['b.pdf'] = { title: 'B', date: '', pageCount: 5 };
  assert.deepEqual(refreshBundleTotals(), { documentCount: 2, pageCount: 15, overPd27aLimit: false, pd27aLimit: PD27A_PAGE_LIMIT });

  delete state.frontendInputData['a.pdf'];
  assert.deepEqual(refreshBundleTotals(), { documentCount: 1, pageCount: 5, overPd27aLimit: false, pd27aLimit: PD27A_PAGE_LIMIT });

  // Rotate turns pages, it does not add or remove them: the page count in frontendInputData is
  // untouched by a rotation, so the total is unaffected without any explicit refresh for it.
  state.frontendInputData['b.pdf'].rotate = 90;
  assert.equal(refreshBundleTotals().pageCount, 5);

  reset();
  assert.deepEqual(refreshBundleTotals(), { documentCount: 0, pageCount: 0, overPd27aLimit: false, pd27aLimit: PD27A_PAGE_LIMIT });
});

test('the PD27A note is over only once the total is over 350, never at exactly 350', () => {
  reset();
  state.frontendInputData['a.pdf'] = { title: 'A', date: '', pageCount: PD27A_PAGE_LIMIT };
  assert.equal(refreshBundleTotals().overPd27aLimit, false, 'exactly 350 is not over the limit');
  assert.equal(isOverPd27aLimit(PD27A_PAGE_LIMIT), false);

  state.frontendInputData['b.pdf'] = { title: 'B', date: '', pageCount: 1 };
  assert.equal(refreshBundleTotals().overPd27aLimit, true, '351 is over the limit');
  assert.equal(isOverPd27aLimit(PD27A_PAGE_LIMIT + 1), true);

  reset();
});

test('the PD27A note names Practice Direction 27A, 350 pages and the court’s permission, and does not repeat the 1,000-page warning’s wording', () => {
  const note = pd27aNote(400);
  assert.match(note, /400/);
  assert.match(note, /Practice Direction 27A/);
  assert.match(note, /350/);
  assert.match(note, /permission/i);
  // The 1,000-page/75 MB warning (frontend/fileProcessing.js maybeWarnLargeBundleOnAdd) says
  // "Very large bundle" and "are rare"; the two notices must read as two different things, not one
  // restated as the other.
  assert.doesNotMatch(note, /rare/i);
  assert.doesNotMatch(note, /Very large bundle/i);
});
