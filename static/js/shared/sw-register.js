// Registers a tool's offline service worker (BundleTool, Envelope Guide; the tool's page names its own worker in
// data-sw and its scope in data-scope). The worker is built by scripts/build-offline.mjs; docs/offline-mode.md
// describes the whole design. This file does four things and nothing else:
//   1. registers the worker after the page has loaded (never under `hugo server`: the template does not emit
//      this script there). A page marked data-install="existing" (BundleTool's Guide) only keeps a worker the
//      tool already installed up to date: reading the Guide does not download the whole tool,
//   2. applies a new version by itself at a safe moment (a page that has only just opened, or a tab nobody is
//      looking at, and never while a bundle is being built), and until then offers it ("A new version is ready.
//      Reload to use it."). Saved work is autosaved, so a reload loses nothing; a version that waited for a button
//      pinned people on an old build,
//   3. asks the worker to fetch the optional files (fonts) once the browser is idle, unless data saving is on,
//   4. is the kill switch: opening the page with ?nosw=1 removes THIS tool's worker and caches, remembers (in this
//      browser only) that offline mode is off for this tool, and loads the page normally; ?nosw=0 turns it back on.
//      The other tools keep their own workers, caches and choice.
// It sends nothing anywhere: the only requests are for the worker file and the app's own files.
(function () {
  var script = document.currentScript;
  if (!script || !script.dataset.sw || !('serviceWorker' in navigator)) return;
  var swUrl = script.dataset.sw;
  var scope = script.dataset.scope || undefined;
  var PREFIX = 'cf-offline-';
  // The tool's id is the folder of its worker (/<tool>/sw.js): its caches are cf-offline-<tool>-<version> and
  // its remembered choice is cf-offline-disabled-<tool>, so switching one tool off never touches another.
  // A tool served from the root of its own site has its worker at /sw.js and names itself in data-tool.
  var toolId = script.dataset.tool || (/\/([^/]+)\/sw\.js$/.exec(swUrl) || [])[1] || '';
  var OWN = PREFIX + toolId + '-';
  var STATE = PREFIX + 'state-' + toolId;

  var KEY = 'cf-offline-disabled-' + toolId;
  function storage(op, value) {
    try {
      if (op === 'get') return localStorage.getItem(KEY);
      if (op === 'set') localStorage.setItem(KEY, value);
      else localStorage.removeItem(KEY);
    } catch (e) { /* storage blocked: the flag is just not remembered */ }
    return null;
  }

  function removeWorker(thenReplaceUrl) {
    var done = [];
    done.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
      return Promise.all(regs.filter(function (r) { return !scope || r.scope.indexOf(location.origin + scope) === 0; })
        .map(function (r) { return r.unregister(); }));
    }));
    if (window.caches) {
      done.push(caches.keys().then(function (names) {
        return Promise.all(names.filter(function (n) { return n.indexOf(OWN) === 0 || n === STATE; })
          .map(function (n) { return caches.delete(n); }));
      }));
    }
    return Promise.all(done).catch(function () {}).then(function () {
      if (thenReplaceUrl) location.replace(thenReplaceUrl);
    });
  }

  function withoutFlag() {
    var url = new URL(location.href);
    url.searchParams.delete('nosw');
    return url.pathname + url.search + url.hash;
  }

  var flag = new URLSearchParams(location.search).get('nosw');
  if (flag === '0') {
    // Turned back on: forget the flag, tidy the address, and carry on to register.
    storage('remove');
    history.replaceState(null, '', withoutFlag());
  } else if (flag !== null) {
    storage('set', '1');
    removeWorker(withoutFlag());
    return;
  } else if (storage('get') === '1') {
    // Turned off earlier in this browser: make sure nothing is left running, and do not register.
    removeWorker(null);
    return;
  }
  if (!window.isSecureContext) return;

  var toast = null;
  var toastText = null;
  var toastReload = null;
  var hadController = !!navigator.serviceWorker.controller;
  var asked = false;      // this tab's own Reload button was pressed

  function buildToast(message) {
    if (toast) { toastText.textContent = message; return; }
    toast = document.createElement('div');
    toast.id = 'cf-update-toast';
    toast.setAttribute('role', 'status');
    toastText = document.createElement('span');
    toastText.textContent = message;
    toastReload = document.createElement('button');
    toastReload.type = 'button';
    toastReload.className = 'cf-update-toast-go';
    toastReload.textContent = 'Reload';
    var later = document.createElement('button');
    later.type = 'button';
    later.textContent = 'Later';
    toast.appendChild(toastText);
    toast.appendChild(toastReload);
    toast.appendChild(later);
    document.body.appendChild(toast);
    later.addEventListener('click', function () { toast.remove(); toast = null; });
  }

  // Same toast, a different reason: a lazily-loaded script or worker (shared/lazy-load.js) failed to load,
  // most often because this tab is running an old page against a deployment that has moved on, or against a
  // stored copy from an earlier version. Reload here removes this tool's worker and stored copy first, so the
  // page comes straight from the server and offline mode installs itself again on that load. Saved work is
  // not in these caches and is not touched.
  window.cfShowReloadToast = function (message) {
    buildToast(message || 'This page needs reloading to continue.');
    var fresh = toastReload.cloneNode(true);
    toastReload.replaceWith(fresh);
    toastReload = fresh;
    toastReload.addEventListener('click', function () {
      removeWorker(null).then(function () { location.reload(); });
    });
  };

  var loadedAt = Date.now();
  var pending = null;     // the waiting worker, until it has been applied
  var reloading = false;

  function reloadNow() {
    if (reloading) return;
    reloading = true;
    location.reload();
  }

  // A build is running in this tool (BundleTool writes one flag, with a heartbeat, to localStorage while it builds):
  // a reload now would cut it short, so an update waits for it. A flag whose heartbeat has stopped is a dead tab's.
  function buildRunning() {
    try {
      var flag = JSON.parse(localStorage.getItem('buntool_build_in_progress') || 'null');
      return !!flag && Date.now() - (flag.heartbeat || 0) < 180000;
    } catch (e) { return false; }
  }

  // Loop guard: an automatic apply is tried once a minute at most in this tab. The button is never held back.
  var APPLIED_KEY = 'cf-offline-applied-' + toolId;
  function recentlyApplied() {
    try { return Date.now() - Number(sessionStorage.getItem(APPLIED_KEY) || 0) < 60000; } catch (e) { return false; }
  }

  // Asks the waiting worker to take over. It claims every open page and tells each to reload (the UPDATED message,
  // and controllerchange for a page it controls); the timer is only for a worker that did neither, so the button
  // is never a button that does nothing.
  function apply(worker) {
    asked = true;
    try { sessionStorage.setItem(APPLIED_KEY, String(Date.now())); } catch (e) { /* not remembered */ }
    if (worker.state === 'activated') { reloadNow(); return; }
    worker.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(reloadNow, 4000);
  }

  function applyIfSafe() {
    if (!pending || reloading || recentlyApplied() || buildRunning()) return;
    if (document.visibilityState === 'hidden') apply(pending);
  }

  // A new version is waiting. A page that has only just opened takes it at once, and a hidden tab takes it as soon
  // as no build is running; a tab being looked at is offered the button instead.
  function showUpdate(worker, atLoad) {
    if (!worker) return;
    pending = worker;
    if (!recentlyApplied() && !buildRunning() && (atLoad || document.visibilityState === 'hidden')) { apply(worker); return; }
    if (toast) return;
    buildToast('A new version is ready. Reload to use it.');
    toastReload.addEventListener('click', function () { apply(worker); });
  }

  document.addEventListener('visibilitychange', applyIfSafe);
  setInterval(applyIfSafe, 10000);

  // Another tab (or this one's own request) put the new version in charge: this page now runs old scripts, so it
  // reloads, unless a build is running here, which it is told about instead.
  function appliedByWorker() {
    if (asked || !buildRunning()) { reloadNow(); return; }
    buildToast('The app was updated. Reload to finish updating.');
    var fresh = toastReload.cloneNode(true);
    toastReload.replaceWith(fresh);
    toastReload = fresh;
    toastReload.addEventListener('click', reloadNow);
  }

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) { hadController = true; return; }   // the first worker taking over is not an update
    appliedByWorker();
  });
  navigator.serviceWorker.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'UPDATED') appliedByWorker();
  });

  function watch(reg) {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting, true);
    reg.addEventListener('updatefound', function () {
      var incoming = reg.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', function () {
        // "At load" is the first few seconds of the page's life, when nothing has been done yet.
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) showUpdate(incoming, Date.now() - loadedAt < 15000);
      });
    });
    // A tab kept open for days (an installed app) still finds out about a new version, at most once an hour.
    var last = Date.now();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || Date.now() - last < 3600000) return;
      last = Date.now();
      reg.update().catch(function () {});
    });
  }

  function warm() {
    var conn = navigator.connection || {};
    if (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || '')) return;
    navigator.serviceWorker.ready.then(function (reg) {
      if (reg.active) reg.active.postMessage({ type: 'WARM' });
    }).catch(function () {});
  }

  var existingOnly = script.dataset.install === 'existing';
  window.addEventListener('load', function () {
    (existingOnly ? navigator.serviceWorker.getRegistration(scope) : Promise.resolve(true)).then(function (have) {
      if (!have) return null;   // nothing installed yet, and this page does not install it
      return navigator.serviceWorker.register(swUrl, { scope: scope, updateViaCache: 'none' }).then(function (reg) {
        watch(reg);
        var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 4000); };
        idle(warm, { timeout: 10000 });
      });
    }).catch(function () { /* no worker (private window, blocked storage): the tool simply needs the network */ });
  });
})();
