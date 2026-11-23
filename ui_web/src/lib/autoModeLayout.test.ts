import { describe, expect, it } from 'vitest';
import { cloneAutoModeLayout, DEFAULT_AUTO_MODE_LAYOUT, parseAutoModeLayout } from './autoModeLayout';

describe('Auto Mode desktop layout', () => {
  it('starts with its artwork fitted', () => {
    expect(parseAutoModeLayout(null)).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
    expect(DEFAULT_AUTO_MODE_LAYOUT.fitArtwork).toBe(true);
  });

  it('accepts only complete DJ layouts, and drops the ones saved with the browser panel', () => {
    const parsed = parseAutoModeLayout(JSON.stringify({ version: 1, order: ['route', 'stage'], ratios: { stage: 3, route: 1 } }));
    expect(parsed).toEqual({ version: 1, order: ['route', 'stage'], ratios: { stage: 0.75, route: 0.25 } });
    expect(parseAutoModeLayout(JSON.stringify({
      version: 1, order: ['browser', 'stage', 'route'], ratios: { browser: 1, stage: 1, route: 1 },
    }))).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
  });

  it('clones the default without sharing order or ratios', () => {
    const layout = cloneAutoModeLayout();
    layout.ratios.stage = 0.4;
    layout.order.reverse();
    expect(cloneAutoModeLayout()).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
    expect(parseAutoModeLayout(JSON.stringify(cloneAutoModeLayout()))).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
  });
});
