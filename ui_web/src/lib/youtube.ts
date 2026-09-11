const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function validVideoId(value: string | null | undefined): string | null {
  const id = String(value || '').trim();
  return VIDEO_ID_RE.test(id) ? id : null;
}

export interface YouTubeInput {
  videoId: string;
  url: string;
}

export function parseYouTubeInput(value: string, options: { allowVideoId?: boolean } = {}): YouTubeInput | null {
  const raw = value.trim();
  if (!raw) return null;

  // Bare IDs are ambiguous with artist names. Only explicit YouTube tools opt in.
  const directId = options.allowVideoId ? validVideoId(raw) : null;
  if (directId) {
    return { videoId: directId, url: `https://www.youtube.com/watch?v=${directId}` };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  let videoId: string | null = null;

  if (host === 'youtu.be') {
    videoId = validVideoId(url.pathname.match(/^\/([^/]+)\/?$/)?.[1]);
  } else if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'm.youtube.com') {
    videoId =
      (url.pathname === '/watch' ? validVideoId(url.searchParams.get('v')) : null) ||
      validVideoId(url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)\/?$/)?.[1]);
  }

  if (!videoId) return null;
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}
