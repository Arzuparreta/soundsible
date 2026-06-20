import { apiOrigin } from './config';

/** Cover art for a library track (same-origin engine endpoint). */
export const coverUrl = (id: string): string =>
  `${apiOrigin()}/api/static/cover/${encodeURIComponent(id)}`;

/** Audio stream for a library track. */
export const streamUrl = (id: string): string =>
  `${apiOrigin()}/api/static/stream/${encodeURIComponent(id)}`;

/** Preview audio stream for a not-yet-downloaded YouTube video (Discover). */
export const previewUrl = (videoId: string): string =>
  `${apiOrigin()}/api/preview/stream/${encodeURIComponent(videoId)}`;

/** Tokenized podcast episode stream (token minted via api.podcastPeek). */
export const podcastStreamUrl = (token: string): string =>
  `${apiOrigin()}/api/podcasts/stream/${encodeURIComponent(token)}`;
