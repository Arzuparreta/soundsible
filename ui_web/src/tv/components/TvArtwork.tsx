import { ArtworkBackdrop } from '../../components/ArtworkBackdrop';
import stage from '../../components/StageBackdrop.module.css';
import { ArtworkSurface } from '../../design/Artwork';
import styles from '../styles/tv.module.css';

export function TvArtwork(props: {
  src?: string;
  alt: string;
  fallbackLabel?: string;
  class?: string;
}) {
  return (
    <ArtworkSurface
      class={`${styles.tvArtwork} ${props.class || ''}`}
      src={props.src}
      seed={props.fallbackLabel || props.alt}
      role={props.alt ? 'img' : undefined}
      aria-label={props.alt || undefined}
    />
  );
}

/** Use the player's cached, reduced-resolution cover wash on the two large TV stages. */
export function TvArtworkBackdrop(props: { src?: string }) {
  return <ArtworkBackdrop src={props.src || ''} active visible class={stage.backdrop} activeClass={stage.backdropActive} />;
}
