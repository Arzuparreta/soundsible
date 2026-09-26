import { describe, expect, it } from 'vitest';
import { libraryTrackFor, queueIndexOf, resultToTrack } from './queueDiscovery';
import type { SearchResult, Track } from '../types/music';

const libTrack: Track = { id: 'lib1', title: 'Downloaded Song', artist: 'Someone', youtube_id: 'yt111yt111y' };
const previewTwin: Track = { id: 'yt111yt111y', title: 'Downloaded Song', artist: 'Chan', source: 'preview' };
const other: Track = { id: 'lib2', title: 'Other', artist: 'Someone' };

describe('queueIndexOf', () => {
  it('matches by plain id', () => {
    expect(queueIndexOf([other, libTrack], libTrack)).toBe(1);
  });

  it('matches a preview track against its library twin and vice versa', () => {
    expect(queueIndexOf([libTrack], previewTwin)).toBe(0);
    expect(queueIndexOf([previewTwin], libTrack)).toBe(0);
  });

  it('returns -1 when absent', () => {
    expect(queueIndexOf([other], previewTwin)).toBe(-1);
  });
});

describe('resultToTrack / libraryTrackFor', () => {
  const result: SearchResult = { id: 'yt111yt111y', title: 'Downloaded Song', channel: 'Chan', duration: 200, thumbnail: 'x.jpg' };

  it('maps an online result onto a preview track', () => {
    expect(resultToTrack(result)).toEqual({
      id: 'yt111yt111y',
      title: 'Downloaded Song',
      artist: 'Chan',
      artist_is_channel: true,
      duration: 200,
      cover: 'x.jpg',
      source: 'preview',
    });
  });

  it('credits the performer the server read, keeping bare channels as channels', () => {
    const read = { ...result, title: 'La vereda', channel: 'Extremoduro (Oficial)', artist: 'Extremoduro', artist_is_channel: false };
    expect(resultToTrack(read)).toMatchObject({ artist: 'Extremoduro', artist_is_channel: false });
    const bare = { ...result, channel: 'Music Mirror', artist: 'Music Mirror', artist_is_channel: true };
    expect(resultToTrack(bare)).toMatchObject({ artist: 'Music Mirror', artist_is_channel: true });
    // Cached before the server read performers: artist was the channel, with no flag.
    const cached = { ...result, artist: 'Chan' };
    expect(resultToTrack(cached)).toMatchObject({ artist: 'Chan', artist_is_channel: true });
  });

  it('finds the downloaded twin of an online result', () => {
    expect(libraryTrackFor([other, libTrack], result)?.id).toBe('lib1');
    expect(libraryTrackFor([other], result)).toBeNull();
  });
});
