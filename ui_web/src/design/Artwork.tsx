import { splitProps, type JSX } from 'solid-js';
import { coverStyle } from '../lib/cover';
export { ArtworkImage } from './ArtworkImage';

/** Fixed-size row artwork shares the URL and fallback contract with cards,
 * without a per-row image-size observer. The owning recipe supplies its box. */
export function ArtworkSurface(props: JSX.HTMLAttributes<HTMLSpanElement> & { seed: string; src?: string | null }) {
  const [local, rest] = splitProps(props, ['seed', 'src']);
  return <span data-artwork-surface {...rest} style={coverStyle(local.seed, local.src)} />;
}
