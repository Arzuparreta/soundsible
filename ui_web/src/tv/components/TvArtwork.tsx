import { ArtworkSurface } from '../../design/Artwork';

export function TvArtwork(props: {
  src?: string;
  alt: string;
  fallbackLabel?: string;
  class?: string;
}) {
  return (
    <ArtworkSurface
      class={props.class}
      src={props.src}
      seed={props.fallbackLabel || props.alt}
      role={props.alt ? 'img' : undefined}
      aria-label={props.alt || undefined}
    />
  );
}
