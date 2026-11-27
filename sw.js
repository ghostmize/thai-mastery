const CACHE_NAME = 'mastery-pwa-v8';          // rolling cache (replaced every version)
const OFFLINE_CACHE = 'mastery-offline-v1';   // filled by the in-app "Download for offline" button
const EXT_CACHE = 'mastery-ext-v1';           // CDN libraries + fonts, kept across versions
const KEEP = [CACHE_NAME, OFFLINE_CACHE, EXT_CACHE];
const EXT_HOSTS = ['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

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
      .then(keys => Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isCacheable(res) {
  return res && (res.ok || res.type === 'opaque');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // CDN libraries & fonts: cache-first, refresh in background when online
  if (EXT_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(EXT_CACHE).then(async cache => {
        const cached = await cache.match(req);
        const refresh = fetch(req).then(res => {
          if (isCacheable(res)) cache.put(req, res.clone()).catch(() => {});
          return res;
        });
        if (cached) { refresh.catch(() => {}); return cached; }
        return refresh;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // App files: network-first, fall back to cache (ignoring ?query so paired links work offline)
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
