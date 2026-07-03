import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';

const apiMock = vi.hoisted(() => ({
  prefetchPreviews: vi.fn(() => Promise.resolve({ status: 'queued' })),
}));
vi.mock('./api', () => ({ api: apiMock }));

import { prefetchPreviews, upcomingPreviewIds } from './prefetch';

const preview = (id: string): Track => ({ id, title: id, artist: 'A', source: 'preview' });
const local = (id: string): Track => ({ id, title: id, artist: 'A' });
const podcast = (id: string): Track => ({
  id,
  title: id,
  artist: 'A',
  source: 'preview',
  podcast_episode_guid: id,
});

describe('upcomingPreviewIds', () => {
  it('collects the next previews in linear order, skipping local tracks and podcasts', () => {
    const queue = [local('l1'), podcast('p0'), preview('v1'), local('l2'), preview('v2'), preview('v3')];
    expect(upcomingPreviewIds(queue, 0, false)).toEqual(['v1', 'v2']);
  });

  it('stops at the end of the queue unless repeat-all wraps around', () => {
    const queue = [preview('v1'), local('l1'), preview('v2')];
    expect(upcomingPreviewIds(queue, 2, false)).toEqual([]);
    expect(upcomingPreviewIds(queue, 2, true)).toEqual(['v1']);
  });

  it('handles an empty queue', () => {
    expect(upcomingPreviewIds([], 0, true)).toEqual([]);
  });
});

describe('prefetchPreviews', () => {
  beforeEach(() => {
    apiMock.prefetchPreviews.mockClear();
  });

  it('drops non-YouTube ids and dedupes recently warmed ids', () => {
    prefetchPreviews(['AbC123-_xyz', 'not an id', 'pcast_guid']);
    expect(apiMock.prefetchPreviews).toHaveBeenCalledTimes(1);
    expect(apiMock.prefetchPreviews).toHaveBeenCalledWith(['AbC123-_xyz'], false);

    apiMock.prefetchPreviews.mockClear();
    prefetchPreviews(['AbC123-_xyz']); // still warm → skipped entirely
    expect(apiMock.prefetchPreviews).not.toHaveBeenCalled();
  });

  it('lets download requests through even for warm ids (server dedupes on disk)', () => {
    prefetchPreviews(['zzz123-_AAA']);
    apiMock.prefetchPreviews.mockClear();
    prefetchPreviews(['zzz123-_AAA'], { download: true });
    expect(apiMock.prefetchPreviews).toHaveBeenCalledWith(['zzz123-_AAA'], true);
  });

  it('never sends an empty batch', () => {
    prefetchPreviews(['nope']);
    expect(apiMock.prefetchPreviews).not.toHaveBeenCalled();
  });
});
