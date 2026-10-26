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

describe('pulse alignment at execution', () => {
  it('moves only by whole outgoing bars that are also whole common cycles', async () => {
    const { readFileSync } = await import('node:fs');
    const { metricCuePlacement } = await import('./djCue');
    const cases = JSON.parse(readFileSync(new NodeURL('../../../shared/contracts/dj_metric_plans.json', import.meta.url), 'utf8'));
    const transition = (name: string) => cases.find((row: { name: string }) => row.name === name).transition;
    // Three against four pulses: whole 1.5 s outgoing bars keep its one on the incoming one.
    const threeFour = transition('three-to-four');
    expect(threeFour.sync.alignment).toBe('beats');
    expect(metricCuePlacement(threeFour.out_cue, 90, 175, threeFour, threeFour.overlap_seconds)).toEqual({ cue: 174.25, aligned: true });
    const four = transition('unconfirmed-four');
    expect(metricCuePlacement(four.out_cue, 90, 167, four, four.overlap_seconds)).toEqual({ cue: 166.25, aligned: true });
    // 120 against 180 BPM: two outgoing beats are three incoming ones; a 2 s
    // outgoing bar is two such cycles.
    const threeTwo = transition('three-two-pulses');
    expect(threeTwo.sync.cycle_beats).toEqual([2, 3]);
    expect(metricCuePlacement(threeTwo.out_cue, 90, 167, threeTwo, threeTwo.overlap_seconds)).toEqual({ cue: 166.25, aligned: true });
  });

  it('rejects a pulse plan without coverage, cycle or step, or with a contradictory period', async () => {
    const { readFileSync } = await import('node:fs');
    const { metricCuePlacement } = await import('./djCue');
    const cases = JSON.parse(readFileSync(new NodeURL('../../../shared/contracts/dj_metric_plans.json', import.meta.url), 'utf8'));
    for (const name of ['three-to-four', 'unconfirmed-four', 'three-two-pulses', 'four-three-pulses']) {
      const original = cases.find((row: { name: string }) => row.name === name).transition;
      expect(metricCuePlacement(original.out_cue, 90, 215, original, original.overlap_seconds).aligned, name).toBe(true);
      for (const change of [{ out_metre: null }, { in_metre: null }, { in_period: original.sync.in_period * 1.1 },
        { out_period: 0 }, { out_metre: { ...original.sync.out_metre, end: 12 } }, { in_bar_seconds: 1.7 },
        { alignment: 'none' }, { cycle_beats: null }, { cycle_beats: [5, 7] }, { cycle_beats: [1, 1] },
        { relocation_seconds: 0 }]) {
        const plan = { ...original, sync: { ...original.sync, ...change } };
        if (name === 'three-to-four' || name === 'unconfirmed-four') {
          if (JSON.stringify(change) === '{"cycle_beats":[1,1]}') continue;  // Already their cycle.
        }
        expect(metricCuePlacement(original.out_cue, 90, 215, plan, plan.overlap_seconds).aligned, `${name} ${JSON.stringify(change)}`).toBe(false);
      }
    }
  });
});

describe('coverage edge', () => {
  it('keeps a cue whose overlap ends within the phase tolerance of the measured coverage', async () => {
    // User's session, 2026-10-26: 0.9 ms past the coverage moved the cue one
    // beat and the incoming one landed on the outgoing beat 4.
    const { readFileSync } = await import('node:fs');
    const { metricCuePlacement } = await import('./djCue');
    const cases = JSON.parse(readFileSync(new NodeURL('../../../shared/contracts/dj_metric_plans.json', import.meta.url), 'utf8'));
    for (const name of ['unconfirmed-four', 'three-quarter']) {
      const original = cases.find((row: { name: string }) => row.name === name).transition;
      const end = original.out_cue + original.overlap_seconds - 0.0009;
      const plan = { ...original, sync: { ...original.sync, out_metre: { ...original.sync.out_metre, end } } };
      expect(metricCuePlacement(original.out_cue, 90, 215, plan, plan.overlap_seconds), name).toEqual({ cue: original.out_cue, aligned: true });
      const beyond = { ...original, sync: { ...original.sync, out_metre: { ...original.sync.out_metre, end: end - 0.01 } } };
      expect(metricCuePlacement(original.out_cue, 90, 215, beyond, beyond.overlap_seconds).cue, name).not.toBe(original.out_cue);
    }
  });
});
