import { artworkUrl } from './config';

/**
 * Podcast artwork as the engine serves it.
 *
 * A feed's images live on whatever host its publisher picked, and some refuse
 * an image whose Referer names another site: esRadio's answers 403. Browsers
 * send that Referer for CSS background images whatever the page's referrer
 * policy says, and every cover here is one, so the engine fetches the image
 * and the page only ever asks the engine, as it does for library covers.
 *
 * The path is relative so a track that carries it stays valid on any device;
 * `podcastArtwork` resolves it for display.
 */
export function podcastArtworkPath(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) return url;
  return `/api/podcasts/artwork?url=${encodeURIComponent(url)}`;
}

/** `podcastArtworkPath`, resolved against the engine for an `<img>` or a CSS background. */
export function podcastArtwork(url?: string | null): string | undefined {
  return artworkUrl(podcastArtworkPath(url));
}
