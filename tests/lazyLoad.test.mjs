/**
 * Direct unit tests for /js/shared/lazy-load.js itself: the retry-then-toast-then-rethrow contract
 * lazyLoadGuard.test.mjs's scan assumes every bare import()/new Worker() elsewhere has been routed
 * through. lazyImport()'s retry path uses the fixture pair in fixtures/lazyLoad/ (see flaky.mjs) to prove
 * a real second module-evaluation attempt happens, not just that an internal memo was cleared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Absolute, not a relative '../../static/...' path: how many '../' levels lead up to static/ depends on
// the layout (static/ beside the tool, or one level further up when the tool is built as part of the full
// site). scripts/node-compat-resolve.mjs, which every Node consumer here loads, resolves this
// '/js/shared/...' prefix in either layout.
import { lazyImport, startWorker, watchForLazyLoadFailures } from '/js/shared/lazy-load.js';
import { resetFlaky } from './fixtures/lazyLoad/flakyState.mjs';

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

test('lazyImport: a specifier that resolves first time succeeds, and shows no toast', async () => {
  await withFakeWindow(async (toastCalls) => {
    const ns = await lazyImport(new URL('./fixtures/lazyLoad/flakyState.mjs', import.meta.url));
    assert.equal(typeof ns.resetFlaky, 'function');
    assert.equal(toastCalls.length, 0);
  });
});

test('lazyImport: a specifier that fails on the first attempt but succeeds on the cache-busted retry resolves, and shows no toast', async () => {
  resetFlaky();
  await withFakeWindow(async (toastCalls) => {
    const ns = await lazyImport(new URL('./fixtures/lazyLoad/flaky.mjs', import.meta.url));
    assert.equal(ns.ok, true);
    assert.equal(toastCalls.length, 0, 'a retry that succeeds is not a failure the person needs telling about');
  });
});

test('lazyImport: a specifier that never resolves shows the reload toast once and rethrows, so the caller\'s own error handling still runs', async () => {
  await withFakeWindow(async (toastCalls) => {
    let threw = null;
    let caughtByCaller = false;
    try {
      await lazyImport('/vendor/this-file-does-not-exist-anywhere.js');
    } catch (e) {
      threw = e;
      caughtByCaller = true;
    }
    assert.ok(caughtByCaller, 'lazyImport must rethrow, not swallow, a failure');
    assert.ok(threw instanceof Error);
    assert.equal(toastCalls.length, 1, 'the toast fires exactly once: after both the original attempt and its retry have failed');
  });
});

test('lazyImport: with no window (e.g. under Node, or a worker scope), a failure still rethrows rather than throwing its own secondary error', async () => {
  assert.equal('window' in globalThis, false, 'this test assumes no window is set: check test order if it fails');
  await assert.rejects(() => lazyImport('/vendor/this-file-also-does-not-exist.js'));
});

/**
 * A worker has no window, so it cannot show the toast directly: it posts {type: 'lazy-load-failed'}
 * back to whatever owns it (self.postMessage, which every worker scope has) instead, and the page's
 * watchForLazyLoadFailures(), attached to every worker this app spawns, turns that back into the same
 * showReloadToast() call, on the page, where window exists. Both ends of that path, tested separately.
 */
async function withFakeSelf(fn) {
  const calls = [];
  assert.equal('window' in globalThis, false, 'this helper assumes no window is set: check test order if it fails');
  const had = 'self' in globalThis;
  const prior = globalThis.self;
  globalThis.self = { postMessage: (msg) => { calls.push(msg); } };
  try {
    return await fn(calls);
  } finally {
    if (had) globalThis.self = prior; else delete globalThis.self;
  }
}

test('lazyImport: inside a worker (no window, but self.postMessage), a failure posts {type: "lazy-load-failed"} to whatever spawned it instead of trying to show a toast directly', async () => {
  await withFakeSelf(async (posted) => {
    await assert.rejects(() => lazyImport('/vendor/this-file-does-not-exist-from-a-worker.js'));
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0], { type: 'lazy-load-failed' });
  });
});

/**
 * {silent: true} is what bundletoolBuildWorker.js/bundletoolFooterWorker.js's own prewarmFontkit()
 * (bundletoolPdfLib.js) routes through for the un-awaited kickoff they fire at startup, before any real
 * job has asked for fontkit. Without it, an idle worker with fontkit blocked would post the ordinary
 * {type: 'lazy-load-failed'} message moments after announcing ready, and show a reload toast for a job
 * that, in the default configuration (no page numbering, no cover), never needs fontkit at all. The
 * later, awaited getFontkit() call that a job which DOES need it makes is unaffected: it still goes
 * through the default (non-silent) path and still posts on failure, as the test above shows.
 */
