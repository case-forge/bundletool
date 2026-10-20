/**
 * dateInputOrder is read live when a file is added. state.config is a Config instance refreshed
 * only by updateOptions() inside the build and preview paths, so reading it at file-add time would
 * let the live control and the value used disagree: a UK user who once built under US would keep
 * getting US-read dates on every later add until the next build, even after switching the control
 * back to UK.
 *
 * parseDateFromAddedFilename() (fileProcessing.js) reads document.getElementById
 * ('config-dateInputOrder') directly, never state.config, so there is no build-dependent state to
 * go stale. This drives that REAL, exported function end to end (not a reimplementation of its
 * logic) with a minimal document stub standing in for the one control it reads, so an edit that
 * adds a dependency on state.config (or any other cached copy of the setting) fails this test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateFromAddedFilename } from '../public/js/frontend/fileProcessing.js';
import * as chrono from '/vendor/chrono-node.js';

function stubDocument(initialValue) {
  const control = { value: initialValue };
  globalThis.document = { getElementById: (id) => (id === 'config-dateInputOrder' ? control : null) };
  return control;
}

test('the control is read live, with no build in between: UK, switch to US, switch back to UK', async () => {
  const control = stubDocument('UK');
  try {
    // 1. UK, no prior build at all: the ambiguous date reads day-first.
    const first = await parseDateFromAddedFilename('Order 03-04-2026.pdf', chrono);
    assert.equal(first.date, '2026-04-03', 'UK with no build yet must still read day-first');

    // 2. Switch the control to US, with NO build step anywhere (nothing here ever touches a
    // Config instance or calls updateOptions): the very next add already reads month-first.
    control.value = 'US';
    const second = await parseDateFromAddedFilename('Order 03-04-2026.pdf', chrono);
    assert.equal(second.date, '2026-03-04', 'US must take effect on the next add with no build needed');

    // 3. Switch back to UK, again with no build. This is the case a cached reading gets wrong:
    // a state.config set to "US" by an earlier build would still say "US" after the control
    // itself says UK again.
    control.value = 'UK';
    const third = await parseDateFromAddedFilename('Order 03-04-2026.pdf', chrono);
    assert.equal(third.date, '2026-04-03', 'switching back to UK with no build must not keep the stale US reading');
  } finally { delete globalThis.document; }
});

test('a day over 12 is unaffected by the control either way, with no build involved', async () => {
  stubDocument('US');
  try {
    const r = await parseDateFromAddedFilename('Letter 13-04-2026.pdf', chrono);
    assert.equal(r.date, '2026-04-13', '13 can only ever be a day, regardless of the control');
  } finally { delete globalThis.document; }
});

test('the control missing from the page falls back to UK, the same as the setting\'s own default', async () => {
  globalThis.document = { getElementById: () => null };
  try {
    const r = await parseDateFromAddedFilename('Order 03-04-2026.pdf', chrono);
    assert.equal(r.date, '2026-04-03');
  } finally { delete globalThis.document; }
});
