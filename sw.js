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
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  
  // Always network-first for JS, CSS, and Netlify functions
  const isAsset = url.pathname.endsWith('.js') || url.pathname.endsWith('.css');
  const isFunction = url.pathname.startsWith('/.netlify/');
  
  if (isAsset || isFunction) {
    e.respondWith(
      fetch(e.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(e.request)) // fallback to cache when offline
    );
    return;
  }

  // Cache-first for images, fonts, HTML
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
