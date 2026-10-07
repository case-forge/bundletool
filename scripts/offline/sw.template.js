/* CaseForge offline worker for one tool. Written by scripts/build-offline.mjs from scripts/offline/sw.template.js:
 * do not edit the generated public/<tool>/sw.js. docs/offline-mode.md explains the design.
 *
 * What it does: at install it stores the tool's own files (pages, scripts, styles, workers, libraries, icons and the
 * default fonts) in one cache named for this exact build, so the whole tool opens with the network off and every
 * file comes from the same version. A new deploy changes this file, the browser installs the new worker in the
 * background, and the page offers "A new version is ready. Reload to use it."; the old cache goes when the new
 * worker takes over. Other fonts are stored the first time they are used and, when the browser is idle, ahead of use.
 *
 * What it never does: cache or read a person's documents, touch another origin, send anything anywhere, or answer a
 * request for a file it does not list (those go to the network exactly as if it were not there).
 */
'use strict';

const TOOL = __TOOL__;
const VERSION = __VERSION__;
const PREFIX = 'cf-offline-';
const CACHE = PREFIX + TOOL + '-' + VERSION;
const META_KEY = '/__cf-offline-meta__';
const CORE = __CORE__;         // [[path, hash], ...] stored at install; install fails (and the old worker stays) if one is missing
const OPTIONAL = __OPTIONAL__; // [[path, hash], ...] stored on first use and when idle
const SOFT = __SOFT__;         // [[path, hash], ...] stored at install on a best-effort basis: a failure never stops the install
const PAGES = __PAGES__;       // page paths of this tool, answered from the cache whatever their query string
const LIVE = __LIVE__;         // paths fetched from the network first and kept for when there is none (data edited in place)
const NOT_FOUND = __NOTFOUND__; // the site's not-found page, shown for an unknown address inside the scope when offline (or null)
const FRESH = new Set(__FRESH__); // pages: fetched fresh at every install, never copied from an earlier cache and not checked against a hash

const CORE_PATHS = new Set(CORE.concat(SOFT).map(function (e) { return e[0]; }));
const OPTIONAL_PATHS = new Set(OPTIONAL.map(function (e) { return e[0]; }));
const PAGE_PATHS = new Set(PAGES);
const LIVE_PATHS = new Set(LIVE);
const LIVE_WAIT_MS = 6000;     // a live file that takes longer than this comes from the stored copy instead
const VERIFIED = 2;            // meta.__verified: every file in that cache was checked against its hash when stored
const STATE_CACHE = PREFIX + 'state-' + TOOL; // remembers a failed install so it is not repeated on every page view
const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

async function readMeta(cache) {
  try {
    const hit = await cache.match(META_KEY);
    return hit ? await hit.json() : {};
  } catch (e) { return {}; }
}

async function writeMeta(cache, meta) {
  meta.__verified = VERIFIED;
  await cache.put(META_KEY, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
}

// The first 16 hex digits of the file's SHA-256: the same label scripts/build-offline.mjs computed from the built file.
async function labelOf(buffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  let hex = '';
  for (let i = 0; i < 8; i++) hex += (digest[i] < 16 ? '0' : '') + digest[i].toString(16);
  return hex;
}

// Fetches a file straight from the server (never the browser's HTTP cache, which could hold an older copy) and
// returns the response to store. A file that is not the exact one this build lists is refused, so a stale copy from
// an edge, a challenge page answered 200 or a half-deployed site is never stored under the right label.
async function fetchListed(path, hash) {
  const response = await fetch(new Request(path, { cache: 'reload', credentials: 'same-origin' }));
  if (!response.ok) throw new Error(path + ' answered ' + response.status);
  if (FRESH.has(path)) return response;
  const copy = response.clone();
  const got = await labelOf(await response.arrayBuffer());
  if (got !== hash) throw new Error(path + ' is not the file this build lists');
  return copy;
}

// A failed install is remembered per version, with a growing wait, so a server that keeps failing is not asked for
// the whole tool again on every page view.
async function readState() {
  try {
    const cache = await caches.open(STATE_CACHE);
    const hit = await cache.match('/state');
    return hit ? await hit.json() : {};
  } catch (e) { return {}; }
}
async function writeState(state) {
  try {
    const cache = await caches.open(STATE_CACHE);
    if (state) await cache.put('/state', new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } }));
    else await caches.delete(STATE_CACHE);
  } catch (e) { /* not being able to remember a failure only means it may be tried again sooner */ }
}
async function noteFailure() {
  const old = await readState();
  const fails = old.version === VERSION ? (old.fails || 0) + 1 : 1;
  const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, fails - 1));
  await writeState({ version: VERSION, fails: fails, retryAt: Date.now() + wait });
}

async function earlierCaches() {
  const names = await caches.keys();
  const mine = PREFIX + TOOL + '-';
  return names.filter(function (n) { return n.indexOf(mine) === 0 && n !== CACHE; });
}

