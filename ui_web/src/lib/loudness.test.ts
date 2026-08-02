import { describe, expect, it } from 'vitest';
import type { Track } from '../types/music';
import {
  ALBUM_COVERAGE,
  MAX_GAIN_DB,
  MAX_LINEAR,
  MIN_GAIN_DB,
  MIN_LINEAR,
  PEAK_CEILING_DBTP,
  TARGET_LUFS,
  albumReference,
  gainToLinear,
  levelFor,
  levelGainDb,
} from './loudness';

function track(id: string, lufs?: number | null, peak?: number | null, duration = 240): Track {
  return {
    id, title: id, artist: 'Artist', duration,
    loudness_lufs: lufs, loudness_peak_dbtp: peak,
  } as Track;
}

const ctx = { enabled: true, shuffle: false };

describe('levelGainDb', () => {
  it('brings a modern loud master down to the target', () => {
    // -9 LUFS with 1 dB of headroom: the peak ceiling does not bind, so the
    // full correction applies and it lands exactly on target.
    expect(levelGainDb(-9, -1)).toBeCloseTo(-5, 5);
  });

  it('attenuates a clipped loudness-war master and pulls its peak back under', () => {
    const gain = levelGainDb(-5.5, 1.4);
    expect(gain).toBeCloseTo(-8.5, 5);
    // Its true peak drops to -7.1 dBTP, so its intersample clipping stops
    // reaching the output at all. Strictly better than leaving it alone.
    expect(1.4 + gain).toBeLessThan(PEAK_CEILING_DBTP);
  });

  it('boosts a quiet recording that has the headroom for it', () => {
    // -24 LUFS peaking at -8 dBTP: wants +10, capped at +6 by the boost limit.
    expect(levelGainDb(-24, -8)).toBeCloseTo(MAX_GAIN_DB, 5);
  });

  it('refuses the part of a boost that would breach the peak ceiling', () => {
    // The same loudness, but the transfer is peak-limited to -0.5 dBTP. Only
    // -0.5 dB of headroom exists, so that is all it gets. Under-correcting a
    // 23 LU-dynamic recording is right: fully levelling it would need a limiter.
    expect(levelGainDb(-24, -0.5)).toBeCloseTo(-0.5, 5);
  });

  it('leaves a track already at the target essentially alone', () => {
    expect(Math.abs(levelGainDb(-14.2, -1.2))).toBeLessThan(0.5);
  });

  it('never exceeds its own bounds, for any input', () => {
    for (let lufs = -70; lufs <= 5; lufs += 0.25) {
      for (let peak = -70; peak <= 12; peak += 0.5) {
        const gain = levelGainDb(lufs, peak);
        expect(gain).toBeGreaterThanOrEqual(MIN_GAIN_DB);
        expect(gain).toBeLessThanOrEqual(MAX_GAIN_DB);
      }
    }
  });

  it('never lets a corrected track breach the ceiling', () => {
    for (let lufs = -40; lufs <= 2; lufs += 0.25) {
      for (let peak = -30; peak <= 6; peak += 0.25) {
        const gain = levelGainDb(lufs, peak);
        if (gain !== 0) expect(peak + gain).toBeLessThanOrEqual(PEAK_CEILING_DBTP + 1e-9);
      }
    }
  });

  it.each([
    ['unmeasured', undefined, undefined],
    ['null', null, null],
    ['not a number', NaN, -1],
    ['a string', '-14', '-1'],
    ['the meter floor', -70, -20],
    ['below the meter floor', -75, -20],
    ['not physical', 40, -1],
    ['an impossible peak', -14, 99],
  ])('does not correct %s', (_label, lufs, peak) => {
    // No guessing. Anything we cannot stand behind is left exactly alone.
    expect(levelGainDb(lufs, peak)).toBe(0);
  });
});

describe('gainToLinear', () => {
  it('converts dB to a multiplier', () => {
    expect(gainToLinear(0)).toBeCloseTo(1, 5);
    expect(gainToLinear(-6)).toBeCloseTo(0.5012, 3);
    expect(gainToLinear(6)).toBeCloseTo(1.995, 3);
  });

  it('can never reach silence', () => {
    // Silence on a playing deck looks exactly like a dead audio graph, and the
    // mixer would tear the graph down and drop the live tap with it. A finite
    // but absurd gain is clamped to the floor rather than honoured.
    expect(gainToLinear(-200)).toBe(MIN_LINEAR);
    expect(gainToLinear(200)).toBe(MAX_LINEAR);
  });

  it('treats a non-finite gain as no correction at all', () => {
    // These can only arrive from a bug upstream, and the safe reading of a
    // number we cannot trust is "leave the track alone" — never "mute it".
    expect(gainToLinear(NaN)).toBe(1);
    expect(gainToLinear(-Infinity)).toBe(1);
    expect(gainToLinear(Infinity)).toBe(1);
  });
});

