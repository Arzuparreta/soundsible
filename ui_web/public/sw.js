/**
 * Soundsible offline shell.
 *
 * The player was installable long before it was launchable: tapping the home
 * screen icon with the station out of reach — asleep laptop, phone off Wi-Fi,
 * Tailscale not up yet — produced the browser's dinosaur, not the app. This
 * caches the shell so the app always opens, reports honestly that it cannot
 * reach the station, and recovers the moment it can.
 *
 * Deliberately conservative:
 *
 * - **The network always wins for navigations.** The cache is a fallback, never
 *   a shortcut. A running station can never be shadowed by a stale shell.
 * - **Nothing from `/api` is ever cached.** Library, playback, and auth are
 *   live state; a service worker replaying them would be lying about the
 *   listener's own music. Audio is excluded for the same reason plus a
 *   practical one: range requests and a music library do not belong in a
 *   quota-limited cache.
 * - **`/player/desktop/` is never cached.** The engine injects an owner token
 *   into that HTML, and a token belongs in exactly one place: the response
 *   that was minted for it.
 *
 * Written as plain JS with a stable filename: it is copied verbatim from
 * `public/`, because a service worker's URL determines the scope it may
 * control and a hashed name would move that scope on every build.
 */

// Bump to invalidate everything this worker has stored.
const CACHE = 'soundsible-shell-v1';

/** The app entry point — one HTML document behind every route. */
const SHELL_URL = '/player/';

/** How long a navigation waits for the station before falling back to the
 * cached shell. Long enough for a sleepy home server on the same LAN, short
 * enough that a dead one does not look like a hung app. */
const NAVIGATION_TIMEOUT_MS = 3500;

/** Live state and media: always straight to the network, never stored. */
function isBypassed(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/player/desktop')
  );
}

/** Build output: content-hashed filenames, so a hit is always the right bytes. */
function isImmutableAsset(url) {
  return url.pathname.startsWith('/player/assets/');
}

/** Stable-name shipped files: icons, the manifest, branding. Safe to serve from
 * cache while a fresh copy is fetched for next time. */
function isRevalidatedAsset(url) {
  return (
    url.pathname.startsWith('/player/icons/') ||
    url.pathname.startsWith('/player/branding/') ||
    url.pathname === '/player/manifest.webmanifest'
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Best-effort: a first load with the station already unreachable should
      // still install the worker, so the *next* launch is covered.
      await cache.add(new Request(SHELL_URL, { cache: 'reload' })).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** Fetch, but give up after `ms` so a black-holed connection cannot hang the
 * launch. A TCP connection to a machine that is asleep fails slowly. */
function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Network first, cached shell second. Every successful navigation refreshes
 * the stored shell, so the offline copy tracks the deployed one. */
async function handleNavigation(event) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetchWithTimeout(event.request, NAVIGATION_TIMEOUT_MS);
    // `waitUntil`, not a floating promise: the worker may be shut down as soon
    // as the response is returned, and a half-written shell is worse than none.
    if (response.ok) event.waitUntil(cache.put(SHELL_URL, response.clone()));
    return response;
  } catch {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    throw new Error('offline and no cached shell');
  }
}

/** Hashed assets never change under their URL, so a hit needs no revalidation. */
async function handleImmutable(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
  return response;
}

/** Serve what we have immediately, then quietly refresh it for next time. */
async function handleRevalidated(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const network = fetch(event.request)
    .then((response) => {
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const response = await network;
  if (response) return response;
  throw new Error('offline and not cached');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isBypassed(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (isImmutableAsset(url)) {
    event.respondWith(handleImmutable(event));
    return;
  }
  if (isRevalidatedAsset(url)) {
    event.respondWith(handleRevalidated(event));
  }
});
