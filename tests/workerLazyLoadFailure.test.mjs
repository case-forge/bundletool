/**
 * Integration test for the worker-realm reload-toast path, driven through the three REAL
 * worker-spawning functions rather than watchForLazyLoadFailures() alone against a fake window. A test
 * of the watcher in isolation cannot see the failure that matters here: a stray
 * {type: 'lazy-load-failed'} message reaching a worker's own onmessage, which would take it for the
 * job's final (empty) result, terminate the worker and settle with nothing before the worker's own
 * real {error} reply (the actual reason the build failed) arrives.
 *
 * Each of the three real entry points (mergeTwoPdfsViaWorker, runBuildViaWorker,
 * addPageNumberingViaWorker) is driven against a FakeWorker standing in for `new Worker(...)`: the
 * {ready: true} handshake, then a stray lazy-load-failed message (must NOT terminate the worker or
 * settle the promise), then the worker's real {error} reply (must reject with that exact message, and
 * only now terminate). The toast firing is asserted too, via the same fake-window technique lazyLoad.test.mjs
 * uses, so both halves of the contract (the real error surviving, and the toast showing) are proven
 * together, the way they actually run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTwoPdfsViaWorker } from '../public/js/bundletoolMerge.js';
import { runBuildViaWorker } from '../public/js/bundletoolBuild.js';
import { addPageNumberingViaWorker } from '../public/js/bundletoolPages.js';
import Config from '../public/js/bundletoolConfig.js';

// The function under test only returns the finished result/error, never the Worker instance it built
// internally: this tracks whichever FakeWorker was constructed most recently, since each test's own
// call constructs exactly one before anything else about it matters.
let lastWorker = null;

class FakeWorker extends EventTarget {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.posted = [];
    this.terminated = false;
    lastWorker = this;
  }
  postMessage(data) { this.posted.push(data); }
  terminate() { this.terminated = true; }
  // worker.onmessage = fn is an IDL attribute, not just a plain property: wire it through
  // addEventListener so it behaves the same as the real thing (and so watchForLazyLoadFailures's own,
  // separate listener, the mechanism under test, fires independently of it here too).
  set onmessage(fn) { this.addEventListener('message', fn); }
  set onerror(fn) { this.addEventListener('error', fn); }
}

async function withFakeWorkerAndWindow(fn) {
  const toastCalls = [];
  const hadWindow = 'window' in globalThis;
  const priorWindow = globalThis.window;
  const priorWorker = globalThis.Worker;
  globalThis.window = { cfShowReloadToast: () => { toastCalls.push(true); } };
  globalThis.Worker = FakeWorker;
  lastWorker = null;
  try {
    return await fn(toastCalls);
  } finally {
    if (hadWindow) globalThis.window = priorWindow; else delete globalThis.window;
    globalThis.Worker = priorWorker;
  }
}

/** Drives the most recently constructed FakeWorker through ready -> stray lazy-load-failed -> real {error}. */
function driveToRealError(errorMessage) {
  assert.ok(lastWorker, 'no worker was constructed');
  const worker = lastWorker;
  worker.dispatchEvent(new MessageEvent('message', { data: { ready: true } }));
  // The actual failure, posted by lazyImport() itself from inside the worker's own realm, arriving
  // before the worker's own code has even caught the exception and replied with {error}.
  worker.dispatchEvent(new MessageEvent('message', { data: { type: 'lazy-load-failed' } }));
  assert.equal(worker.terminated, false, 'the stray message must not end the job early');
  worker.dispatchEvent(new MessageEvent('message', { data: { error: errorMessage, stack: 'fake stack' } }));
  return worker;
}

test('mergeTwoPdfsViaWorker: a lazy-load failure inside the merge worker still surfaces its real error, and shows the toast', async () => {
  await withFakeWorkerAndWindow(async (toastCalls) => {
    const resultPromise = mergeTwoPdfsViaWorker(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]));
    const worker = driveToRealError('simulated merge worker fontkit failure');
    await assert.rejects(resultPromise, /simulated merge worker fontkit failure/);
    assert.equal(worker.terminated, true, 'the real error reply must still end the job');
    assert.equal(toastCalls.length, 1, 'the stray message must still have shown the toast');
  });
});

test('runBuildViaWorker: a lazy-load failure inside the build worker still surfaces its real error, and shows the toast', async () => {
  await withFakeWorkerAndWindow(async (toastCalls) => {
    const job = { coverBytes: null, tocBytes: new Uint8Array([1]), fileEntries: [] };
    const resultPromise = runBuildViaWorker(job, () => {});
    const worker = driveToRealError('simulated build worker fontkit failure');
    await assert.rejects(resultPromise, /simulated build worker fontkit failure/);
    assert.equal(worker.terminated, true, 'the real error reply must still end the job');
    assert.equal(toastCalls.length, 1, 'the stray message must still have shown the toast');
  });
});

test('addPageNumberingViaWorker: a lazy-load failure inside the footer worker still surfaces its real error, and shows the toast', async () => {
  await withFakeWorkerAndWindow(async (toastCalls) => {
    const config = new Config();
    const resultPromise = addPageNumberingViaWorker(new Uint8Array([1, 2, 3]), config);
    const worker = driveToRealError('simulated footer worker fontkit failure');
    await assert.rejects(resultPromise, /simulated footer worker fontkit failure/);
    assert.equal(worker.terminated, true, 'the real error reply must still end the job');
    assert.equal(toastCalls.length, 1, 'the stray message must still have shown the toast');
  });
});
