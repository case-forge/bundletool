/**
 * Wraps a lazily-loaded dynamic `import()` or `new Worker()` so a load failure (almost always this tab
 * running an old page against a newer deployment, where the file it asks for does not exist) shows the
 * same "reload to continue" toast that sw-register.js owns. That is window.cfShowReloadToast, which only
 * exists once that script has run: it is absent under `hugo server`, where the script is not emitted, and
 * wherever service workers are unsupported, and there a minimal toast of the same shape is built here.
 * Both functions then let the failure through exactly as if this wrapper were not there, so whatever the
 * caller does for that error (a console.warn, an error modal, a build step's own try/catch) still runs.
 * Neither function ever swallows a failure silently.
 */
/**
 * A minimal "reload to continue" toast for a page where sw-register.js's own is absent: it only exists where
 * service workers are supported, the context is secure, offline mode is on and there is no ?nosw, and a tab
 * without one is exactly a tab that fetches new files after a deploy. Same id, role and button classes, so
 * it takes the same styles (static/css/shared/bug-report.css). One at a time.
 */
function showFallbackToast(detail) {
  if (typeof document === 'undefined' || !document.body) return;
  const shown = document.getElementById('cf-update-toast');
  if (shown) {
    // Already up: a later call with more to say (what the files answered) replaces the line under the sentence.
    const hint = shown.querySelector?.('.bt-hint');
    if (hint && detail) hint.textContent = `Error code BT-LOAD-01: ${detail}`;
    return;
  }
  const toast = document.createElement('div');
  toast.id = 'cf-update-toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = 'This page needs reloading to continue.';
  if (detail) {
    // What failed, so a screenshot of the toast says which file and why. It names a path of this site and the
    // browser's own error text, nothing from a document.
    const what = document.createElement('small');
    what.className = 'bt-hint';
    what.textContent = `Error code BT-LOAD-01: ${detail}`;
    text.append(document.createElement('br'), what);
  }
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'cf-update-toast-go';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => location.reload());
  const later = document.createElement('button');
  later.type = 'button';
  later.textContent = 'Later';
  later.addEventListener('click', () => toast.remove());
  toast.append(text, reload, later);
  document.body.appendChild(toast);
}

function showReloadToast(detail) {
  if (typeof window !== 'undefined' && typeof window.cfShowReloadToast === 'function') {
    // sw-register.js owns this toast when offline mode is on, so the code has to go through it, or the
    // person sees the plain sentence and a screenshot says nothing about what failed.
    window.cfShowReloadToast(detail
      ? `This page needs reloading to continue. Error code BT-LOAD-01: ${detail}`
      : undefined);
    return;
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    showFallbackToast(detail);
    return;
  }
  // No window: this is a worker's own realm (dedicated or shared), which has no page to show a toast
  // on directly. Every worker scope can postMessage back to whatever owns it, so it tells the page
  // instead: the page's own watchForLazyLoadFailures(), attached to every worker this app spawns, turns
  // this back into the same showReloadToast() call, on the page, where window exists. Without this a
  // lazy-load failure inside a worker would reach only that worker's own catch (console.error and an
  // error message back to the page, if the caller sends one), with no toast at all, unlike the same
  // failure on the main thread.
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    try { self.postMessage({ type: 'lazy-load-failed' }); } catch { /* nothing listening right now */ }
  }
}

/**
 * The same signal lazyImport() uses on a non-silent failure (a direct toast call on the page; a
 * postMessage in a worker context, for watchForLazyLoadFailures() to turn back into one), exposed for
 * a caller that needs to raise it over a promise it did not create itself. See bundletoolPdfLib.js's
 * getFontkit(): a real, awaited call that finds an in-flight silent prewarm already attached to the
 * same fetch calls this on that promise's own eventual rejection, so that real caller still gets the
 * toast even though the underlying lazyImport() call itself was silent.
 */
export function signalLazyLoadFailure() {
  showReloadToast();
}

/**
 * Attaches a listener to `worker` that shows the reload toast when ITS OWN lazyImport() call fails
 * inside its own realm (see showReloadToast() above). An independent `addEventListener`, not a
 * replacement for the worker's own `onmessage` or other listeners: both fire for the same message.
 */
export function watchForLazyLoadFailures(worker) {
  worker.addEventListener('message', (e) => {
    if (e.data?.type === 'lazy-load-failed') showReloadToast();
  });
}

/**
 * `specifier` with a cache-busting query param appended, so a retry is a genuinely different request
 * rather than the same URL the module loader (browser or Node) already has a failed record for: the
 * loader's own module map remembers a failed fetch against one URL, so a second `import()` of the exact
 * same string settles immediately, with no new network request, even once the file is reachable again.
 * String specifiers are kept as strings (not promoted through the URL class) so a root-absolute form
 * (an un-prefixed path starting with a slash) still matches the resolvers (browser root-relative
 * resolution, and this app's own Node test resolver, scripts/node-compat-resolve.mjs) that key on that
 * exact leading prefix.
 *
 * Under an active service worker, this cannot rescue a bad SW-cached entry: a controlled page's fetch
 * for a URL the SW's own cache already has, whatever its query string, is answered from that cache and
 * never reaches the network. That is how the offline cache works (docs/offline-mode.md), not a gap in
 * the retry itself; the "new version" toast is what deals with a stale SW-cached file.
 */
function cacheBusted(specifier) {
  const stamp = Date.now().toString(36);
  if (specifier instanceof URL) {
    const u = new URL(specifier.href);
    u.searchParams.set('cfRetry', stamp);
    return u;
  }
  const s = String(specifier);
  return s + (s.includes('?') ? '&' : '?') + 'cfRetry=' + stamp;
}

