import { createRoot, createSignal } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLUR_REFERENCE_EDGE,
  MAX_BACKDROP_EDGE,
  createStageBackdrops,
  rasterizeStageBackdrop,
  resetStageBackdropCacheForTests,
} from './stageBackdrop';

beforeEach(() => {
  resetStageBackdropCacheForTests();
  vi.restoreAllMocks();
});

describe('createStageBackdrops', () => {
  it('alternates slots on cover change and preserves reference when unchanged', () => {
    createRoot((dispose) => {
      const [src, setSrc] = createSignal('/cover-a.jpg');
      const slots = createStageBackdrops(src);

      expect(slots()).toEqual({ first: '/cover-a.jpg', second: '', active: 'first' });

      setSrc('/cover-a.jpg');
      expect(slots()).toEqual({ first: '/cover-a.jpg', second: '', active: 'first' });

      setSrc('/cover-b.jpg');
      expect(slots()).toEqual({ first: '/cover-a.jpg', second: '/cover-b.jpg', active: 'second' });

      setSrc('/cover-c.jpg');
      expect(slots()).toEqual({ first: '/cover-c.jpg', second: '/cover-b.jpg', active: 'first' });

      dispose();
    });
  });
});

describe('rasterizeStageBackdrop', () => {
  it('rasterizes once per (src, filter) across multiple consumers and scales blur', () => {
    const drawImage = vi.fn();
    const fakeContext = {
      filter: 'none',
      drawImage,
    } as unknown as CanvasRenderingContext2D;

    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = createElement(tag);
      if (tag === 'canvas') {
        vi.spyOn(element as HTMLCanvasElement, 'getContext').mockReturnValue(fakeContext);
      }
      return element;
    });

    const image = { naturalWidth: 640, naturalHeight: 640, currentSrc: '/cover-a.jpg' } as HTMLImageElement;
    const darkFilter = 'blur(62px) saturate(1.42) brightness(0.5)';

    const first = rasterizeStageBackdrop('/cover-a.jpg', image, darkFilter);
    const second = rasterizeStageBackdrop('/cover-a.jpg', image, darkFilter);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(drawImage).toHaveBeenCalledTimes(1);
    const expectedBlur = (62 * (MAX_BACKDROP_EDGE / BLUR_REFERENCE_EDGE)).toFixed(2);
    expect(first!.scaledFilter).toBe(`blur(${expectedBlur}px) saturate(1.42) brightness(0.5)`);

    const lightFilter = 'blur(64px) saturate(1.85) brightness(1.22)';
    const third = rasterizeStageBackdrop('/cover-a.jpg', image, lightFilter);
    expect(third).not.toBeNull();
    expect(third).not.toBe(first);
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it('skips rasterization when filter is none', () => {
    const image = { naturalWidth: 640, naturalHeight: 640, currentSrc: '/cover-a.jpg' } as HTMLImageElement;
    expect(rasterizeStageBackdrop('/cover-a.jpg', image, 'none')).toBeNull();
    expect(rasterizeStageBackdrop('/cover-a.jpg', image, '')).toBeNull();
  });
});
