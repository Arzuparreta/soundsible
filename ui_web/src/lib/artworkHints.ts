import { createEffect, createSignal, onCleanup, untrack, useContext, type Accessor } from 'solid-js';
import { ScrollActivityContext } from './artworkSlot';

/** Bounded URL hints shared by img and CSS renderers; never image bodies. */
export const previewFallbacks = new Map<string, string>();
export const rejectedPreviews = new Set<string>();

const MAX_PAINTED_SOURCES = 512;
const paintedSources = new Set<string>();
const FRAME_ARTWORK_BUDGET = 6;
const pendingArtworkLoads: Array<() => void> = [];
let artworkFlushFrame = 0;

function flushArtworkLoads(): void {
  artworkFlushFrame = 0;
  let remaining = FRAME_ARTWORK_BUDGET;
  while (remaining > 0 && pendingArtworkLoads.length > 0) {
    const next = pendingArtworkLoads.shift()!;
    remaining -= 1;
    next();
  }
  if (pendingArtworkLoads.length > 0 && typeof requestAnimationFrame === 'function') {
    artworkFlushFrame = requestAnimationFrame(flushArtworkLoads);
  }
}

export function scheduleArtworkLoad(cb: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    cb();
    return () => {};
  }
  pendingArtworkLoads.push(cb);
  if (!artworkFlushFrame) {
    artworkFlushFrame = requestAnimationFrame(flushArtworkLoads);
  }
  return () => {
    const index = pendingArtworkLoads.indexOf(cb);
    if (index >= 0) pendingArtworkLoads.splice(index, 1);
  };
}

export function isPaintedSource(url?: string | null): boolean {
  return !!url && paintedSources.has(url);
}

export function rememberPaintedSource(url?: string | null): void {
  if (!url) return;
  paintedSources.delete(url);
  paintedSources.add(url);
  if (paintedSources.size > MAX_PAINTED_SOURCES) paintedSources.delete(paintedSources.values().next().value!);
}

/** Defer uncached artwork fetches while a collection scroller is flinging fast. */
export function createScrollDeferred(
  direct: Accessor<string | undefined>,
  hasFallback: Accessor<boolean>,
): Accessor<boolean> {
  const scrollingFast = useContext(ScrollActivityContext);
  const [readyToLoad, setReadyToLoad] = createSignal(!untrack(scrollingFast));
  createEffect(() => {
    if (scrollingFast()) {
      setReadyToLoad(false);
      return;
    }
    if (untrack(readyToLoad)) return;
    const cancel = scheduleArtworkLoad(() => setReadyToLoad(true));
    onCleanup(cancel);
  });
  return () => !readyToLoad() && !hasFallback() && !isPaintedSource(direct());
}

export function artworkFallback(src?: string | null): string | undefined {
  if (!src) return undefined;
  const previous = previewFallbacks.get(src);
  if (previous) return previous;
  try {
    const url = new URL(src);
    const match = url.pathname.match(/^\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\/(maxresdefault|hq720|sddefault|hqdefault)\.(?:jpg|webp)$/);
    if (url.protocol === 'https:' && ['img.youtube.com', 'i.ytimg.com'].includes(url.hostname) && match)
      return `https://i.ytimg.com/vi/${match[1]}/mqdefault.jpg`;
  } catch { /* a local artwork URL has its own error state */ }
  return undefined;
}

export function rejectPreviewArtwork(src?: string | null): void {
  if (!src || !previewFallbacks.has(src)) return;
  rejectedPreviews.add(src);
  if (rejectedPreviews.size > 256) rejectedPreviews.delete(rejectedPreviews.values().next().value!);
}
