const CACHE_NAME = 'soundsible-v11';
const AUDIO_CACHE = 'soundsible-audio';
/** Minimal precache: manifests + built Tailwind bundle. JS/HTML use network-first below. */
const ASSETS = [
  'assets/tailwind-compiled.css',
  'manifest.json',
  'manifest-alt.json',
  'manifest-desktop.json',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(ASSETS).catch((err) => console.warn('SW precache:', err))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== AUDIO_CACHE) {
            console.log('SW: Clearing old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  if (url.includes('/api/static/stream/') || url.includes('r2.cloudflarestorage.com')) {
    return;
  }

  if (event.request.mode === 'navigate' || event.request.destination === 'script') {
    event.respondWith(
      fetch(event.request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
