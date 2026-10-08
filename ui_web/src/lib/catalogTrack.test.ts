import { describe, expect, it } from 'vitest';
import type { CatalogItem, Track } from '../types/music';
import { catalogReleaseEvidence, catalogTrack, withRecord } from './catalogTrack';

const row = (extra: Partial<CatalogItem>): CatalogItem => ({ id: 'catalog:track', source: 'deezer', type: 'track', title: 'Song', artist: 'Artist', ...extra });
describe('catalog tracks shared by web and native programs', () => {
  it('keeps an owned recording and recommendation without replacing its identity', () => {
    const track = { id: 'owned', title: 'Recording', artist: 'Artist', duration: 120 } as Track;
    expect(catalogTrack(row({ track_id: 'owned' }), [track])).toBe(track);
    const recommendation: NonNullable<Track['recommendation']> = { identity: 'fixture', source: 'discover' };
    expect(catalogTrack(row({ track_id: 'owned', raw: { recommendation } }), [track])).toEqual({ ...track, recommendation });
  });
  it('preserves exact provider identity and credited metadata for a preview', () => {
    const track = catalogTrack(row({ source: 'youtube', raw: { id: 'A1111111111', title: 'Video song', artist: 'Performer', artist_is_channel: false }, external_ids: { isrc: 'ES-ABC-12-34567' } }), []);
    expect(track).toMatchObject({ source: 'preview', id: 'A1111111111', title: 'Video song', artist: 'Performer', artist_is_channel: false });
    expect(track?.originKeys).toContain('yt:A1111111111');
  });
  it('requires resolution when a recording has no owned or provider identity', () => {
    expect(catalogTrack(row({}), [])).toBeNull();
    expect(catalogTrack(row({ source: 'deezer', raw: { id: 'A1111111111' } }), [])).toBeNull();
  });
});

describe('catalogReleaseEvidence', () => {
  const row = { id: 'deezer:track:1', source: 'deezer', type: 'track', title: 'Song', artist: 'Artist' } as const;
  it('names the record a row was listed from, and its place on it', () => {
    expect(catalogReleaseEvidence({ ...row, album: 'Discovery', raw: { album_artist: 'Daft Punk', track_number: 3, disc_number: 1, year: 2001 } }))
      .toEqual({ album: 'Discovery', album_artist: 'Daft Punk', track_number: 3, disc_number: 1, year: 2001 });
  });
  it('sends nothing without an album, and makes nothing up', () => {
    expect(catalogReleaseEvidence({ ...row, raw: { track_number: 3 } })).toEqual({});
    expect(catalogReleaseEvidence({ ...row, album: 'Single', raw: {} })).toEqual({ album: 'Single' });
  });
});

it('never mixes two records on one stream', () => {
  const saved = { id: 'A1111111111', title: 'Song', artist: 'Artist', source: 'preview', album: 'Album', album_artist: 'Artist', track_number: 4, year: 2011 } as Track;
  // The same album fills in what is missing.
  expect(withRecord(saved, { album: 'album', disc_number: 1 })).toMatchObject({ album: 'Album', track_number: 4, disc_number: 1, year: 2011 });
  // Another album that places the song replaces the record whole.
  const single = withRecord(saved, { album: 'Song (Single)', track_number: 1 });
  expect(single).toMatchObject({ album: 'Song (Single)', track_number: 1 });
  expect([single.album_artist, single.year]).toEqual([undefined, undefined]);
  // Another album named and nothing else is too little to overrule.
  expect(withRecord(saved, { album: 'Song (Single)', year: 2010 })).toBe(saved);
  // No album named, nothing changes; a stream with no album takes any.
  expect(withRecord(saved, {})).toBe(saved);
  expect(withRecord({ ...saved, album: undefined, track_number: undefined }, { album: 'Album', year: 2011 })).toMatchObject({ album: 'Album', year: 2011 });
});
