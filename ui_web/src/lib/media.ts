import { createSignal } from 'solid-js';
import { apiOrigin } from './config';

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

/** Tokenized podcast episode stream (token minted via api.podcastPeek). */
export const podcastStreamUrl = (token: string): string =>
  `${apiOrigin()}/api/podcasts/stream/${encodeURIComponent(token)}`;
