import type { JSX } from 'solid-js';

/**
 * Deterministic placeholder gradient for anything without artwork.
 *
 * One formula for the whole app. It used to be copy-pasted per view with drifted
 * saturation and hue offsets, so the same track showed a different colour in
 * Search than in the library — the fallback looked like a bug rather than a
 * design. Seeded by id, so a given track keeps its colour everywhere and across
 * reloads.
 */
export function coverGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 48% 30%), hsl(${(h + 44) % 360} 52% 19%))`;
}

/**
 * Artwork background: the cover image over its seeded gradient. Layering (rather
 * than swapping) means a cover that 404s degrades to the gradient instead of a
 * broken-image box.
 */
export function coverBackground(seed: string, url?: string | null): string {
  const gradient = coverGradient(seed);
  return url ? `url("${url}") center / cover no-repeat, ${gradient}` : gradient;
}

/** `coverBackground` as an inline style object. */
export function coverStyle(seed: string, url?: string | null): JSX.CSSProperties {
  return { background: coverBackground(seed, url) };
}

/** Neutral surface placeholder, for artwork that is not per-track: podcast shows
 * and playlists, where a hue picked from a title would be arbitrary. */
export const NEUTRAL_COVER = 'linear-gradient(135deg, var(--bg-elevated), var(--bg-inset))';

/** `NEUTRAL_COVER` under an optional image, as an inline style object. */
export function neutralCoverStyle(url?: string | null): JSX.CSSProperties {
  return {
    background: url ? `url("${url}") center / cover no-repeat, ${NEUTRAL_COVER}` : NEUTRAL_COVER,
  };
}
