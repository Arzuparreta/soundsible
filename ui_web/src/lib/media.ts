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

interface TrackCoverIdentity {
  id: string;
  cover?: string;
  source?: 'preview';
}

/**
 * Artwork for a track, wherever that artwork actually lives.
 *
 * A song you saved but never downloaded is not a library track: it has no row
 * the engine knows about, so `/api/static/cover/<its id>` is a question about
 * something that has never existed and the answer is a placeholder at best.
 * Its one image is the thumbnail captured in the saved snapshot (see
 * `lib/saved.ts`), and that is the only artwork it will ever have until a
 * download gives it a file. A library track is the other way round: the engine
 * always has an answer, its embedded art or the shipped placeholder.
 *
 * This fork used to be written out at every call site — grids, rows, pickers —
 * and the playlist surfaces were simply the ones that never got the copy, so a
 * playlist opening on a saved-only song showed a blank card while the same song
 * drew fine one screen away. Same reasoning as `coverGradient` in `lib/cover.ts`:
 * one rule, one place. `playbackYoutubeId` below is its audio-side twin.
 *
 * Pass `size: 'thumb'` from list/grid rows; full size is for now-playing and
 * edit views. A preview's thumbnail is already small and has no size variants.
 */
export const trackCoverUrl = (track: TrackCoverIdentity, size?: 'thumb'): string | undefined =>
  track.source === 'preview' ? track.cover || undefined : coverUrl(track.id, size);

/** Whether a track has any artwork to show. Defined in terms of
 * `trackCoverUrl` rather than restating the rule, so the two cannot drift:
 * "has art" is exactly "asking for the art yields a URL". */
export const hasCoverArt = (track: TrackCoverIdentity): boolean =>
  trackCoverUrl(track) !== undefined;

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
