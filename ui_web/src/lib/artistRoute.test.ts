import { describe, it, expect } from 'vitest';
import { artistPath, decodeArtistName, artistKey } from './artistRoute';

describe('artistPath / decodeArtistName round-trip', () => {
  it('preserves spaces and Unicode through encode -> decode', () => {
    for (const name of ['Extremoduro', 'System Of A Down', 'Sigur Rós', 'Café Tacvba', '坂本龍一']) {
      expect(decodeArtistName(artistPath(name).replace('/artist/', ''))).toBe(name);
    }
  });

  it('encodes the segment (slashes and spaces do not leak into the path)', () => {
    const path = artistPath('AC/DC');
    expect(path).toBe('/artist/AC%2FDC');
    expect(decodeArtistName('AC%2FDC')).toBe('AC/DC');
  });

  it('falls back to raw text on a malformed percent-escape instead of throwing', () => {
    expect(() => decodeArtistName('%E0%A4%A')).not.toThrow();
    expect(decodeArtistName('%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('returns empty string for an undefined segment', () => {
    expect(decodeArtistName(undefined)).toBe('');
  });
});

describe('artistKey', () => {
  it('is case- and whitespace-insensitive', () => {
    expect(artistKey('  Extremoduro ')).toBe(artistKey('extremoduro'));
  });

  it('normalizes equivalent Unicode spellings (NFKC)', () => {
    // Precomposed "o-acute" (U+00F3) vs decomposed "o" + combining acute
    // (U+006F U+0301) must collapse to one key, so both spellings of the same
    // name route to the same artist.
    const precomposed = 'Rós';
    const decomposed = 'Rós';
    expect(precomposed).not.toBe(decomposed);
    expect(artistKey(precomposed)).toBe(artistKey(decomposed));
  });

  it('treats null/undefined as an empty key', () => {
    expect(artistKey(null)).toBe('');
    expect(artistKey(undefined)).toBe('');
  });
});
