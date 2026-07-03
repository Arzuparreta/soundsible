import { describe, it, expect } from 'vitest';
import { sortTracks, buildArtists, buildAlbums } from './libraryView';
import type { Track } from '../types/music';

const t = (id: string, over: Partial<Track> = {}): Track => ({
  id,
  title: id,
  artist: 'A',
  ...over,
});

describe('sortTracks', () => {
  const tracks = [t('1', { title: 'Banana' }), t('2', { title: 'apple' }), t('3', { title: 'Cherry' })];

  it("'recent' reverses engine order (newest first) without mutating input", () => {
    const out = sortTracks(tracks, 'recent', new Set());
    expect(out.map((x) => x.id)).toEqual(['3', '2', '1']);
    expect(tracks.map((x) => x.id)).toEqual(['1', '2', '3']); // original untouched
  });

  it("'az' sorts by title, case-insensitively", () => {
    const out = sortTracks(tracks, 'az', new Set());
    expect(out.map((x) => x.title)).toEqual(['apple', 'Banana', 'Cherry']);
  });

  it("'fav' floats favourited tracks to the top", () => {
    const out = sortTracks(tracks, 'fav', new Set(['3']));
    expect(out[0].id).toBe('3');
  });
});

describe('buildArtists', () => {
  it('counts tracks per artist and sorts alphabetically', () => {
    const out = buildArtists([
      t('1', { artist: 'Zappa' }),
      t('2', { artist: 'ABBA' }),
      t('3', { artist: 'Zappa' }),
    ]);
    expect(out.map((a) => [a.name, a.count])).toEqual([
      ['ABBA', 1],
      ['Zappa', 2],
    ]);
  });

  it('merges case/whitespace variants of the same artist into one entry', () => {
    const out = buildArtists([t('1', { artist: 'Extremoduro' }), t('2', { artist: '  extremoduro ' })]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
  });

  it('falls back to album_artist, then to the localised "unknown" label', () => {
    const out = buildArtists([
      t('1', { artist: '', album_artist: 'VA' }),
      t('2', { artist: '', album_artist: null }),
    ]);
    const names = out.map((a) => a.name).sort();
    expect(names).toEqual(['Unknown', 'VA']);
  });
});

describe('buildAlbums', () => {
  it('groups by album in first-seen order and keeps track membership', () => {
    const out = buildAlbums([
      t('1', { album: 'II' }),
      t('2', { album: 'I' }),
      t('3', { album: 'II' }),
    ]);
    expect(out.map((al) => al.name)).toEqual(['II', 'I']); // first-seen, not sorted
    expect(out[0].tracks.map((x) => x.id)).toEqual(['1', '3']);
  });

  it('groups tracks with no album under the localised "no album" label', () => {
    const out = buildAlbums([t('1', { album: undefined }), t('2', { album: undefined })]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('No album');
    expect(out[0].tracks).toHaveLength(2);
  });
});
