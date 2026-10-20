/**
 * A real job joining a silent prewarm in a build or footer worker: bundletoolBuildWorker.js's and
 * bundletoolFooterWorker.js's un-awaited prewarmFontkit() kickoff starts fontkit silently, and a real
 * job's own getFontkit() call (inside buildBundlePdf()/applyPageNumbering()) can arrive WHILE that
 * silent fetch is still in flight. If getFontkit() handed back the existing promise as it is, a
 * rejection would signal nothing to that real, waiting caller, even after both of lazyImport()'s own
 * cache-busted attempts had failed (the rejection itself is never lost, only the signal). A real
 * caller must get exactly one signal; the prewarm's own promise, and anyone only ever awaiting it as
 * a prewarm, must stay silent.
 *
 * Registers tests/fixtures/lazyLoad/failFontkitResolve.mjs as a loader hook before importing
 * bundletoolPdfLib.js, so /vendor/pdf-lib-fontkit.js genuinely fails to resolve (ENOENT) for this
 * file's own process only: module.register() scopes a hook to the registering process, and node --test
 * gives every matched test file its own process (lazyLoadGuard's sibling tests each assume the same
 * isolation), so this never reaches any other test file's run.
 */
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./fixtures/lazyLoad/failFontkitResolve.mjs', new URL('./', import.meta.url));

const { getFontkit, prewarmFontkit } = await import('../public/js/bundletoolPdfLib.js');

async function withFakeWindow(fn) {
  const calls = [];
  const had = 'window' in globalThis;
  const prior = globalThis.window;
  globalThis.window = { cfShowReloadToast: () => { calls.push(true); } };
  try {
    return await fn(calls);
  } finally {
    if (had) globalThis.window = prior; else delete globalThis.window;
  }
}

test('a real getFontkit() call joining an in-flight silent prewarm still signals exactly once when that fetch fails', async () => {
  await withFakeWindow(async (signals) => {
    // 1. prewarmFontkit() starts: silent, it kicks off the (genuinely failing) fetch.
    const prewarmPromise = prewarmFontkit();
    // 2. real getFontkit() called while it is still pending: no await has happened yet, and a promise
    //    can never settle synchronously, so this is guaranteed to join before settlement.
    const realPromise = getFontkit();
    assert.notEqual(realPromise, prewarmPromise, 'the real call must get its own derived promise, not hand back the shared one untouched');
    // 3. the fetch fails (both of lazyImport's own attempts, against a specifier that can never resolve).
    await assert.rejects(realPromise, /this-definitely-does-not-exist|Cannot find|not found/i);
    // 4. exactly one signal: not zero (the real caller must be told), not two (no double-signal from
    //    both the prewarm's own settle path and the real caller's attach path firing).
    assert.equal(signals.length, 1, `expected exactly one signal, got ${signals.length}`);
  });
});

test('prewarmFontkit() alone, with no real getFontkit() ever joining, fails completely silently', async () => {
  await withFakeWindow(async (signals) => {
    await assert.rejects(prewarmFontkit());
    assert.equal(signals.length, 0, 'a prewarm nobody joined must never signal, even though its own fetch really did fail');
  });
});