/** "<path>: <the browser's message>", short enough for a toast: the origin and the retry's own query are left off. */
function describeFailure(specifier, err) {
  let where = String(specifier instanceof URL ? specifier.href : specifier);
  try {
    const u = new URL(where, 'https://x.invalid');
    u.searchParams.delete('cfRetry');
    where = u.pathname + u.search;
  } catch { /* a specifier that is not a URL is shown as it is */ }
  const why = String(err?.message || err || '').replace(/https?:\/\/[^\s]+/g, '').replace(/\s+/g, ' ').trim();
  return `${where}${why ? `: ${why}` : ''}`.slice(0, 200);
}

const IMPORT_FROM = /(?:^|[\n;])\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;

/**
 * Fetches the module that failed to load and every file it imports, the way the page itself asks for them (so a
 * service worker answers as it would for the import), and says the first thing wrong: a status that is not 200, a
 * type that is not JavaScript, or a request that never got an answer. Some browsers give no reason at all for a
 * failed import (Firefox's message ends at the colon), and this is what turns that into something a screenshot can
 * report. Resolves to '' when there is nothing to say, and never rejects.
 */
async function probeModule(specifier) {
  try {
    if (typeof location === 'undefined' || typeof fetch !== 'function') return '';
    const start = new URL(String(specifier instanceof URL ? specifier.href : specifier), location.href);
    start.searchParams.delete('cfRetry');
    const seen = new Set();
    const queue = [start];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      while (queue.length && seen.size < 60) {
        const url = queue.shift();
        if (url.origin !== location.origin || seen.has(url.pathname)) continue;
        seen.add(url.pathname);
        let res;
        try { res = await fetch(url.pathname, { credentials: 'same-origin', signal: controller.signal }); }
        catch (err) { return `${url.pathname} got no answer (${err?.name || 'error'})`; }
        const type = (res.headers.get('content-type') || 'none').split(';')[0];
        if (res.status !== 200) return `${url.pathname} answered ${res.status}`;
        if (!/javascript/.test(type)) return `${url.pathname} came back as ${type}, not JavaScript`;
        const text = await res.text();
        for (const m of text.matchAll(IMPORT_FROM)) {
          const spec = m[1] || m[2];
          if (spec && (spec.startsWith('.') || spec.startsWith('/'))) queue.push(new URL(spec, url));
        }
      }
    } finally { clearTimeout(timer); }
    return `all ${seen.size} files answer 200 as JavaScript`;
  } catch { return ''; }
}

/**
 * Awaits `import(specifier)`. On failure, retries once against a cache-busted copy of the same
 * specifier before giving up: a transient failure (a blip, not a stale deployment) can genuinely
 * succeed on that second attempt. If the retry also fails, triggers the reload toast and rethrows the
 * retry's own error, so the caller's own error handling still runs exactly as it would without this
 * wrapper.
 *
 * `{ silent: true }` skips the toast on failure (the error still rethrows, so a memo-clearing
 * `.catch()` further up still works). A prewarm started before anyone has asked for the result (a
 * worker warming its own fontkit fetch at startup, say) can fail before any job needs it: an idle
 * worker with fontkit blocked would post the toast signal about 2 ms after announcing ready, for a job
 * that in the default configuration may not need fontkit at all (no page numbering, no cover). Route a
 * prewarm through this option; route every real, awaited call (the only one a person is actually
 * waiting on) through the default.
 */
export async function lazyImport(specifier, { silent = false } = {}) {
  try {
    return await import(specifier);
  } catch {
    try {
      return await import(cacheBusted(specifier));
    } catch (err) {
      if (!silent) {
        const detail = describeFailure(specifier, err);
        showReloadToast(detail);
        // The toast is already up; this adds what the files themselves answer once that is known.
        probeModule(specifier).then((found) => { if (found) showReloadToast(`${detail}. Checked: ${found}`); });
      }
      throw err;
    }
  }
}

/**
 * Wraps a loader so concurrent and later callers share one load, but a load that FAILS is forgotten: the
 * next call tries again. A cached rejection would disable the feature until the page is reloaded after
 * one transient failure (a deploy mid-session, a network blip).
 */
export function memoizeLoad(load) {
  let promise = null;
  return () => {
    if (!promise) {
      promise = Promise.resolve().then(load);
      promise.catch(() => { promise = null; });
    }
    return promise;
  };
}

/**
 * Whether a worker's `error` event says its script could not be loaded (the worker file, or a module it imports,
 * is gone or unreachable), rather than that an exception was thrown while it ran. A load failure arrives as a
 * plain Event; an uncaught exception inside the worker arrives as an ErrorEvent carrying its message and the file
 * it came from. Reloading fixes the first and not the second, so only the first shows the reload toast.
 */
export function isWorkerLoadFailure(event) {
  return !event?.message && !event?.filename;
}

/**
 * `new Worker(url, options)`, returned immediately as the constructor itself does. A worker script that
 * fails to load fires `error` on the Worker object, never on `window`, so that is where this listens. An
 * exception thrown inside a running worker fires `error` there too; that one is the caller's to report (its
 * own onerror), not a reason to reload, so it shows no toast.
 */
export function startWorker(url, options) {
  const worker = new Worker(url, options);
  worker.addEventListener('error', (event) => { if (isWorkerLoadFailure(event)) showReloadToast(); });
  return worker;
}
