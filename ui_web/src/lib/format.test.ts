import { describe, it, expect } from 'vitest';
import { trackCount } from './format';

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
