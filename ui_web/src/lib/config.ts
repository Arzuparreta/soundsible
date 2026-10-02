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

let resourceOrigin: string | null = null;
let engineOrigin: string | null = null;
/** Local generation-bound artwork proxy in Android; REST uses its native adapter. */
export function setResourceOrigin(origin: string | null, remote: string | null = null): void { resourceOrigin = origin; engineOrigin = remote; }
export function mediaOrigin(): string { return resourceOrigin ?? apiOrigin(); }

export function artworkUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('/api/')) return `${mediaOrigin()}${url}`;
  if (engineOrigin && resourceOrigin) {
    try {
      const parsed = new URL(url);
      if (parsed.origin === engineOrigin && parsed.pathname.startsWith('/api/'))
        return `${resourceOrigin}${parsed.pathname}${parsed.search}`;
    } catch { return undefined; }
  }
  return url;
}
