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
  discoveryError,
  discoveryExploreItems,
  discoveryFeed,
  discoveryLoading,
  discoveryRefreshing,
  discoveryTrackShelves,
  dismissDiscoveryArtist,
  dismissDiscoveryItem,
  ensureDiscoveryFeed,
  refreshDiscoveryFeed,
  resetDiscoveryFeed,
  restoreDiscoveryArtist,
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

  it('hides all rows and browse cards by a dismissed artist (folding accents) and restores them on undo', async () => {
    mocks.getDiscoveryMusicFeed.mockResolvedValueOnce({
      sections: [
        { id: 's1', title: 'S1', item_ids: ['deezer:1', 'deezer:2', 'deezer:3'] },
      ],
      browse_sections: [
        {
          id: 'artists',
          items: [
            { id: 'deezer:artist:1', type: 'artist', title: 'Blue Öyster Cult', artist: 'Blue Öyster Cult' },
            { id: 'deezer:artist:2', type: 'artist', title: 'Thin Lizzy', artist: 'Thin Lizzy' },
          ],
        },
        {
          id: 'albums',
          items: [
            { id: 'deezer:album:1', type: 'album', title: 'Fire of Unknown Origin', artist: 'Blue Oyster Cult' },
          ],
        },
      ],
      items: [
        { id: 'deezer:1', type: 'track', source: 'deezer', title: 'Reaper', artist: 'Blue Öyster Cult' },
        { id: 'deezer:2', type: 'track', source: 'deezer', title: 'Burnin', artist: 'Blue Oyster Cult' },
        { id: 'deezer:3', type: 'track', source: 'deezer', title: 'Jailbreak', artist: 'Thin Lizzy' },
      ],
    });

    ensureDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:1', 'deezer:2', 'deezer:3']));

    dismissDiscoveryArtist('Blue Oyster Cult');
    expect(discoveryTrackShelves()[0].items.map((i) => i.id)).toEqual(['deezer:3']);
    expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:3']);
    expect(discoveryBrowseSections().map((s) => s.id)).toEqual(['artists']);
    expect(discoveryBrowseSections()[0].items.map((i) => i.title)).toEqual(['Thin Lizzy']);

    restoreDiscoveryArtist('Blue Öyster Cult');
    expect(discoveryTrackShelves()[0].items.map((i) => i.id)).toEqual(['deezer:1', 'deezer:2', 'deezer:3']);
    expect(discoveryBrowseSections().map((s) => s.id)).toEqual(['artists', 'albums']);

    vi.useRealTimers();
    await flush();
  });

  it('dismisses collaboration tracks by structured artists array and clears dismissedArtists on refresh and reset', async () => {
    mocks.getDiscoveryMusicFeed.mockResolvedValue({
      sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:1', 'deezer:2'] }],
      items: [
        {
          id: 'deezer:1',
          type: 'track',
          source: 'deezer',
          title: 'Get Lucky',
          artist: 'Daft Punk, Pharrell Williams',
          artists: ['Daft Punk', 'Pharrell Williams'],
        },
        { id: 'deezer:2', type: 'track', source: 'deezer', title: 'Happy', artist: 'Pharrell Williams' },
      ],
    });

    ensureDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:1', 'deezer:2']));

    dismissDiscoveryArtist('Daft Punk');
    expect(discoveryTrackShelves()[0].items.map((i) => i.id)).toEqual(['deezer:2']);

    // refreshDiscoveryFeed clears dismissedArtists so refreshed feeds show everything returned by the server.
    refreshDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryTrackShelves()[0].items.map((i) => i.id)).toEqual(['deezer:1', 'deezer:2']));

    dismissDiscoveryArtist('Daft Punk');
    expect(discoveryTrackShelves()[0].items.map((i) => i.id)).toEqual(['deezer:2']);
    resetDiscoveryFeed();
    ensureDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryTrackShelves()[0].items.map((i) => i.id)).toEqual(['deezer:1', 'deezer:2']));

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

  it('clears discoveryRefreshing when an in-flight refresh aborts on last consumer release and reloads on return', async () => {
    let resolveRefresh!: (value: unknown) => void;
    mocks.getDiscoveryMusicFeed
      .mockResolvedValueOnce({
        sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:1'] }],
        items: [{ id: 'deezer:1', type: 'track', source: 'deezer', title: 'Initial', artist: 'A' }],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      )
      .mockResolvedValueOnce({
        sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:2'] }],
        items: [{ id: 'deezer:2', type: 'track', source: 'deezer', title: 'Reloaded', artist: 'B' }],
      });

    const release = retainDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryLoading()).toBe(false));

    refreshDiscoveryFeed();
    expect(discoveryRefreshing()).toBe(true);
    const refreshSignal = mocks.getDiscoveryMusicFeed.mock.calls[1][0] as AbortSignal;

    // Aborting on navigation/unmount must stop the spinner and clear cache so
    // returning within the 60s cache window triggers a fresh load.
    release();
    expect(refreshSignal.aborted).toBe(true);
    expect(discoveryRefreshing()).toBe(false);
    resolveRefresh({});

    const releaseAgain = retainDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:2']));
    expect(mocks.getDiscoveryMusicFeed).toHaveBeenCalledTimes(3);
    releaseAgain();
  });

  it('resets revalidation attempt budget after settling and fails after 4 consecutive revalidations', async () => {
    const release = retainDiscoveryFeed();
    // Complete 5 separate settled cycles in one session: attempts must reset each time.
    for (let i = 0; i < 5; i += 1) {
      mocks.getDiscoveryMusicFeed
        .mockResolvedValueOnce({
          revalidating: true,
          generated_at: i * 10 + 1,
          sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:1'] }],
          items: [{ id: 'deezer:1', type: 'track', source: 'deezer', title: 'Stale', artist: 'A' }],
        })
        .mockResolvedValueOnce({
          revalidating: false,
          generated_at: i * 10 + 2,
          sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:1'] }],
          items: [{ id: 'deezer:1', type: 'track', source: 'deezer', title: 'Fresh', artist: 'A' }],
        });
      refreshDiscoveryFeed();
      await vi.waitFor(() => expect(discoveryRefreshing()).toBe(true));
      dispatchDiscoveryFeedReady({ limit: 10, generated_at: i * 10 + 2 });
      await vi.waitFor(() => expect(discoveryRefreshing()).toBe(false));
      expect(discoveryError()).toBe(false);
    }

    // Now exhaust MAX_REVALIDATE_ATTEMPTS (4) consecutively within one cycle.
    mocks.getDiscoveryMusicFeed.mockResolvedValue({
      revalidating: true,
      generated_at: 999,
      sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:1'] }],
      items: [{ id: 'deezer:1', type: 'track', source: 'deezer', title: 'Stuck', artist: 'A' }],
    });
    refreshDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryRefreshing()).toBe(true));
    for (let step = 0; step < 4; step += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    await vi.waitFor(() => expect(discoveryError()).toBe(true));
    expect(discoveryRefreshing()).toBe(false);
    release();
  });

  it('reloads an already-settled active feed when discovery_feed_ready carries a newer generated_at', async () => {
    mocks.getDiscoveryMusicFeed
      .mockResolvedValueOnce({
        revalidating: false,
        generated_at: 100,
        sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:1'] }],
        items: [{ id: 'deezer:1', type: 'track', source: 'deezer', title: 'Before Graph', artist: 'A' }],
      })
      .mockResolvedValueOnce({
        revalidating: false,
        generated_at: 200,
        sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:2'] }],
        items: [{ id: 'deezer:2', type: 'track', source: 'deezer', title: 'After Graph', artist: 'B' }],
      });

    const release = retainDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:1']));

    // Same timestamp is ignored when already settled.
    dispatchDiscoveryFeedReady({ limit: 10, generated_at: 100 });
    expect(mocks.getDiscoveryMusicFeed).toHaveBeenCalledTimes(1);

    // Newer server timestamp triggers reload and cache invalidation.
    dispatchDiscoveryFeedReady({ limit: 10, generated_at: 200 });
    await vi.waitFor(() => expect(discoveryExploreItems().map((i) => i.id)).toEqual(['deezer:2']));
    expect(mocks.getDiscoveryMusicFeed).toHaveBeenCalledTimes(2);
    release();
  });

  it('ignores stale release callbacks after resetDiscoveryFeed and invalidates cache on restore', async () => {
    mocks.getDiscoveryMusicFeed.mockResolvedValue({
      sections: [{ id: 's1', title: 'S1', item_ids: ['deezer:1'] }],
      items: [{ id: 'deezer:1', type: 'track', source: 'deezer', title: 'One', artist: 'A' }],
    });

    const staleRelease = retainDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryLoading()).toBe(false));

    resetDiscoveryFeed();
    const freshRelease = retainDiscoveryFeed();
    await vi.waitFor(() => expect(discoveryLoading()).toBe(false));

    // Pre-reset closure must not decrement or abort post-reset active consumers.
    staleRelease();
    expect(discoveryError()).toBe(false);

    // Calling restoreDiscoveryItem invalidates search cache so subsequent fresh retains reload if needed.
    restoreDiscoveryItem('deezer:1');
    expect(localStorage.length).toBe(0);
    freshRelease();
  });
});
