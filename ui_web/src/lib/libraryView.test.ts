import { describe, it, expect } from 'vitest';
import { sortTracks, catalogArtists } from './libraryView';
import type { CatalogArtist, Track } from '../types/music';

const t = (id: string, over: Partial<Track> = {}): Track => ({
  id,
  title: id,
  artist: 'A',
  ...over,
});

describe('sortTracks', () => {
  const tracks = [t('1', { title: 'Banana' }), t('2', { title: 'apple' }), t('3', { title: 'Cherry' })];

  it("'recent' keeps the order the library was merged in, without mutating input", () => {
    // `musicLibrary()` has already interleaved files and saved songs by date;
    // re-deciding it here would be a second answer to the same question.
    const out = sortTracks(tracks, 'recent', new Set());
    expect(out.map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(out).not.toBe(tracks); // a copy, so callers can sort it further
  });

  it("'az' and 'fav' fall back to recency, not to some other order", () => {
    const dated = [
      t('older', { title: 'Same', added_at: '2026-07-01T00:00:00' }),
      t('newer', { title: 'Same', added_at: '2026-08-01T00:00:00' }),
    ];
    // Already newest-first when it arrives; a stable sort keeps it that way.
    const recent = sortTracks(dated.slice().reverse(), 'az', new Set());
    expect(recent.map((x) => x.id)).toEqual(['newer', 'older']);
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

describe('catalogArtists', () => {
  const row = (over: Partial<CatalogArtist> = {}): CatalogArtist => ({
    id: 'ar-1',
    name: 'Artist',
    track_count: 1,
    album_count: 1,
    cover_track_id: 't1',
    ...over,
  });

  it('carries the engine id through, so a card can ask whose songs these are', () => {
    const [entry] = catalogArtists([row({ id: 'ar-bjork', name: 'Björk', track_count: 4 })]);
    expect(entry).toEqual({ id: 'ar-bjork', name: 'Björk', count: 4, coverId: 't1' });
  });

  it('sorts in the reader’s alphabet, not by code point', () => {
    // SQLite's own ORDER BY files "Ángeles" after "Zappa"; nobody reads that way.
    const out = catalogArtists([
      row({ id: 'z', name: 'Zappa' }),
      row({ id: 'a', name: 'Ángeles del Infierno' }),
      row({ id: 'b', name: 'ABBA' }),
    ]);
    expect(out.map((a) => a.name)).toEqual(['ABBA', 'Ángeles del Infierno', 'Zappa']);
  });

  it('names an artist the engine could not name', () => {
    const [entry] = catalogArtists([row({ name: '' })]);
    expect(entry.name).toBe('Unknown');
  });

  it('leaves the cover empty rather than inventing one', () => {
    const [entry] = catalogArtists([row({ cover_track_id: null })]);
    expect(entry.coverId).toBe('');
  });
});
