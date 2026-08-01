import { describe, expect, it } from 'vitest';
import {
  autoModeLayoutFromPreset,
  DEFAULT_AUTO_MODE_LAYOUT,
  parseAutoModeLayout,
} from './autoModeLayout';

describe('Auto Mode desktop layout', () => {
  it('starts with the Stage dominant between Booth and Route', () => {
    expect(parseAutoModeLayout(null)).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
    expect(DEFAULT_AUTO_MODE_LAYOUT.ratios.stage).toBeGreaterThan(DEFAULT_AUTO_MODE_LAYOUT.ratios.booth);
    expect(DEFAULT_AUTO_MODE_LAYOUT.ratios.stage).toBeGreaterThan(DEFAULT_AUTO_MODE_LAYOUT.ratios.route);
  });

  it('accepts only complete Auto panel layouts and normalizes their ratios', () => {
    const parsed = parseAutoModeLayout(JSON.stringify({
      version: 1,
      order: ['route', 'stage', 'booth'],
      ratios: { booth: 2, stage: 5, route: 3 },
    }));
    expect(parsed.order).toEqual(['route', 'stage', 'booth']);
    expect(parsed.ratios).toEqual({ booth: 0.2, stage: 0.5, route: 0.3 });

    expect(parseAutoModeLayout(JSON.stringify({
      version: 1,
      order: ['browser', 'stage', 'queue'],
      ratios: { browser: 1, stage: 1, queue: 1 },
    }))).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
  });

  it('maps the shared three-panel presets onto Booth, Stage and Route', () => {
    expect(autoModeLayoutFromPreset('balanced')).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
    expect(autoModeLayoutFromPreset('stage')).toEqual({
      version: 1,
      order: ['booth', 'stage', 'route'],
      ratios: { booth: 0.2, stage: 0.6, route: 0.2 },
    });
    expect(autoModeLayoutFromPreset('left')).toEqual({
      version: 1,
      order: ['stage', 'booth', 'route'],
      ratios: { booth: 0.5, stage: 0.3, route: 0.2 },
    });
    expect(autoModeLayoutFromPreset('right')).toEqual({
      version: 1,
      order: ['booth', 'route', 'stage'],
      ratios: { booth: 0.2, stage: 0.3, route: 0.5 },
    });
  });

  it('returns fresh layouts so a workspace resize cannot mutate its presets', () => {
    const layout = autoModeLayoutFromPreset('stage');
    layout.ratios.stage = 0.4;
    layout.order.reverse();

    expect(autoModeLayoutFromPreset('stage')).toEqual({
      version: 1,
      order: ['booth', 'stage', 'route'],
      ratios: { booth: 0.2, stage: 0.6, route: 0.2 },
    });
  });
});
