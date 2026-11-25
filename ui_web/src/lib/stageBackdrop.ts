import { createMemo } from 'solid-js';
import { player } from '../stores/player';
import { trackCoverUrl } from './media';

export const MAX_BACKDROP_EDGE = 240;
/** Nominal reference span used to normalize blur radii across sidebar and player panels. */
export const BLUR_REFERENCE_EDGE = 900;
const MAX_CACHE_ENTRIES = 4;

export interface BackdropSlots {
  first: string;
  second: string;
  active: 'first' | 'second';
}

export interface RasterizedBackdrop {
  canvas: HTMLCanvasElement;
  sourceFilter: string;
  scaledFilter: string;
}

const loadedImages = new Map<string, HTMLImageElement>();
const pendingImages = new Map<string, Promise<HTMLImageElement | null>>();
const bitmapCache = new Map<string, RasterizedBackdrop>();

function remember<K, V>(cache: Map<K, V>, key: K, value: V): V {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

export function currentStageArt(): string {
  const track = player().playback.currentTrack;
  return track ? trackCoverUrl(track, 'thumb') ?? '' : '';
}

/**
 * Alternates two backdrop slots on cover changes so crossfading surfaces
 * transition cleanly without re-creating active layers.
 */
export function createStageBackdrops(source: () => string = currentStageArt): () => BackdropSlots {
  return createMemo<BackdropSlots>((previous) => {
    const next = source();
    if (!previous) return { first: next, second: '', active: 'first' };
    const visible = previous.active === 'first' ? previous.first : previous.second;
    if (next === visible) return previous;
    return previous.active === 'first'
      ? { ...previous, second: next, active: 'second' }
      : { ...previous, first: next, active: 'first' };
  });
}

export function getCachedStageImage(src: string): HTMLImageElement | undefined {
  const image = loadedImages.get(src);
  if (!image) return undefined;
  loadedImages.delete(src);
  loadedImages.set(src, image);
  return image;
}

export function loadStageImage(src: string): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  const cached = getCachedStageImage(src);
  if (cached) return Promise.resolve(cached);
  const inflight = pendingImages.get(src);
  if (inflight) return inflight;

  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => {
      pendingImages.delete(src);
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        remember(loadedImages, src, image);
        resolve(image);
      } else {
        resolve(null);
      }
    };
    image.onerror = () => {
      pendingImages.delete(src);
      resolve(null);
    };
    image.src = src;
  });
  pendingImages.set(src, promise);
  return promise;
}

/**
 * Rasterizes the blurred stage wallpaper once per `(image, filter)` pair into a
 * bounded 240px bitmap so Sidebar and PlayerSurface share one Gaussian blur pass.
 */
export function rasterizeStageBackdrop(
  src: string,
  image: HTMLImageElement,
  filter: string,
): RasterizedBackdrop | null {
  if (!filter || filter === 'none' || typeof document === 'undefined' || !image.naturalWidth || !image.naturalHeight) {
    return null;
  }
  const key = `${image.currentSrc || src}|${filter}`;
  const cached = bitmapCache.get(key);
  if (cached) {
    bitmapCache.delete(key);
    bitmapCache.set(key, cached);
    return cached;
  }
  const canvas = document.createElement('canvas');
  canvas.width = MAX_BACKDROP_EDGE;
  canvas.height = MAX_BACKDROP_EDGE;
  const ctx = canvas.getContext('2d');
  if (!ctx || !('filter' in ctx)) return null;

  const ratio = Math.min(1, MAX_BACKDROP_EDGE / BLUR_REFERENCE_EDGE);
  const scaledFilter = filter.replace(/blur\(([\d.]+)px\)/g, (_match, px) =>
    `blur(${(Number(px) * ratio).toFixed(2)}px)`);
  ctx.filter = scaledFilter;
  const scale = Math.max(MAX_BACKDROP_EDGE / image.naturalWidth, MAX_BACKDROP_EDGE / image.naturalHeight);
  const drawnWidth = image.naturalWidth * scale;
  const drawnHeight = image.naturalHeight * scale;
  ctx.drawImage(
    image,
    (MAX_BACKDROP_EDGE - drawnWidth) / 2,
    (MAX_BACKDROP_EDGE - drawnHeight) / 2,
    drawnWidth,
    drawnHeight,
  );
  return remember(bitmapCache, key, { canvas, sourceFilter: filter, scaledFilter });
}

export function resetStageBackdropCacheForTests(): void {
  loadedImages.clear();
  pendingImages.clear();
  bitmapCache.clear();
}
