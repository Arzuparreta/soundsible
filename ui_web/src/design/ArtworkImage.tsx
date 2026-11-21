import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack, useContext } from 'solid-js';
import { artworkFallback, createScrollDeferred, isPaintedSource, rejectPreviewArtwork, rememberPaintedSource } from '../lib/artworkHints';
import { ArtworkWidthContext } from '../lib/artworkSlot';
import { artworkUrl } from '../lib/config';
import { artworkCandidates } from '../lib/media';
import styles from './Artwork.module.css';

/** Fills its positioned cover slot; observes the actual slot instead of
 * guessing a grid width. The browser chooses the appropriate density. */
export function ArtworkImage(props: {
  src?: string | null;
  eager?: boolean;
  alt?: string;
  variants?: { url: string; width: number }[];
}) {
  const [previousSource, setPreviousSource] = createSignal<string>();
  const direct = createMemo(() => artworkUrl(props.src));
  const source = createMemo(() => previousSource() || direct());
  const warm = () => isPaintedSource(source());
  const deferred = createScrollDeferred(direct, () => Boolean(previousSource()));
  let image: HTMLImageElement | undefined;
  const known = useContext(ArtworkWidthContext);
  const [measured, setWidth] = createSignal(320);
  const width = () => (known ? Math.max(1, Math.ceil(known())) : measured());
  const [failed, setFailed] = createSignal(false);
  const [loaded, setLoaded] = createSignal(isPaintedSource(untrack(source)));

  onMount(() => {
    const url = source();
    if (!deferred() && url && (isPaintedSource(url) || (image && image.complete && image.naturalWidth > 0))) {
      rememberPaintedSource(url);
      setLoaded(true);
    }
  });

  createEffect(on(() => props.src, () => {
    setFailed(false);
    setPreviousSource(undefined);
  }, { defer: true }));

  createEffect(on(source, (url) => {
    setLoaded(isPaintedSource(url));
  }, { defer: true }));

  createEffect(() => {
    if (known || !props.src || !image) return;
    const target = image.parentElement;
    if (!target) return;
    const measure = () => setWidth(Math.max(1, Math.ceil(target.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    onCleanup(() => observer.disconnect());
  });
  const candidates = createMemo(() => {
    if (props.variants?.length) return props.variants.map(v => `${v.url} ${v.width}w`).join(', ');
    const current = source();
    return current ? artworkCandidates(current) : undefined;
  });
  // WebKit can start fetching src before applying a dynamic srcset. Keep the
  // fallback inside the same bounded variant set, never the embedded original.
  const fallback = createMemo(() => candidates()?.split(', ')[0]?.replace(/ \d+w$/, '') || source());
  return <Show when={props.src && !failed()}>
    <img ref={image} sizes={`${width()}px`} srcset={deferred() ? undefined : candidates()} src={deferred() ? undefined : fallback()!}
      alt={props.alt ?? ''} loading={props.eager || warm() ? 'eager' : 'lazy'} decoding={warm() ? 'sync' : 'async'}
      draggable={false} class={styles.image} classList={{ [styles.imageVisible]: !deferred() && (loaded() || warm()) }}
      onLoad={() => {
        rememberPaintedSource(source());
        setLoaded(true);
      }}
      onError={() => {
        if (deferred()) return;
        const old = artworkFallback(props.src);
        if (!previousSource() && old) {
          rejectPreviewArtwork(props.src);
          setPreviousSource(artworkUrl(old));
        } else {
          setLoaded(false);
          setFailed(true);
        }
      }} />
  </Show>;
}
