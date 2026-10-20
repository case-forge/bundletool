{{- /* The stand-in service worker: it does nothing except remove itself and the caches of any earlier worker. */ -}}
/* CaseForge offline stand-in: removes any earlier offline worker and its caches, then itself. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const names = await caches.keys();
    await Promise.all(names.filter(function (n) { return n.indexOf('cf-offline-') === 0; }).map(function (n) { return caches.delete(n); }));
    await self.registration.unregister();
  })());
});
