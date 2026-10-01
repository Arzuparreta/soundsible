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
  const register = async () => {
    try {
      const registration = await navigator.serviceWorker.register(SW_URL, { scope: '/player/' });
      await navigator.serviceWorker.ready;
      const used = new Set<string>();
      const report = (entries: PerformanceEntry[]) => {
        const urls = entries.map(entry => entry.name).filter(value => {
          const url = new URL(value, window.location.origin);
          return url.origin === window.location.origin
            && /^\/player\/(?:assets\/|icons\/|branding\/|manifest\.webmanifest$)/.test(url.pathname)
            && !used.has(value);
        });
        for (const url of urls) used.add(url);
        (navigator.serviceWorker.controller ?? registration.active)?.postMessage({ type: 'soundsible-cache-used', urls });
      };
      report(performance.getEntriesByType('resource'));
      if (typeof PerformanceObserver !== 'undefined') {
        const observer = new PerformanceObserver(list => report(list.getEntries()));
        observer.observe({ type: 'resource', buffered: true });
        if (import.meta.hot) import.meta.hot.dispose(() => observer.disconnect());
      }
    } catch {
      /* Unsupported, blocked by policy, or served over plain HTTP off-LAN. */
    }
  };
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => { void register(); }, { once: true });
}