test('lazyImport: inside a worker, {silent: true} rethrows on failure but posts nothing at all, not even a toast-suppressed message', async () => {
  await withFakeSelf(async (posted) => {
    await assert.rejects(() => lazyImport('/vendor/this-file-does-not-exist-either.js', { silent: true }));
    assert.deepEqual(posted, [], 'a silent prewarm failure must not post anything, in any shape, to whatever spawned it');
  });
});

test('watchForLazyLoadFailures: a {type: "lazy-load-failed"} message from a worker shows the reload toast on the page that is watching it', async () => {
  class FakeWorker extends EventTarget {}
  const worker = new FakeWorker();
  await withFakeWindow((toastCalls) => {
    watchForLazyLoadFailures(worker);
    assert.equal(toastCalls.length, 0, 'no toast before any message');
    worker.dispatchEvent(new MessageEvent('message', { data: { type: 'lazy-load-failed' } }));
    assert.equal(toastCalls.length, 1);
    // An unrelated message (the worker's own progress/result/ready protocol) must not also trigger it.
    worker.dispatchEvent(new MessageEvent('message', { data: { ready: true } }));
    assert.equal(toastCalls.length, 1);
  });
});

test('startWorker: constructs the worker with the given arguments and returns it immediately', () => {
  const seen = [];
  class FakeWorker extends EventTarget {
    constructor(url, options) {
      super();
      seen.push({ url, options });
    }
  }
  const priorWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const worker = startWorker('http://example.test/probe-worker.js', { type: 'module' });
    assert.ok(worker instanceof FakeWorker);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'http://example.test/probe-worker.js');
    assert.deepEqual(seen[0].options, { type: 'module' });
  } finally {
    if (priorWorker === undefined) delete globalThis.Worker; else globalThis.Worker = priorWorker;
  }
});

test('startWorker: a worker-level error event shows the reload toast (a failed worker fires `error` on itself, never on window)', async () => {
  class FakeWorker extends EventTarget {
    constructor() { super(); }
  }
  const priorWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    await withFakeWindow((toastCalls) => {
      const worker = startWorker('http://example.test/probe-worker.js', { type: 'module' });
      assert.equal(toastCalls.length, 0, 'no toast before any failure');
      worker.dispatchEvent(new Event('error'));
      assert.equal(toastCalls.length, 1);
    });
  } finally {
    if (priorWorker === undefined) delete globalThis.Worker; else globalThis.Worker = priorWorker;
  }
});

/**
 * The shape of an ErrorEvent, the event a browser fires at the Worker object when an exception thrown inside the
 * running worker goes uncaught: it carries the message and the file it came from. (Node has no ErrorEvent class,
 * so the fields are set on an Event, which is all the check reads.)
 */
function errorEvent(fields) {
  return Object.assign(new Event('error'), fields);
}

test('startWorker: an exception thrown inside a running worker shows no reload toast; a load failure does', async () => {
  class FakeWorker extends EventTarget {}
  const priorWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    await withFakeWindow((toastCalls) => {
      const worker = startWorker('http://example.test/probe-worker.js', { type: 'module' });
      worker.dispatchEvent(errorEvent({ message: 'Uncaught RangeError: Array buffer allocation failed', filename: 'http://example.test/probe-worker.js', lineno: 12 }));
      assert.equal(toastCalls.length, 0, 'a runtime exception is not fixed by reloading, so it shows no reload toast');
      worker.dispatchEvent(errorEvent({ message: 'Uncaught TypeError: x is not a function', filename: '' }));
      assert.equal(toastCalls.length, 0, 'an exception with a message but no file is still a runtime exception');
      worker.dispatchEvent(errorEvent({ message: '', filename: '' }));
      assert.equal(toastCalls.length, 1, 'an ErrorEvent with no message and no file is a load failure');
      worker.dispatchEvent(new Event('error'));
      assert.equal(toastCalls.length, 2, 'a plain error Event is a load failure');
    });
  } finally {
    if (priorWorker === undefined) delete globalThis.Worker; else globalThis.Worker = priorWorker;
  }
});

test('isWorkerLoadFailure: a plain Event or an empty ErrorEvent is a load failure; an event naming a message or a file is not', async () => {
  const { isWorkerLoadFailure } = await import('/js/shared/lazy-load.js');
  assert.equal(isWorkerLoadFailure(new Event('error')), true);
  assert.equal(isWorkerLoadFailure(errorEvent({ message: '', filename: '' })), true);
  assert.equal(isWorkerLoadFailure(errorEvent({ message: 'Uncaught Error: boom', filename: 'http://example.test/w.js' })), false);
  assert.equal(isWorkerLoadFailure(errorEvent({ message: '', filename: 'http://example.test/w.js' })), false);
});
