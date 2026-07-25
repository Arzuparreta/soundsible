import { describe, it, expect } from 'vitest';
import { clockTime, formatDuration, trackCount } from './format';

describe('trackCount', () => {
  // Regression: track-count labels read "1 pistas" across Library, Favourites,
  // Artist, Playlists. Found by /qa on 2026-06-22. (Updated to English default
  // after i18n: see src/lib/i18n.)
  it('uses the singular for exactly one track', () => {
    expect(trackCount(1)).toBe('1 track');
  });

  it('uses the plural for zero and for many', () => {
    expect(trackCount(0)).toBe('0 tracks');
    expect(trackCount(2)).toBe('2 tracks');
    expect(trackCount(125)).toBe('125 tracks');
  });
});

describe('formatDuration', () => {
  it('pads seconds to two digits', () => {
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3600)).toBe('60:00');
  });

  it('renders nothing when there is no length to show', () => {
    // List columns: a placeholder would be noise, so an unknown length is blank.
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
    expect(formatDuration(Infinity)).toBe('');
  });
});

describe('clockTime', () => {
  it('always renders a readout, clamping the unknown to zero', () => {
    // A transport that blanks out mid-track reads as broken.
    expect(clockTime(0)).toBe('0:00');
    expect(clockTime(-5)).toBe('0:00');
    expect(clockTime(Number.NaN)).toBe('0:00');
    expect(clockTime(125.9)).toBe('2:05');
  });
});
