import { describe, expect, it } from 'vitest';
import { URL as NodeURL } from 'node:url';
import { placeOutCue, planBarSeconds } from './djCue';

describe('placeOutCue', () => {
  it('keeps a cue that already fits', () => {
    expect(placeOutCue(150, 90, 170, 2)).toBe(150);
  });

  it('moves a late cue back by whole bars so it stays on a downbeat', () => {
    // 172.4 is a downbeat; 170 is the latest start the player allows.
    const cue = placeOutCue(172.4, 90, 170, 1.9355);
    expect(cue).toBeCloseTo(172.4 - 2 * 1.9355, 9);
    expect(cue).toBeLessThanOrEqual(170);
  });

  it('moves an early cue forward by whole bars', () => {
    const cue = placeOutCue(80.5, 90, 170, 2);
    expect(cue).toBeCloseTo(90.5, 9);
  });

  it('clamps when no whole bar fits or the bar is not a measured one', () => {
    expect(placeOutCue(100, 101, 101.5, 2)).toBe(101);
    expect(placeOutCue(172, 90, 170, 0)).toBe(170);
    expect(placeOutCue(172, 90, 170, Number.NaN)).toBe(170);
  });
});

describe('planBarSeconds', () => {
  it('reads four measured beats of the outgoing song', () => {
    expect(planBarSeconds({ out_period: 0.46875 })).toBeCloseTo(1.875, 12);
    expect(planBarSeconds(undefined)).toBe(0);
    expect(planBarSeconds({ out_period: -1 })).toBe(0);
  });
});

// Metre-aware fixtures are also executed through the store and Android resolver.
describe('explicit metric bars', () => {
  it('uses three pulses or a compound bar instead of four pulses', () => {
    expect(planBarSeconds({ out_period: .5, out_bar_seconds: 1.5 })).toBe(1.5);
    expect(planBarSeconds({ out_period: .5, out_bar_seconds: 1 })).toBe(1);
    expect(planBarSeconds({ out_period: .5, out_bar_seconds: null })).toBe(0);
    expect(planBarSeconds({ out_period: .5, out_bar_seconds: Number.NaN })).toBe(0);
    expect(placeOutCue(185.4, 90, 183, 1.5)).toBeCloseTo(182.4, 9);
  });
});

describe('metric coverage at execution', () => {
  it('rejects missing coverage and contradictory executed bar or pulse periods', async () => {
    const { readFileSync } = await import('node:fs');
    const { metricCuePlacement } = await import('./djCue');
    const cases = JSON.parse(readFileSync(new NodeURL('../../../shared/contracts/dj_metric_plans.json', import.meta.url), 'utf8'));
    const original = cases.find((row: { name: string }) => row.name === 'three-quarter').transition;
    expect(metricCuePlacement(original.out_cue, 90, 215, original, original.overlap_seconds).aligned).toBe(true);
    for (const change of [{ out_metre: null }, { in_bar_seconds: 2 }, { in_period: .55 },
      { out_bar_seconds: null }, { out_metre: { ...original.sync.out_metre, end: 12 } }]) {
      const plan = { ...original, sync: { ...original.sync, ...change } };
      expect(metricCuePlacement(original.out_cue, 90, 215, plan, plan.overlap_seconds).aligned).toBe(false);
    }
  });
});
