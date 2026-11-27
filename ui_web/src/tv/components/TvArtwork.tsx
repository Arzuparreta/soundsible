import { createEffect, createSignal, Show } from 'solid-js';
import styles from '../styles/tv.module.css';

interface TvArtworkProps {
  src?: string;
  alt: string;
  fallbackLabel?: string;
  class?: string;
}

export function TvArtwork(props: TvArtworkProps) {
  const [failed, setFailed] = createSignal(false);

  createEffect(() => {
    // Reset failure state whenever source URL changes.
    void props.src;
    setFailed(false);
  });

  const glyph = () => {
    const label = (props.fallbackLabel || props.alt || 'S').trim();
    return label ? label[0].toUpperCase() : '♪';
  };

  return (
    <div class={props.class}>
      <Show
        when={props.src && !failed()}
        fallback={
          <div class={styles.tvArtFallback} aria-hidden="true">
            {glyph()}
          </div>
        }
      >
        <img
          class={styles.tvArtImg}
          src={props.src}
          alt={props.alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </Show>
    </div>
  );
}
