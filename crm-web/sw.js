// v2: network-first strategy - always serve fresh content, cache only as offline fallback
const CACHE_NAME = 'biolabs-crm-v3';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k))) // nuke ALL old caches (v1 included)
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Network-first: always try live server first, fall back to cache only if offline
  e.respondWith(
    fetch(e.request).then(resp => {
      if (resp.ok && e.request.url.includes('/crm/')) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
