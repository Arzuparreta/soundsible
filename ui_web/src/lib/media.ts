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
 * cover-version signal so thumbnails refresh reactively after a cover change.
 * Pass `size: 'thumb'` from list/grid rows to get a small resized JPEG instead
 * of the (often multi-MB) embedded original — full size stays the default for
 * now-playing/edit views. */
export const coverUrl = (id: string, size?: 'thumb'): string => {
  const v = coverVersion();
  const params = [size ? `size=${size}` : '', v ? `v=${v}` : ''].filter(Boolean).join('&');
  return `${apiOrigin()}/api/static/cover/${encodeURIComponent(id)}${params ? `?${params}` : ''}`;
};

/**
 * Audio stream for a library track.
 *
 * The URL for a track is the same every time it is played, and that is a
 * requirement rather than a detail. A media URL is a cache key: tagging each
 * play with its own attempt id — as this did, to make server and client
 * telemetry easy to join — gave every play a key nothing had ever seen, so the
 * browser could not reuse a byte of what it already had. Downloaded music was
 * re-fetched in full on every play, which on a LAN is invisible and over a
 * remote link is seconds of staring at a spinner. The engine sends an `ETag`
 * and answers a conditional request with a 304 in about a millisecond; keeping
 * the URL stable is what lets any of that happen.
 *
 * Telemetry is joined on the track and the clock instead. See
 * `scripts/playback_report.py`.
 */
export const streamUrl = (id: string): string =>
  `${apiOrigin()}/api/static/stream/${encodeURIComponent(id)}`;

/** Preview audio stream for a not-yet-downloaded YouTube video (Discover).
 * Stable for the same reason as `streamUrl`, and it matters at least as much
 * here: a preview the engine already cached to disk should never be proxied
 * twice. */
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
