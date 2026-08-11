import { describe, expect, it } from 'vitest';
import { normalizeLibraryQuery, searchLibrary } from './librarySearch';
import type { Track } from '../types/music';

const tracks: Track[] = [
  { id: '1', title: 'Corazón partío', artist: 'Alejandro Sanz', album: 'Más' },
  { id: '2', title: 'Más', artist: 'Kiko Veneno', album: 'Échate un cantecito' },
  { id: '3', title: 'Tu calorro', artist: 'Estopa', album: 'Estopa' },
];
const artists = [
  { id: 'ar-1', name: 'Alejandro Sanz', count: 1, coverId: '1' },
  { id: 'ar-3', name: 'Estopa', count: 1, coverId: '3' },
];

describe('library search', () => {
  it('normalizes accents, whitespace and case', () => {
    expect(normalizeLibraryQuery('  CORAZÓN   ')).toBe('corazon');
  });

  it('mixes tracks and artists, ranking exact and prefix matches first', () => {
    const results = searchLibrary(tracks, artists, 'mas');
    expect(results.map((result) => result.kind === 'track' ? result.track.title : result.artist.name))
      .toEqual(['Más', 'Corazón partío']);
  });

  it('matches artist and album fields without duplicating an item', () => {
    const results = searchLibrary(tracks, artists, 'estopa');
    expect(results.map((result) => result.kind)).toEqual(['artist', 'track']);
    expect(results.filter((result) => result.kind === 'track')).toHaveLength(1);
  });

  it('returns nothing for an empty query', () => {
    expect(searchLibrary(tracks, artists, '   ')).toEqual([]);
  });
});
