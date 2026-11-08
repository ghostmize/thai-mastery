const CACHE_NAME = 'mastery-pwa-v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = event.request.url;
  if (event.request.method !== 'GET' || url.includes('api.github.com') || url.includes('translate.google.com') || url.includes('google') || url.includes('tts')) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
