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
 * The engine keeps one copy per image and draws it at the size asked for, so
 * every view asks for the size it draws: a 44px row needs a 160px image, not
 * the publisher's 3000px square.
 */

const ROUTE = '/api/podcasts/artwork';

/** The sizes the engine draws (`shared.artwork.SIZES`). */
export const PODCAST_ARTWORK_SIZES = [160, 320, 640, 960, 1280] as const;
export type PodcastArtworkSize = (typeof PODCAST_ARTWORK_SIZES)[number];

/** Covers in list rows (`--cover-sm`, 44px) at up to 3x. */
export const ROW_ARTWORK = 160;
/** A show's header art (136px at most) at up to 2x. */
export const HEADER_ARTWORK = 320;
/** Cards in a grid (144px and wider) at up to 2x. */
export const CARD_ARTWORK = 640;

/**
 * The engine path for a feed's image, with no size: what a track built from an
 * episode carries. It is relative so the track stays valid on any device.
 */
export function podcastArtworkPath(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) return url;
  return `${ROUTE}?url=${encodeURIComponent(url)}`;
}

/** Whether `src` (a path or an absolute URL) names the engine's podcast artwork. */
export function isPodcastArtwork(src?: string | null): src is string {
  return !!src && src.split('?')[0].endsWith(ROUTE);
}

/** `src` asked for at `size` when it is podcast artwork; anything else as it is. */
export function sizedPodcastArtwork(src: string | undefined, size: PodcastArtworkSize, square = false): string | undefined {
  if (!isPodcastArtwork(src)) return src;
  const [base, query = ''] = src.split('?');
  const params = new URLSearchParams(query);
  params.set('size', String(size));
  if (square) params.set('fit', 'square');
  else params.delete('fit');
  return `${base}?${params}`;
}

/** A feed's image at `size`, resolved against the engine for an `<img>` or a CSS background. */
export function podcastArtwork(url: string | null | undefined, size: PodcastArtworkSize): string | undefined {
  return artworkUrl(sizedPodcastArtwork(podcastArtworkPath(url), size));
}

/** Every size of a podcast cover, as an `<img>` `srcset`; undefined for anything else. */
export function podcastArtworkCandidates(src?: string | null): string | undefined {
  if (!isPodcastArtwork(src)) return undefined;
  return PODCAST_ARTWORK_SIZES.map((size) => `${sizedPodcastArtwork(src, size)} ${size}w`).join(', ');
}
