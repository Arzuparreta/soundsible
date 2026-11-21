import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDiscoveryMusicFeed: vi.fn(),
  currentUserKey: 'u1',
}));

vi.mock('./api', () => ({
  api: {
    getDiscoveryMusicFeed: mocks.getDiscoveryMusicFeed,
  },
}));

vi.mock('./session', () => ({
  userKey: (suffix: string) => `${mocks.currentUserKey}:${suffix}`,
}));

import { dispatchDiscoveryFeedReady } from './discoveryEvents';
import { clearSearchCache } from './searchCache';
import {
  discoveryBrowseSections,
  discoveryExploreItems,
  discoveryFeed,
  discoveryLoading,
  discoveryRefreshing,
  discoveryTrackShelves,
  dismissDiscoveryItem,
  ensureDiscoveryFeed,
  refreshDiscoveryFeed,
  resetDiscoveryFeed,
  restoreDiscoveryItem,
  retainDiscoveryFeed,
} from './discoveryFeedStore';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('discoveryFeedStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    mocks.currentUserKey = 'u1';
    mocks.getDiscoveryMusicFeed.mockReset();
    clearSearchCache();
    resetDiscoveryFeed();
  });

  afterEach(() => {
    resetDiscoveryFeed();
    vi.useRealTimers();
  });

  it('fetches once and shares cached sections and Explore items across callers', async () => {
    mocks.getDiscoveryMusicFeed.mockResolvedValueOnce({
      sections: [
        { id: 'more_like_a', title: 'More like A', item_ids: ['deezer:1', 'deezer:2', 'local:1'] },
        { id: 'more_like_b', title: 'More like B', item_ids: ['youtube:yt1', 'deezer:2'] },
      ],
      browse_sections: [
        { id: 'discover_artists', title: 'Artists', kind: 'artists', items: [{ id: 'ar:1', type: 'artist', title: 'Band A' }] },
      ],
      items: [
        { id: 'deezer:1', type: 'track', source: 'deezer', title: 'First', artist: 'Artist 1' },
        { id: 'deezer:2', type: 'track', source: 'deezer', title: 'Second', artist: 'Artist 2' },
        { id: 'youtube:yt1', type: 'track', source: 'youtube', title: 'Third', artist: 'Artist 3' },
        { id: 'local:1', type: 'library_track', source: 'library', title: 'Local Song', artist: 'Artist 4', track_id: 't1' },
      ],
    });

    ensureDiscoveryFeed();
    ensureDiscoveryFeed();
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(discoveryLoading()).toBe(false));

    expect(mocks.getDiscoveryMusicFeed).toHaveBeenCalledTimes(1);
    expect(mocks.getDiscoveryMusicFeed).toHaveBeenCalledWith(expect.any(AbortSignal), false);
    expect(discoveryBrowseSections().map((s) => s.id)).toEqual(['discover_artists']);
    expect(discoveryTrackShelves().map((s) => s.id)).toEqual(['more_like_a', 'more_like_b']);
    // Round-robin external-first order, deduplicated across shelves, library fallback appended.
    expect(discoveryExploreItems().map((item) => item.id)).toEqual([
      'deezer:1',
      'youtube:yt1',
      'deezer:2',
      'local:1',
    ]);
    expect(discoveryFeed().sections).toHaveLength(2);
  });

  it('reloads on discovery_feed_ready push events and supports refresh=1', async () => {
    mocks.getDiscoveryMusicFeed
      .mockResolvedValueOnce({
        revalidating: true,
        sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:1'] }],
        items: [{ id: 'deezer:1', type: 'track', source: 'deezer', title: 'Warm', artist: 'A' }],
      })
      .mockResolvedValueOnce({
        revalidating: false,
        sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:2'] }],
        items: [{ id: 'deezer:2', type: 'track', source: 'deezer', title: 'Fresh', artist: 'B' }],
      })
      .mockResolvedValueOnce({
        revalidating: false,
        sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:3'] }],
        items: [{ id: 'deezer:3', type: 'track', source: 'deezer', title: 'Rotated', artist: 'C' }],
      });

    ensureDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:1']));
    expect(discoveryRefreshing()).toBe(true);

    dispatchDiscoveryFeedReady({ limit: 10 });
    await vi.waitFor(() => expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:2']));
    expect(discoveryRefreshing()).toBe(false);

    refreshDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:3']));
    expect(mocks.getDiscoveryMusicFeed).toHaveBeenNthCalledWith(3, expect.any(AbortSignal), true);
  });

  it('synchronizes dismiss and restore across track shelves and Explore items', async () => {
    mocks.getDiscoveryMusicFeed.mockResolvedValueOnce({
      sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:1', 'deezer:2'] }],
      items: [
        { id: 'deezer:1', type: 'track', source: 'deezer', title: 'One', artist: 'A' },
        { id: 'deezer:2', type: 'track', source: 'deezer', title: 'Two', artist: 'B' },
      ],
    });

    ensureDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:1', 'deezer:2']));

    dismissDiscoveryItem('deezer:1');
    expect(discoveryTrackShelves()[0].items.map((i) => i.id)).toEqual(['deezer:2']);
    expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:2']);

    restoreDiscoveryItem('deezer:1');
    expect(discoveryTrackShelves()[0].items.map((i) => i.id)).toEqual(['deezer:1', 'deezer:2']);
    expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:1', 'deezer:2']);

    vi.useRealTimers();
    await flush();
  });

  it('re-hydrates cleanly when the active user key changes', async () => {
    mocks.getDiscoveryMusicFeed
      .mockResolvedValueOnce({
        sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:u1'] }],
        items: [{ id: 'deezer:u1', type: 'track', source: 'deezer', title: 'User 1', artist: 'A' }],
      })
      .mockResolvedValueOnce({
        sections: [{ id: 's2', title: 'S2', item_ids: ['deezer:u2'] }],
        items: [{ id: 'deezer:u2', type: 'track', source: 'deezer', title: 'User 2', artist: 'B' }],
      });

    ensureDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:u1']));

    mocks.currentUserKey = 'u2';
    ensureDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:u2']));
    expect(mocks.getDiscoveryMusicFeed).toHaveBeenCalledTimes(2);
  });

  it('refcounts retainDiscoveryFeed consumers and aborts polling/fetches when none remain', async () => {
    mocks.getDiscoveryMusicFeed.mockResolvedValue({
      revalidating: true,
      sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:1'] }],
      items: [{ id: 'deezer:1', type: 'track', source: 'deezer', title: 'Retained', artist: 'A' }],
    });

    const releaseOne = retainDiscoveryFeed();
    const releaseTwo = retainDiscoveryFeed();
    await vi.waitFor(() => expect(mocks.getDiscoveryMusicFeed).toHaveBeenCalledTimes(1));

    // Releasing one consumer keeps the timer and push reload active.
    releaseOne();
    dispatchDiscoveryFeedReady({ limit: 10 });
    await vi.waitFor(() => expect(mocks.getDiscoveryMusicFeed).toHaveBeenCalledTimes(2));

    // Releasing the final consumer aborts the latest signal, stops fallback polling, and clears cache on push.
    const latestSignal = mocks.getDiscoveryMusicFeed.mock.calls[1][0] as AbortSignal;
    releaseTwo();
    expect(latestSignal.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    dispatchDiscoveryFeedReady({ limit: 10 });
    expect(mocks.getDiscoveryMusicFeed).toHaveBeenCalledTimes(2);
  });
});
