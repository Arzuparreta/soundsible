const CACHE_NAME = 'soundsible-v2';
const AUDIO_CACHE = 'soundsible-audio';
const ASSETS = [
  'index.html',
  'js/app.js',
  'js/store.js',
  'js/resolver.js',
  'js/ui.js',
  'js/audio.js',
  'manifest.json',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // PASS-THROUGH for Audio: Service Workers + Cache API have issues with Range (206) requests.
  if (url.includes('/api/static/stream/') || url.includes('r2.cloudflarestorage.com')) {
    return; // Let the browser handle it normally
  }

  // Standard cache-first for app assets
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
