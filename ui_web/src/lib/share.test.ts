import { describe, it, expect } from 'vitest';
import { shareUrlFor } from './share';

describe('shareUrlFor', () => {
  it('uses the explicit youtube_id for library tracks', () => {
    expect(shareUrlFor({ id: 'lib-1', title: 'Song', youtube_id: 'abc123' })).toBe(
      'https://www.youtube.com/watch?v=abc123',
    );
  });

  it('uses the id as the video id for preview (Discover/Search) tracks', () => {
    expect(shareUrlFor({ id: 'yt-xyz', title: 'Song', source: 'preview' })).toBe(
      'https://www.youtube.com/watch?v=yt-xyz',
    );
  });

  it('shares the exact id used by preview playback when youtube_id disagrees', () => {
    expect(
      shareUrlFor({
        id: 'playing-id',
        title: 'Song',
        source: 'preview',
        youtube_id: 'stale-catalog-id',
      }),
    ).toBe('https://www.youtube.com/watch?v=playing-id');
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
