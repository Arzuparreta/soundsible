import { describe, expect, it } from 'vitest';
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
