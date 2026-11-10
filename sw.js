const CACHE_NAME = 'mastery-pwa-v6';
const APP_SHELL = [
  './',
  './index.html',
  './thai.html',
  './hebrew.html',
  './thai_reading_path_adaptive_mastery_engine.html',
  './hebrew_reading_path_adaptive_mastery_engine.html',
  './firebase_sync.js',
  './street_data.json',
  './hebrew_street_data.json',
  './manifest_thai.json',
  './manifest_hebrew.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(APP_SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = event.request.url;
  if (
    event.request.method !== 'GET' ||
    !url.startsWith(self.location.origin) ||
    url.includes('api.github.com') ||
    url.includes('translate.google.com') ||
    url.includes('googleapis.com')
  ) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
