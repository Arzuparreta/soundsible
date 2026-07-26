import { describe, expect, it } from 'vitest';
import {
  capsuleForTrack,
  decodeTrackCapsule,
  encodeTrackCapsule,
  shareUrlForTrack,
} from './trackShare';

describe('Soundsible track capsules', () => {
  it('round-trips Unicode metadata without changing the video identity', () => {
    const capsule = {
      v: 1 as const,
      kind: 'music' as const,
      yt: 'dQw4w9WgXcQ',
      title: 'Canción del año',
      artist: 'Björk',
      album: 'Álbum 日本',
      duration: 213,
    };
    expect(decodeTrackCapsule(encodeTrackCapsule(capsule))).toEqual(capsule);
  });

  it('uses the exact preview id and not stale metadata', () => {
    expect(
      capsuleForTrack({
        id: 'dQw4w9WgXcQ',
        title: 'Song',
        artist: 'Artist',
        source: 'preview',
        youtube_id: '9bZkp7q19f0',
      })?.yt,
    ).toBe('dQw4w9WgXcQ');
  });

  it('creates a fragment-only bridge URL', () => {
    const url = shareUrlForTrack({
      id: 'library-id',
      title: 'Song',
      artist: 'Artist',
      youtube_id: 'dQw4w9WgXcQ',
    });
    expect(url).toMatch(/\/open\/#t=[A-Za-z0-9_-]+$/);
    expect(new URL(url!).search).toBe('');
  });

  it('rejects podcasts, missing identities, malformed data and unknown fields', () => {
    expect(
      capsuleForTrack({
        id: 'episode-guid',
        title: 'Episode',
        artist: 'Show',
        media_kind: 'podcast_episode',
        podcast_episode_guid: 'episode-guid',
      }),
    ).toBeNull();
    expect(capsuleForTrack({ id: 'local', title: 'Song', artist: 'Artist' })).toBeNull();
    expect(decodeTrackCapsule('not+base64')).toBeNull();

    const unknown = btoa(
      JSON.stringify({
        v: 1,
        kind: 'music',
        yt: 'dQw4w9WgXcQ',
        title: 'Song',
        artist: 'Artist',
        sender: 'secret',
      }),
    ).replace(/=+$/, '');
    expect(decodeTrackCapsule(unknown)).toBeNull();
  });
});
