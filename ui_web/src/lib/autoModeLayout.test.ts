import { describe, expect, it } from 'vitest';
import { autoModeLayoutFromPreset, DEFAULT_AUTO_MODE_LAYOUT, parseAutoModeLayout } from './autoModeLayout';

describe('Auto Mode desktop layout', () => {
  it('starts with the stage taking the wider share', () => {
    expect(parseAutoModeLayout(null)).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
    expect(DEFAULT_AUTO_MODE_LAYOUT.ratios).toEqual({ stage: 0.55, route: 0.45 });
  });

  it('accepts only complete DJ layouts, and drops the ones saved with the browser panel', () => {
    const parsed = parseAutoModeLayout(JSON.stringify({ version: 1, order: ['route', 'stage'], ratios: { stage: 3, route: 1 } }));
    expect(parsed).toEqual({ version: 1, order: ['route', 'stage'], ratios: { stage: 0.75, route: 0.25 } });
    expect(parseAutoModeLayout(JSON.stringify({
      version: 1, order: ['browser', 'stage', 'route'], ratios: { browser: 1, stage: 1, route: 1 },
    }))).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
  });

  it('returns fresh presets so a workspace resize cannot mutate them', () => {
    const layout = autoModeLayoutFromPreset('stage');
    layout.ratios.stage = 0.4;
    layout.order.reverse();
    expect(autoModeLayoutFromPreset('stage')).toEqual({ version: 1, order: ['stage', 'route'], ratios: { stage: 0.7, route: 0.3 } });
    expect(autoModeLayoutFromPreset('list')).toEqual({ version: 1, order: ['stage', 'route'], ratios: { stage: 0.4, route: 0.6 } });
  });
});
