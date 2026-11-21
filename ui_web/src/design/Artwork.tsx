import { createEffect, createMemo, createSignal, on, onMount, splitProps, untrack, type JSX } from 'solid-js';
import { artworkFallback, createScrollDeferred, isPaintedSource, rejectPreviewArtwork, rememberPaintedSource } from '../lib/artworkHints';
import { artworkUrl } from '../lib/config';
import { coverGradient } from '../lib/cover';
import styles from './Artwork.module.css';
export { ArtworkImage } from './ArtworkImage';

/** Fixed-size row artwork renders through a persistent async-decoded `<img>`
 * inside a CSS-contained surface, falling back to its seeded gradient only
 * while missing or errored, and budgeting uncached loads after high-velocity flings. */
export function ArtworkSurface(props: JSX.HTMLAttributes<HTMLSpanElement> & { seed: string; src?: string | null }) {
  const [local, rest] = splitProps(props, ['seed', 'src', 'class', 'children']);
  const [fallbackSource, setFallbackSource] = createSignal<string>();
  const [failed, setFailed] = createSignal(false);
  const direct = createMemo(() => artworkUrl(local.src));
  const deferred = createScrollDeferred(direct, () => Boolean(fallbackSource()));
  const resolved = createMemo(() => (deferred() ? undefined : (fallbackSource() ?? direct())));
  const [loaded, setLoaded] = createSignal(isPaintedSource(untrack(direct)));
  let image: HTMLImageElement | undefined;

  onMount(() => {
    const url = resolved();
    if (url && image && image.complete && image.naturalWidth > 0) {
      rememberPaintedSource(url);
      setLoaded(true);
    }
  });

  createEffect(on(direct, (next, previous) => {
    if (next !== previous) {
      setFallbackSource(undefined);
      setFailed(false);
    }
  }, { defer: true }));

  createEffect(on(resolved, (next) => {
    setLoaded(isPaintedSource(next));
  }, { defer: true }));

  const visible = () => !failed() && !!resolved() && loaded();

  return (
    <span
      data-artwork-surface
      {...rest}
      class={local.class ? `${styles.surface} ${local.class}` : styles.surface}
      style={!direct() || failed() ? { background: coverGradient(local.seed) } : undefined}
    >
      <img
        ref={image}
        src={resolved()}
        alt=""
        decoding="async"
        draggable={false}
        class={styles.image}
        classList={{ [styles.imageVisible]: visible() }}
        onLoad={() => {
          const url = resolved();
          if (url) rememberPaintedSource(url);
          setFailed(false);
          setLoaded(true);
        }}
        onError={() => {
          const current = resolved();
          if (!current) return;
          const old = artworkFallback(local.src);
          const fallbackUrl = old ? artworkUrl(old) : undefined;
          if (!fallbackSource() && fallbackUrl && fallbackUrl !== current) {
            rejectPreviewArtwork(local.src);
            setFallbackSource(fallbackUrl);
            setLoaded(isPaintedSource(fallbackUrl));
          } else {
            setFailed(true);
            setLoaded(false);
          }
        }}
      />
      {local.children}
    </span>
  );
}
