import { createEffect, createSignal, onCleanup, Show, type JSX } from 'solid-js';
import { apiOrigin } from '../lib/config';
import { artworkCandidates } from '../lib/media';

/** Fills its positioned cover slot; observes the actual slot instead of
 * guessing a grid width. The browser chooses the appropriate density. */
export function CoverImage(props: {
  src?: string | null;
  eager?: boolean;
  alt?: string;
  variants?: { url: string; width: number }[];
}) {
  const source = () => props.src?.startsWith('/api/') ? `${apiOrigin()}${props.src}` : props.src;
  let image: HTMLImageElement | undefined;
  const [width, setWidth] = createSignal(320);
  const [failed, setFailed] = createSignal(false);
  createEffect(() => { props.src; setFailed(false); });
  createEffect(() => {
    if (!props.src || !image) return;
    const target = image.parentElement;
    if (!target) return;
    const measure = () => setWidth(Math.max(1, Math.ceil(target.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    onCleanup(() => observer.disconnect());
  });
  const candidates = () => props.variants?.length
    ? props.variants.map(v => `${v.url} ${v.width}w`).join(', ')
    : artworkCandidates(source());
  // WebKit can start fetching src before applying a dynamic srcset. Keep the
  // fallback inside the same bounded variant set, never the embedded original.
  const fallback = () => candidates()?.split(', ')[0]?.replace(/ \d+w$/, '') || source();
  const style: JSX.CSSProperties = {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    'object-fit': 'cover', 'border-radius': 'inherit', 'pointer-events': 'none',
  };
  return <Show when={props.src && !failed()}>
    <img ref={image} sizes={`${width()}px`} srcset={candidates()} src={fallback()!}
      alt={props.alt ?? ''} loading={props.eager ? 'eager' : 'lazy'} decoding="async"
      draggable={false} style={style} onError={() => setFailed(true)} />
  </Show>;
}
