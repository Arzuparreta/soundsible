import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOW_PLAYING_LAYOUT,
  layoutFromPreset,
  movePanel,
  normalizePanelRatios,
  parseNowPlayingLayout,
  reorderPanel,
  resizeAdjacentPanels,
} from './nowPlayingLayout';

describe('nowPlayingLayout', () => {
  it('rejects corrupt layouts and the three-panel layouts saved before the browser panel went', () => {
    expect(parseNowPlayingLayout('{nope')).toEqual(DEFAULT_NOW_PLAYING_LAYOUT);
    expect(parseNowPlayingLayout(JSON.stringify({ version: 1, order: ['stage'], ratios: {} }))).toEqual(DEFAULT_NOW_PLAYING_LAYOUT);
    expect(parseNowPlayingLayout(JSON.stringify({
      version: 1, order: ['browser', 'stage', 'queue'], ratios: { browser: 0.32, stage: 0.36, queue: 0.32 },
    }))).toEqual(DEFAULT_NOW_PLAYING_LAYOUT);
  });

  it('lets equal halves follow the default, and keeps any layout someone chose', () => {
    expect(parseNowPlayingLayout(JSON.stringify({ version: 1, order: ['stage', 'queue'], ratios: { stage: 0.5, queue: 0.5 } })))
      .toEqual(DEFAULT_NOW_PLAYING_LAYOUT);
    expect(parseNowPlayingLayout(JSON.stringify({ version: 1, order: ['queue', 'stage'], ratios: { stage: 0.5, queue: 0.5 } })))
      .toEqual({ version: 1, order: ['queue', 'stage'], ratios: { stage: 0.5, queue: 0.5 } });
    expect(parseNowPlayingLayout(JSON.stringify({ version: 1, order: ['stage', 'queue'], ratios: { stage: 0.7, queue: 0.3 } })).ratios)
      .toEqual({ stage: 0.7, queue: 0.3 });
  });

  it('keeps both panels while moving or dropping one', () => {
    expect(movePanel(['stage', 'queue'], 'stage', 1)).toEqual(['queue', 'stage']);
    expect(reorderPanel(['stage', 'queue'], 'queue', 0)).toEqual(['queue', 'stage']);
  });

  it('normalizes ratios and clamps adjacent resizing', () => {
    expect(normalizePanelRatios({ stage: 3, queue: 1 })).toEqual({ stage: 0.75, queue: 0.25 });
    const resized = resizeAdjacentPanels({ stage: 0.5, queue: 0.5 }, 'stage', 'queue', 0.5, { queue: 0.3 });
    expect(resized.stage).toBeCloseTo(0.7);
    expect(resized.queue).toBeCloseTo(0.3);
  });

  it('builds independent presets that give the room to the stage or to the queue', () => {
    expect(layoutFromPreset('balanced')).toEqual(DEFAULT_NOW_PLAYING_LAYOUT);
    expect(layoutFromPreset('stage')).toEqual({ version: 1, order: ['stage', 'queue'], ratios: { stage: 0.7, queue: 0.3 } });
    expect(layoutFromPreset('list')).toEqual({ version: 1, order: ['stage', 'queue'], ratios: { stage: 0.4, queue: 0.6 } });
    const first = layoutFromPreset('balanced');
    first.order.reverse();
    first.ratios.stage = 1;
    expect(layoutFromPreset('balanced')).toEqual(DEFAULT_NOW_PLAYING_LAYOUT);
  });
});
