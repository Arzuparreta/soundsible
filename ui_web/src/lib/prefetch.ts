import { api } from './api';
import { isPodcastTrack } from './track';
import type { Track } from '../types/music';

/** YouTube video ids are exactly 11 URL-safe base64 chars. */
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** The engine's stream-URL cache lives ~5 min; re-warm shortly before it dies. */
const WARM_TTL_MS = 4 * 60 * 1000;
const lastWarm = new Map<string, number>();

/**
 * Warm previews before the user clicks play: the engine resolves the stream
 * URL in the background, and with `download` also lands the whole audio file
 * in its disk cache. Fire-and-forget — playback works the same without it,
 * just slower.
 */
export function prefetchPreviews(videoIds: string[], opts: { download?: boolean } = {}): void {
  const now = Date.now();
  const ids = [...new Set(videoIds)]
    .filter((id) => YT_ID_RE.test(id) && (opts.download || now - (lastWarm.get(id) ?? 0) > WARM_TTL_MS))
    .slice(0, 8);
  if (ids.length === 0) return;
  for (const id of ids) lastWarm.set(id, now);
  try {
    void api.prefetchPreviews(ids, opts.download ?? false).catch(() => {});
  } catch {
    /* prefetch must never break the calling surface */
  }
}

/**
 * The next preview tracks in linear queue order (what `actions.next` will
 * reach). Library tracks are skipped (already on disk); podcasts stream via
 * minted tokens the engine cannot prefetch.
 */
export function upcomingPreviewIds(queue: Track[], index: number, repeatAll: boolean, count = 2): string[] {
  const ids: string[] = [];
  const n = queue.length;
  for (let step = 1; step < n && ids.length < count; step++) {
    let j = index + step;
    if (j >= n) {
      if (!repeatAll) break;
      j %= n;
    }
    const t = queue[j];
    if (t && t.source === 'preview' && !isPodcastTrack(t)) ids.push(t.id);
  }
  return ids;
}
