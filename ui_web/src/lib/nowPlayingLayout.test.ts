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
  it('migrates the old docking side and rejects corrupt layouts', () => {
    expect(parseNowPlayingLayout(null, 'right').order).toEqual(['stage', 'queue', 'browser']);
    expect(parseNowPlayingLayout('{nope', 'left')).toEqual(DEFAULT_NOW_PLAYING_LAYOUT);
    expect(parseNowPlayingLayout(JSON.stringify({ version: 1, order: ['stage'], ratios: {} }))).toEqual(
      DEFAULT_NOW_PLAYING_LAYOUT,
    );
  });

  it('keeps all three panels while moving or dropping one', () => {
    expect(movePanel(['browser', 'stage', 'queue'], 'stage', -1)).toEqual(['stage', 'browser', 'queue']);
    expect(reorderPanel(['browser', 'stage', 'queue'], 'queue', 0)).toEqual(['queue', 'browser', 'stage']);
  });

  it('normalizes ratios and clamps adjacent resizing', () => {
    expect(normalizePanelRatios({ browser: 1, stage: 2, queue: 1 })).toEqual({
      browser: 0.25,
      stage: 0.5,
      queue: 0.25,
    });
    const resized = resizeAdjacentPanels(
      { browser: 0.25, stage: 0.5, queue: 0.25 },
      'browser',
      'stage',
      0.5,
      { browser: 0.2, stage: 0.4 },
    );
    expect(resized.browser).toBeCloseTo(0.35);
    expect(resized.stage).toBeCloseTo(0.4);
    expect(resized.queue).toBeCloseTo(0.25);
  });

  it('builds independent presets with their intended order and emphasis', () => {
    expect(layoutFromPreset('balanced')).toEqual(DEFAULT_NOW_PLAYING_LAYOUT);
    expect(layoutFromPreset('player')).toEqual({
      version: 1,
      order: ['browser', 'stage', 'queue'],
      ratios: { browser: 0.2, stage: 0.6, queue: 0.2 },
    });
    expect(layoutFromPreset('explore')).toEqual({
      version: 1,
      order: ['stage', 'browser', 'queue'],
      ratios: { browser: 0.5, stage: 0.3, queue: 0.2 },
    });
    expect(layoutFromPreset('queue')).toEqual({
      version: 1,
      order: ['browser', 'queue', 'stage'],
      ratios: { browser: 0.2, stage: 0.3, queue: 0.5 },
    });

    const first = layoutFromPreset('balanced');
    first.order.reverse();
    first.ratios.stage = 1;
    expect(layoutFromPreset('balanced')).toEqual(DEFAULT_NOW_PLAYING_LAYOUT);
  });
});
