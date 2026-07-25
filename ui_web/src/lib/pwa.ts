/**
 * Service worker registration for the installed player.
 *
 * The worker itself (`public/sw.js`) caches only the app shell, so what this
 * buys is a home-screen icon that opens the app whether or not the station is
 * awake — and, once open, an app that says so instead of showing a browser
 * error page.
 */

/** `/player/sw.js`, so the worker's scope is the whole player and nothing else. */
const SW_URL = '/player/sw.js';

/**
 * Register the offline shell, if this surface should have one.
 *
 * Skipped in three cases, each for its own reason:
 *
 * - **Dev builds** — Vite serves modules unhashed and rebuilds constantly; a
 *   caching worker in front of that only creates confusing stale states.
 * - **The desktop shell** (`/player/desktop/`) — its HTML carries an injected
 *   owner token and it ships with the engine, so it has nothing to be offline
 *   from.
 * - **Browsers without service workers** (older iOS Safari in private mode).
 *
 * Failure is not reported: an app that works is not the place to complain that
 * it will not *also* work offline.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (window.location.pathname.startsWith('/player/desktop')) return;

  // After load: registration competes with the first library sync otherwise,
  // and the shell the worker caches is only useful on the *next* launch.
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(SW_URL, { scope: '/player/' }).catch(() => {
      /* Unsupported, blocked by policy, or served over plain HTTP off-LAN. */
    });
  });
}