// Stores every entry not already present: files whose hash an earlier version's cache already holds are copied
// from it, so a deploy that changes three scripts downloads three scripts, not the whole tool again.
async function fill(entries, options) {
  const cache = await caches.open(CACHE);
  const meta = await readMeta(cache);
  const before = [];
  for (const name of await earlierCaches()) {
    const c = await caches.open(name);
    const m = await readMeta(c);
    // Only a cache whose files were all checked against their hashes may lend files to this one.
    if (m.__verified === VERIFIED) before.push({ cache: c, meta: m });
  }
  const todo = entries.filter(function (e) { return FRESH.has(e[0]) || meta[e[0]] !== e[1]; });
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const entry = todo[next++];
      const path = entry[0], hash = entry[1];
      try {
        let done = false;
        for (const old of (FRESH.has(path) ? [] : before)) {
          if (old.meta[path] === hash) {
            const kept = await old.cache.match(path);
            if (kept) { await cache.put(path, kept); done = true; break; }
          }
        }
        if (!done) {
          await cache.put(path, await fetchListed(path, hash));
        }
        meta[path] = hash;
      } catch (error) {
        if (options.strict) throw error;
      }
    }
  }
  const lanes = [];
  for (let i = 0; i < options.lanes; i++) lanes.push(worker());
  await Promise.all(lanes);
  await writeMeta(cache, meta);
}

// Live files are always taken fresh at install (never copied from an earlier cache), so a new version starts
// with current data. Install fails if one cannot be fetched, like any other file.
async function fillLive() {
  const cache = await caches.open(CACHE);
  for (const path of LIVE) {
    const response = await fetch(new Request(path, { cache: 'reload', credentials: 'same-origin' }));
    if (!response.ok) throw new Error(path + ' answered ' + response.status);
    await cache.put(path, response);
  }
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const state = await readState();
    if (state.version === VERSION && state.retryAt > Date.now()) {
      throw new Error('this version failed to install a moment ago; trying again later');
    }
    try {
      await fill(CORE, { strict: true, lanes: 6 });
      await fillLive();
      await fill(SOFT, { strict: false, lanes: 3 });
    } catch (error) {
      // Leave nothing half-filled behind: the partial cache is deleted and the failure remembered.
      await caches.delete(CACHE);
      await noteFailure();
      throw error;
    }
    await writeState(null);
    // The very first install has no earlier worker whose page could be left half old and half new.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

// Only the very first version takes over pages already open. A later one would take over a page loaded without
// any worker (a hard refresh does that) and answer that page's later files from its own cache, so one page would
// run two versions at once; such a page stays on the network until it is next opened.
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const earlier = await earlierCaches();
    for (const name of earlier) await caches.delete(name);
    if (!earlier.length) await self.clients.claim();
  })());
});

self.addEventListener('message', function (event) {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  else if (data.type === 'WARM') event.waitUntil(fill(OPTIONAL, { strict: false, lanes: 2 }));
});

async function answerPage(request, path) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(path);
  if (hit) return hit;
  return fetch(request);
}

async function answerFile(request, path) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(path);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && OPTIONAL_PATHS.has(path)) {
    const entry = OPTIONAL.find(function (e) { return e[0] === path; });
    // Stored only when it is exactly the file this build lists; otherwise it is just passed on.
    if (await labelOf(await response.clone().arrayBuffer()) === entry[1]) {
      const meta = await readMeta(cache);
      await cache.put(path, response.clone());
      meta[path] = entry[1];
      await writeMeta(cache, meta);
    }
  }
  return response;
}

// Network first, so a refreshed file is never hidden by an older stored copy; the stored copy is kept up to date on
// every good answer and used when the network fails, is slow, or answers with an error.
async function answerLive(request, path) {
  const cache = await caches.open(CACHE);
  try {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, LIVE_WAIT_MS);
    let response;
    try { response = await fetch(path, { credentials: 'same-origin', signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (response.ok) {
      await cache.put(path, response.clone());
      return response;
    }
    const kept = await cache.match(path);
    return kept || response;
  } catch (error) {
    const kept = await cache.match(path);
    if (kept) return kept;
    throw error;
  }
}

// An address inside the tool that the worker does not know: online it goes to the network as usual; offline the
// site's own not-found page is shown, with its 404 status.
async function answerUnknown(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(CACHE);
    const page = await cache.match(NOT_FOUND);
    if (!page) throw error;
    // The stored copy was fetched at /404 (no file extension), so say what it is rather than trust the header.
    const headers = new Headers(page.headers);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(page.body, { status: 404, statusText: 'Not Found', headers: headers });
  }
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (request.mode === 'navigate') {
    // A page of this tool, whatever its query string, comes from the cache; anything else navigates normally.
    if (PAGE_PATHS.has(path)) event.respondWith(answerPage(request, path));
    else if (NOT_FOUND) event.respondWith(answerUnknown(request));
    return;
  }
  if (LIVE_PATHS.has(path)) event.respondWith(answerLive(request, path));
  else if (CORE_PATHS.has(path) || OPTIONAL_PATHS.has(path)) event.respondWith(answerFile(request, path));
});
