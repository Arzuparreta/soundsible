import { describe, expect, it } from 'vitest';
import { coverBackground, coverGradient, coverStyle, neutralCoverStyle, NEUTRAL_COVER } from './cover';

describe('cover placeholders', () => {
  it('gives the same seed the same gradient every time', () => {
    expect(coverGradient('track-1')).toBe(coverGradient('track-1'));
    expect(coverGradient('track-1')).not.toBe(coverGradient('track-2'));
  });

  it('layers the cover over the gradient so a 404 degrades instead of breaking', () => {
    const bg = coverBackground('t1', 'https://example.test/a.jpg');
    expect(bg).toContain('url("https://example.test/a.jpg") center / cover no-repeat');
    expect(bg).toContain(coverGradient('t1'));
  });

  it('falls back to the bare gradient with no cover', () => {
    expect(coverBackground('t1')).toBe(coverGradient('t1'));
    expect(coverBackground('t1', null)).toBe(coverGradient('t1'));
    expect(coverBackground('t1', '')).toBe(coverGradient('t1'));
  });

  it('returns an inline style object for JSX call sites', () => {
    expect(coverStyle('t1', 'x.jpg')).toEqual({ background: coverBackground('t1', 'x.jpg') });
  });

  it('uses surface tokens for non-track artwork', () => {
    expect(neutralCoverStyle()).toEqual({ background: NEUTRAL_COVER });
    expect(neutralCoverStyle('s.jpg').background).toContain(NEUTRAL_COVER);
  });
});
