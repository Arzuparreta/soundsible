import { describe, it, expect } from 'vitest';
import { artistPath, albumPath, parseViewParams, decodeArtistName, artistKey, resolveViewMode } from './artistRoute';

describe('artistPath / decodeArtistName round-trip', () => {
  it('preserves spaces and Unicode through encode -> decode', () => {
    for (const name of ['Extremoduro', 'System Of A Down', 'Sigur Rós', 'Café Tacvba', '坂本龍一']) {
      const seg = artistPath(name).replace('/artist/', '').split('?')[0];
      expect(decodeArtistName(seg)).toBe(name);
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

describe('artistPath with opts', () => {
  it('appends view query param', () => {
    const path = artistPath('Oliver Heldens', { view: 'library' });
    expect(path).toContain('view=library');
    expect(path).toContain('Oliver%20Heldens');
  });

  it('appends deezer_id query param', () => {
    const path = artistPath('Oliver Heldens', { deezerId: '27' });
    expect(path).toContain('deezer_id=27');
  });

  it('appends both view and deezer_id', () => {
    const path = artistPath('Oliver Heldens', { view: 'discover', deezerId: '27' });
    expect(path).toContain('view=discover');
    expect(path).toContain('deezer_id=27');
  });

  it('omits query string when no opts', () => {
    const path = artistPath('Oliver Heldens');
    expect(path).toBe('/artist/Oliver%20Heldens');
  });
});

describe('albumPath', () => {
  it('builds album route with artist param', () => {
    const path = albumPath('Heldeep', 'Oliver Heldens');
    expect(path).toContain('/album/Heldeep');
    expect(path).toContain('artist=Oliver+Heldens');
  });

  it('includes view and deezer_id', () => {
    const path = albumPath('Heldeep', 'Oliver Heldens', { view: 'discover', deezerId: '201' });
    expect(path).toContain('view=discover');
    expect(path).toContain('deezer_id=201');
  });
});

describe('parseViewParams', () => {
  it('defaults to discover when no view param', () => {
    expect(parseViewParams({}).view).toBe('discover');
  });

  it('returns library when view=library', () => {
    expect(parseViewParams({ view: 'library' }).view).toBe('library');
  });

  it('returns discover when view=discover', () => {
    expect(parseViewParams({ view: 'discover' }).view).toBe('discover');
  });

  it('falls back to discover for unknown values', () => {
    expect(parseViewParams({ view: 'bogus' }).view).toBe('discover');
  });

  it('extracts deezer_id', () => {
    expect(parseViewParams({ deezer_id: '27' }).deezerId).toBe('27');
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
    const precomposed = 'R\u00F3s';
    const decomposed = 'Ro\u0301s';
    expect(precomposed).not.toBe(decomposed);
    expect(artistKey(precomposed)).toBe(artistKey(decomposed));
  });

  it('treats null/undefined as an empty key', () => {
    expect(artistKey(null)).toBe('');
    expect(artistKey(undefined)).toBe('');
  });
});

describe('resolveViewMode', () => {
  it('follows the URL when the toggle is available', () => {
    expect(resolveViewMode({ urlView: 'library', override: null, canToggle: true })).toBe('library');
    expect(resolveViewMode({ urlView: 'discover', override: null, canToggle: true })).toBe('discover');
  });

  it('lets an explicit tap win over the URL', () => {
    expect(resolveViewMode({ urlView: 'discover', override: 'library', canToggle: true })).toBe('library');
    expect(resolveViewMode({ urlView: 'library', override: 'discover', canToggle: true })).toBe('discover');
  });

  it('forces discover when no toggle is offered, whatever was asked for', () => {
    // Without this clamp a `library` tab carried onto an artist the user does
    // not own renders an empty list with no visible control to escape it.
    expect(resolveViewMode({ urlView: 'library', override: null, canToggle: false })).toBe('discover');
    expect(resolveViewMode({ urlView: 'library', override: 'library', canToggle: false })).toBe('discover');
  });
});
