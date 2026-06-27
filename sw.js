// TEMPORARILY DISABLED CACHING TO FORCE FRESH LOADS
// Re-enable after debugging
const CACHE_NAME = 'hotel-ops-v9';
const ASSETS = [
  './',
  './index.html',
  './index.css',
  './db.js',
  './supabase.js',
  './app.js',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // ALWAYS fetch from network, no caching
  e.respondWith(fetch(e.request));
});
