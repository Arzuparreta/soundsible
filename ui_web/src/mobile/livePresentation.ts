/** Only thumbnails belonging to the configured Community origin and current room are displayed. */
export function liveArtworkUrl(value: string | null | undefined, origin: string | null | undefined, roomId: string): string | undefined {
  if (!value || !origin) return;
  try {
    const url = new URL(value), api = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== api.origin || url.username || url.password || url.search || url.hash ||
        !/^[A-Za-z0-9_-]{12,64}$/.test(roomId) || !url.pathname.startsWith(`/v1/artwork/${roomId}/`) || url.pathname.split('/').length !== 5) return;
    return url.href;
  } catch { return; }
}
