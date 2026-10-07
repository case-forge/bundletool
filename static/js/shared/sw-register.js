// Registers a tool's offline service worker (BundleTool, Envelope Guide; the tool's page names its own worker in
// data-sw and its scope in data-scope). The worker is built by scripts/build-offline.mjs; docs/offline-mode.md
// describes the whole design. This file does four things and nothing else:
//   1. registers the worker after the page has loaded (never under `hugo server`: the template does not emit
//      this script there),
//   2. tells the person when a new version is waiting ("A new version is ready. Reload to use it.") and never
//      reloads by itself, so work in progress is never thrown away,
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

  // A new version is waiting: "Reload" asks it to take over, and the page reloads when it has. Never automatic,
  // so work in progress is never thrown away.
  function showUpdate(worker) {
    if (toast || !worker) return;
    buildToast('A new version is ready. Reload to use it.');
    toastReload.addEventListener('click', function () {
      if (worker.state === 'activated' || worker.state === 'redundant') { location.reload(); return; }
      asked = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  }

  // Another tab already applied the update: this tab now runs old scripts under the new worker, so its Reload
  // button just reloads.
  function showAppliedElsewhere() {
    buildToast('The app was updated in another tab. Reload to finish updating.');
    var fresh = toastReload.cloneNode(true);
    toastReload.replaceWith(fresh);
    toastReload = fresh;
    toastReload.addEventListener('click', function () { location.reload(); });
  }

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) { hadController = true; return; }   // the first worker taking over is not an update
    // This tab asked for the update (its Reload was pressed): reload now. Otherwise another tab did.
    if (asked) location.reload();
    else showAppliedElsewhere();
  });

  function watch(reg) {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', function () {
      var incoming = reg.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', function () {
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) showUpdate(incoming);
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

  window.addEventListener('load', function () {
    navigator.serviceWorker.register(swUrl, { scope: scope, updateViaCache: 'none' }).then(function (reg) {
      watch(reg);
      var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 4000); };
      idle(warm, { timeout: 10000 });
    }).catch(function () { /* no worker (private window, blocked storage): the tool simply needs the network */ });
  });
})();
