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
 * TODO(desktop): confirm the meta name + header against shared/security.py when
 * wiring the desktop surface (Phase 4). Inert (null) on mobile/PWA.
 */
export function ownerToken(): string | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector('meta[name="owner-token"]')?.getAttribute('content') ?? null;
}
