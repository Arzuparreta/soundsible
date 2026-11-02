import { describe, expect, it } from 'vitest';
import { queueIndexOf, resultCredit } from './queueDiscovery';
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

describe('resultCredit', () => {
  const result: SearchResult = { id: 'yt111yt111y', title: 'Downloaded Song', channel: 'Chan', duration: 200, thumbnail: 'x.jpg' };

  it('credits the channel when the performer is unknown', () => {
    expect(resultCredit(result)).toEqual({ artist: 'Chan', artist_is_channel: true });
  });

  it('credits the performer the server read, keeping bare channels as channels', () => {
    const read = { ...result, title: 'La vereda', channel: 'Extremoduro (Oficial)', artist: 'Extremoduro', artist_is_channel: false };
    expect(resultCredit(read)).toEqual({ artist: 'Extremoduro', artist_is_channel: false });
    const bare = { ...result, channel: 'Music Mirror', artist: 'Music Mirror', artist_is_channel: true };
    expect(resultCredit(bare)).toEqual({ artist: 'Music Mirror', artist_is_channel: true });
    // Cached before the server read performers: artist was the channel, with no flag.
    const cached = { ...result, artist: 'Chan' };
    expect(resultCredit(cached)).toEqual({ artist: 'Chan', artist_is_channel: true });
  });
});
