/**
 * Runtime config. The new app is served same-origin as the engine
 * (Flask serves /player and /api together; the dev server proxies /api and
 * /socket.io — see vite.config.js), so REST + Socket.IO both target the origin.
 */
export function apiOrigin(): string {
  const origin = typeof window !== 'undefined' ? window.location?.origin : null;
  if (origin && origin !== 'null') return origin;
  return 'http://localhost:5005';
}

/**
 * Desktop engine injects an owner token for auth; daemon/PWA mode has none.
 */
export function ownerToken(): string | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const runtimeWindow = window as Window & { __SOUNDSIBLE_OWNER_TOKEN__?: string };
  const globalToken = runtimeWindow.__SOUNDSIBLE_OWNER_TOKEN__?.trim();
  if (globalToken) return globalToken;
  return (
    document.querySelector('meta[name="soundsible-owner-token"]')?.getAttribute('content')?.trim() ||
    null
  );
}