describe('albumReference', () => {
  it('sits between the loudest and quietest tracks', () => {
    const album = [track('a', -8, -1), track('b', -20, -6), track('c', -14, -3)];
    const reference = albumReference(album)!;
    expect(reference.lufs).toBeGreaterThan(-20);
    expect(reference.lufs).toBeLessThan(-8);
    // The ceiling has to come from the loudest peak on the record, or levelling
    // the album would clip its loudest track.
    expect(reference.peak).toBe(-1);
  });

  it('weights by duration, so a short interlude does not drag the record down', () => {
    const withInterlude = [track('long', -8, -1, 600), track('interlude', -30, -20, 20)];
    const evenly = [track('long', -8, -1, 100), track('interlude', -30, -20, 100)];
    expect(albumReference(withInterlude)!.lufs).toBeGreaterThan(albumReference(evenly)!.lufs);
  });

  it('gives every track on the album the same correction', () => {
    const album = [track('loud', -8, -1), track('quiet', -22, -9)];
    const reference = albumReference(album)!;
    const gain = levelGainDb(reference.lufs, reference.peak);
    // Which is the entire point: the quiet track stays quieter than the loud
    // one, exactly as the record was made.
    const loudAfter = -8 + gain;
    const quietAfter = -22 + gain;
    expect(loudAfter - quietAfter).toBeCloseTo(14, 5);
  });

  it('refuses a part-measured album', () => {
    // Otherwise the reference would be set by whichever tracks the sweep
    // happened to reach, and would shift underneath the listener as it reached
    // more. Non-deterministic loudness is worse than none.
    const album = [track('a', -8, -1), track('b', null, null), track('c', null, null)];
    expect(albumReference(album)).toBeNull();
  });

  it('accepts an album measured past the coverage threshold', () => {
    const album = Array.from({ length: 10 }, (_, i) => track(`t${i}`, -12, -2));
    expect(album.length * ALBUM_COVERAGE).toBeLessThanOrEqual(10);
    expect(albumReference(album)).not.toBeNull();
  });

  it('is null for an empty album', () => {
    expect(albumReference([])).toBeNull();
  });
});

describe('levelFor', () => {
  it('is exactly 1 when levelling is off', () => {
    // Identity, not approximately: turning the setting off has to restore the
    // previous output bit for bit.
    expect(levelFor(track('a', -8, -1), { ...ctx, enabled: false })).toBe(1);
  });

  it('is exactly 1 for an unmeasured track', () => {
    expect(levelFor(track('a'), ctx)).toBe(1);
    expect(levelFor(null, ctx)).toBe(1);
    expect(levelFor(undefined, ctx)).toBe(1);
  });

  it('uses the track gain by default', () => {
    expect(levelFor(track('a', -8, -1), ctx)).toBeCloseTo(gainToLinear(levelGainDb(-8, -1)), 6);
  });

  it('uses the album reference when a record is played in order', () => {
    const siblings = [track('a', -8, -1), track('b', -20, -6)];
    const level = levelFor(siblings[1], {
      ...ctx, siblings, contextKind: 'album', contextId: 'album:1',
    });
    const reference = albumReference(siblings)!;
    expect(level).toBeCloseTo(gainToLinear(levelGainDb(reference.lufs, reference.peak)), 6);
  });

  it('falls back to track gain when the album is shuffled', () => {
    // Shuffling an album is listening to songs, not to a record.
    const siblings = [track('a', -8, -1), track('b', -20, -6)];
    const level = levelFor(siblings[1], {
      ...ctx, shuffle: true, siblings, contextKind: 'album', contextId: 'album:1',
    });
    expect(level).toBeCloseTo(gainToLinear(levelGainDb(-20, -6)), 6);
  });

  it('falls back to track gain when the album is only part-measured', () => {
    const siblings = [track('a', -8, -1), track('b', -20, -6), track('c'), track('d')];
    const level = levelFor(siblings[1], {
      ...ctx, siblings, contextKind: 'album', contextId: 'album:1',
    });
    expect(level).toBeCloseTo(gainToLinear(levelGainDb(-20, -6)), 6);
  });

  it('falls back to track gain outside an album context', () => {
    const siblings = [track('a', -8, -1), track('b', -20, -6)];
    const level = levelFor(siblings[1], {
      ...ctx, siblings, contextKind: 'playlist', contextId: 'playlist:1',
    });
    expect(level).toBeCloseTo(gainToLinear(levelGainDb(-20, -6)), 6);
  });

  it('always returns something audible', () => {
    for (let lufs = -70; lufs <= 5; lufs += 1) {
      const level = levelFor(track('a', lufs, -1), ctx);
      expect(level).toBeGreaterThanOrEqual(MIN_LINEAR);
      expect(level).toBeLessThanOrEqual(MAX_LINEAR);
    }
  });
});

describe('constants', () => {
  it('targets the streaming standard', () => {
    expect(TARGET_LUFS).toBe(-14);
    expect(PEAK_CEILING_DBTP).toBe(-1);
  });
});
