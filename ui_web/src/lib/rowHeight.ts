import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';

export type RowHeight = number | { cssVar: string; fallback: number };

/** The virtual slot and its CSS row must follow the same density recipe. */
export function createRowHeight(source: () => RowHeight = () => ({ cssVar: '--row-h', fallback: 56 })) {
  const read = () => {
    const value = source();
    if (typeof value === 'number') return value;
    if (typeof document === 'undefined') return value.fallback;
    const pixels = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(value.cssVar));
    return Number.isFinite(pixels) && pixels > 0 ? pixels : value.fallback;
  };
  const [height, setHeight] = createSignal(read());
  createEffect(() => setHeight(read()));
  onMount(() => {
    const sync = () => setHeight(read());
    const media = window.matchMedia('(min-width: 1024px)');
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-interface-size'] });
    media.addEventListener('change', sync);
    window.addEventListener('orientationchange', sync);
    sync();
    onCleanup(() => {
      observer.disconnect();
      media.removeEventListener('change', sync);
      window.removeEventListener('orientationchange', sync);
    });
  });
  return height;
}
