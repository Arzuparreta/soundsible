import { describe, expect, it } from 'vitest';
import {
  autoModeLayoutFromPreset,
  DEFAULT_AUTO_MODE_LAYOUT,
  parseAutoModeLayout,
} from './autoModeLayout';

describe('Auto Mode desktop layout', () => {
  it('starts with three equally sized panels', () => {
    expect(parseAutoModeLayout(null)).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
    expect(new Set(Object.values(DEFAULT_AUTO_MODE_LAYOUT.ratios))).toEqual(new Set([1 / 3]));
  });

  it('accepts only complete Auto panel layouts and normalizes their ratios', () => {
    const parsed = parseAutoModeLayout(JSON.stringify({
      version: 1,
      order: ['route', 'stage', 'browser'],
      ratios: { browser: 2, stage: 5, route: 3 },
    }));
    expect(parsed.order).toEqual(['route', 'stage', 'browser']);
    expect(parsed.ratios).toEqual({ browser: 0.2, stage: 0.5, route: 0.3 });

    expect(parseAutoModeLayout(JSON.stringify({
      version: 1,
      order: ['browser', 'stage', 'queue'],
      ratios: { browser: 1, stage: 1, queue: 1 },
    }))).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
  });

  it('maps the shared three-panel presets onto Browser, Stage and Route', () => {
    expect(autoModeLayoutFromPreset('balanced')).toEqual(DEFAULT_AUTO_MODE_LAYOUT);
    expect(autoModeLayoutFromPreset('stage')).toEqual({
      version: 1,
      order: ['browser', 'stage', 'route'],
      ratios: { browser: 0.2, stage: 0.6, route: 0.2 },
    });
    expect(autoModeLayoutFromPreset('left')).toEqual({
      version: 1,
      order: ['stage', 'browser', 'route'],
      ratios: { browser: 0.5, stage: 0.3, route: 0.2 },
    });
    expect(autoModeLayoutFromPreset('right')).toEqual({
      version: 1,
      order: ['browser', 'route', 'stage'],
      ratios: { browser: 0.2, stage: 0.3, route: 0.5 },
    });
  });

  it('returns fresh layouts so a workspace resize cannot mutate its presets', () => {
    const layout = autoModeLayoutFromPreset('stage');
    layout.ratios.stage = 0.4;
    layout.order.reverse();

    expect(autoModeLayoutFromPreset('stage')).toEqual({
      version: 1,
      order: ['browser', 'stage', 'route'],
      ratios: { browser: 0.2, stage: 0.6, route: 0.2 },
    });
  });
});
