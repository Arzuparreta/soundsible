import { createSignal } from 'solid-js';
import { apiOrigin } from './config';

interface TrackMediaIdentity {
  id: string;
  youtube_id?: string | null;
  source?: 'preview';
}

/** Bumped after a cover edit so `coverUrl` busts the browser image cache. */
const [coverVersion, setCoverVersion] = createSignal(0);
export const bustCovers = (): void => {
  setCoverVersion((n) => n + 1);
};

/** Cover art for a library track (same-origin engine endpoint). Reads the
 * cover-version signal so thumbnails refresh reactively after a cover change. */
export const coverUrl = (id: string): string => {
  const v = coverVersion();
  return `${apiOrigin()}/api/static/cover/${encodeURIComponent(id)}${v ? `?v=${v}` : ''}`;
};

/** Audio stream for a library track. */
export const streamUrl = (id: string): string =>
  `${apiOrigin()}/api/static/stream/${encodeURIComponent(id)}`;

/** Preview audio stream for a not-yet-downloaded YouTube video (Discover). */
export const previewUrl = (videoId: string): string =>
  `${apiOrigin()}/api/preview/stream/${encodeURIComponent(videoId)}`;

/**
 * Return the YouTube identity used by playback for this track.
 *
 * Preview tracks are already resolved: their `id` is the exact video id sent
 * to `/api/preview/stream`. Some preview payloads also carry a `youtube_id`,
 * but it may describe an earlier seed or catalog row, so it must never take
 * precedence over the id that is actually playing.
 */
export const playbackYoutubeId = (track: TrackMediaIdentity): string | null =>
  track.source === 'preview' ? track.id : track.youtube_id || null;

/** Tokenized podcast episode stream (token minted via api.podcastPeek). */
export const podcastStreamUrl = (token: string): string =>
  `${apiOrigin()}/api/podcasts/stream/${encodeURIComponent(token)}`;
