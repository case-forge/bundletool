/**
 * The OCR engine's load failures. A failed library load is not cached for the session, a worker
 * that fails to start makes the session reject rather than wait forever, and a tab without a service
 * worker still gets a "reload to continue" notice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoizeLoad } from '/js/shared/lazy-load.js';

test('memoizeLoad: callers share one load, a rejected load is forgotten, a good one is kept', async () => {
  let calls = 0;
  const load = memoizeLoad(async () => { calls++; if (calls === 1) throw new Error('blip'); return 'ready'; });
  const first = load();
  assert.equal(load(), first, 'a second call while the first is in flight shares it');
  await assert.rejects(first, /blip/);
  assert.equal(await load(), 'ready', 'after a failure the next call tries again');
  assert.equal(await load(), 'ready');
  assert.equal(calls, 2, 'and a success is not loaded twice');
});

/** A Worker that fails to load its script: fires `error` and never answers a message. */
class DeadWorker {
  constructor() { this.listeners = new Map(); setTimeout(() => this.emit('error', { message: 'script failed' }), 5); }
  addEventListener(type, fn) { (this.listeners.get(type) ?? this.listeners.set(type, []).get(type)).push(fn); }
  removeEventListener() {}
  emit(type, event) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  postMessage() {}
  terminate() {}
}

test('ocrSession rejects when the worker cannot start, instead of waiting forever', async () => {
  globalThis.Worker = DeadWorker;
  try {
    const { ocrSession } = await import('../public/js/bundletoolOcrEngine.js');
    await assert.rejects(
      Promise.race([ocrSession(), new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG')), 3000))]),
      /could not start/,
    );
  } finally {
    delete globalThis.Worker;
  }
});

// ── The fallback toast, for a page whose service-worker toast is absent

function fakeDom() {
  const made = [];
  const el = (tag) => ({
    tag, children: [], attrs: {}, listeners: {}, className: '', textContent: '', id: '', type: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, fn) { this.listeners[t] = fn; },
    append(...kids) { this.children.push(...kids); },
    appendChild(k) { this.children.push(k); return k; },
    remove() { this.removed = true; },
  });
  const body = el('body');
  globalThis.document = {
    body,
    createElement: (tag) => { const e = el(tag); made.push(e); return e; },
    getElementById: (id) => body.children.find((c) => c.id === id && !c.removed) ?? null,
  };
  globalThis.window = {};
  return { body, made };
}

test('a failed lazy load shows a minimal reload toast when the service-worker one is absent', async () => {
  const { body } = fakeDom();
  try {
    const { signalLazyLoadFailure } = await import('/js/shared/lazy-load.js');
    signalLazyLoadFailure();
    const toast = body.children.find((c) => c.id === 'cf-update-toast');
    assert.ok(toast, 'a toast is on the page');
    assert.equal(toast.attrs.role, 'status');
    const buttons = toast.children.filter((c) => c.tag === 'button');
    assert.deepEqual(buttons.map((b) => b.textContent), ['Reload', 'Later']);
    assert.equal(buttons[0].className, 'cf-update-toast-go');
    signalLazyLoadFailure();
    assert.equal(body.children.filter((c) => c.id === 'cf-update-toast').length, 1, 'never two at once');
    buttons[1].listeners.click();
    assert.ok(toast.removed, 'Later dismisses it');
  } finally {
    delete globalThis.document; delete globalThis.window;
  }
});

test('the service-worker toast is still used when it exists, and no second one is built', async () => {
  const { body } = fakeDom();
  let used = 0;
  globalThis.window.cfShowReloadToast = () => { used++; };
  try {
    const { signalLazyLoadFailure } = await import('/js/shared/lazy-load.js');
    signalLazyLoadFailure();
    assert.equal(used, 1);
    assert.equal(body.children.length, 0);
  } finally {
    delete globalThis.document; delete globalThis.window;
  }
});

test('only the SIMD build of the OCR engine is shipped, and WebAssembly SIMD is a stated minimum requirement', async () => {
  const fs = await import('node:fs');
  const tool = new URL('../', import.meta.url);
  // The site's static/ sits beside this folder here and inside it in the standalone repository.
  const root = [new URL('../', tool), tool].find((r) => fs.existsSync(new URL('static/vendor/tesseract-wasm/', r)));
  assert.ok(root, 'static/vendor/tesseract-wasm/ was found');
  assert.deepEqual(fs.readdirSync(new URL('static/vendor/tesseract-wasm/', root)).filter((f) => f.endsWith('.wasm')), ['tesseract-core.wasm'],
    'tesseract-core-fallback.wasm (non-SIMD) is never used by a supported browser, so it is not vendored');
  const { COPIED } = await import(new URL('scripts/vendor-packages.mjs', tool).href);
  const tess = COPIED.find((c) => c.pkg === 'tesseract-wasm');
  assert.ok(tess.files.every((f) => !/fallback/.test(f.to)), 'the vendor build does not copy it back');
  assert.match(fs.readFileSync(new URL('public/js/bundletoolOcrEngine.js', tool), 'utf8'), /WEBASSEMBLY SIMD IS REQUIRED/);
});
