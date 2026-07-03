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
      duration: 200,
      cover: 'x.jpg',
      source: 'preview',
    });
  });

  it('finds the downloaded twin of an online result', () => {
    expect(libraryTrackFor([other, libTrack], result)?.id).toBe('lib1');
    expect(libraryTrackFor([other], result)).toBeNull();
  });
});
