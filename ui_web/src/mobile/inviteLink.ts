/** An invitation selects an origin only after the user submits it in the connection form. */
export function nativeInviteLink(value: string): { origin: string; token: string } | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.pathname !== '/player/') return null;
    const token = /^#\/invite\/([A-Za-z0-9_-]{16,128})$/.exec(url.hash)?.[1];
    return token ? { origin: url.origin, token } : null;
  } catch { return null; }
}
