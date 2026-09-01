import { describe, expect, it } from 'vitest';
import { gainToVolumePosition, nudgeVolumeGain, volumePositionToGain } from './volumeScale';

describe('perceptual volume scale', () => {
  it('keeps silence and unity gain as exact endpoints', () => {
    expect(volumePositionToGain(0)).toBe(0);
    expect(volumePositionToGain(1)).toBe(1);
    expect(gainToVolumePosition(0)).toBe(0);
    expect(gainToVolumePosition(1)).toBe(1);
  });

  it('uses an audio taper with 10% gain at half travel', () => {
    expect(volumePositionToGain(0.5)).toBeCloseTo(0.1, 10);
  });

  it.each([0, 0.001, 0.01, 0.1, 0.35, 0.8, 1])(
    'round-trips the existing linear gain %s',
    (gain) => {
      expect(volumePositionToGain(gainToVolumePosition(gain))).toBeCloseTo(gain, 12);
    },
  );

  it('clamps invalid input and nudges in slider space', () => {
    expect(volumePositionToGain(-1)).toBe(0);
    expect(volumePositionToGain(2)).toBe(1);
    expect(volumePositionToGain(Number.POSITIVE_INFINITY)).toBe(1);
    expect(gainToVolumePosition(Number.NaN)).toBe(0);
    expect(nudgeVolumeGain(0.1, 0.05)).toBeCloseTo(volumePositionToGain(0.55), 12);
    expect(nudgeVolumeGain(1, 0.05)).toBe(1);
  });
});
