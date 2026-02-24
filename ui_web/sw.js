const CACHE_NAME = 'soundsible-v6';
const AUDIO_CACHE = 'soundsible-audio';
const ASSETS = [
  'index.html',
  'desktop.html',
  'js/app.js',
  'js/app_desktop.js',
  'js/store.js',
  'js/resolver.js',
  'js/ui.js',
  'js/ui_desktop.js',
  'js/audio.js',
  'js/renderers.js',
  'js/wires.js',
  'js/downloader.js',
  'manifest.json',
  'manifest-alt.json',
  'manifest-desktop.json',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
];

self.addEventListener('install', (event) => {
  // Force the waiting service worker to become the active service worker.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
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

  // PASS-THROUGH for Audio: Service Workers + Cache API have issues with Range (206) requests.
  if (url.includes('/api/static/stream/') || url.includes('r2.cloudflarestorage.com')) {
    return; // Let the browser handle it normally
  }

  // Network-First for HTML/JS to ensure updates are seen while allowing offline access
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

  // Standard cache-first for other assets
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
