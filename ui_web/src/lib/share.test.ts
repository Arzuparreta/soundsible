import { describe, it, expect } from 'vitest';
import { shareUrlFor } from './share';

describe('shareUrlFor', () => {
  it('uses the explicit youtube_id for library tracks', () => {
    expect(
      shareUrlFor({ id: 'lib-1', title: 'Song', artist: 'Artist', youtube_id: 'dQw4w9WgXcQ' }),
    ).toMatch(/\/open\/#t=/);
  });

  it('uses the id as the video id for preview (Discover/Search) tracks', () => {
    expect(
      shareUrlFor({ id: '9bZkp7q19f0', title: 'Song', artist: 'Artist', source: 'preview' }),
    ).toMatch(/\/open\/#t=/);
  });

  it('shares the exact id used by preview playback when youtube_id disagrees', () => {
    const url = shareUrlFor({
      id: 'dQw4w9WgXcQ',
      title: 'Song',
      artist: 'Artist',
      source: 'preview',
      youtube_id: '9bZkp7q19f0',
    });
    expect(url).toMatch(/\/open\/#t=/);
  });

  it('returns no url for podcast episodes (id is a guid, not a video)', () => {
    expect(
      shareUrlFor({ id: 'ep-guid', title: 'Episode', source: 'preview', media_kind: 'podcast_episode', podcast_episode_guid: 'ep-guid' }),
    ).toBe('');
  });

  it('returns no url for a library track without a youtube_id', () => {
    expect(shareUrlFor({ id: 'lib-2', title: 'Song' })).toBe('');
  });
});
