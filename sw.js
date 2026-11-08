const CACHE_NAME = 'mastery-pwa-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.url.includes('api.github.com')) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
