/**
 * Feed lifecycle around a cold boot: Search mounts before the first library
 * sync lands, so the very first `ensureNodeFeed()` sees an empty library. It
 * must read that as "not yet" and build the feed once tracks arrive — the bug
 * where the first visit to Search showed the "search for music to get started"
 * seed state and only a second visit rendered the grid.
 *
 * Lives apart from nodeDiscover.test.ts because it needs a *reactive* store
 * mock, where that file deliberately mocks the store as a plain object.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetStoreFunction } from 'solid-js/store';

interface StoreShape {
  library: Array<{ id: string; title: string; artist: string }>;
  libraryReady: boolean;
}

/** Hoisted so the `vi.mock` factories (which run before the module body) can
 * publish the reactive store they create back to the test. */
const mocks = vi.hoisted(() => ({
  discoverFeed: vi.fn(),
  store: null as { state: StoreShape; setState: SetStoreFunction<StoreShape> } | null,
}));

vi.mock('./api', () => ({ api: { discoverFeed: mocks.discoverFeed } }));
vi.mock('../stores', async () => {
  const { createStore } = await import('solid-js/store');
  const [state, setState] = createStore<StoreShape>({ library: [], libraryReady: false });
  mocks.store = { state, setState };
  return { state, favouriteLibraryIds: () => new Set<string>() };
});
vi.mock('./prefetch', () => ({ prefetchPreviews: vi.fn() }));
vi.mock('./socket', () => ({ setDiscoverSeedHandler: vi.fn() }));
vi.mock('./session', () => ({ user: () => null, userKey: (k: string) => k }));

import { ensureNodeFeed, nodeFeed, nodeLoading } from './nodeDiscover';

const setState = (patch: Partial<StoreShape>) => mocks.store!.setState(patch);
const track = (id: string) => ({ id, title: `title-${id}`, artist: `artist-${id}` });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ensureNodeFeed before the library has synced', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.discoverFeed.mockReset();
    mocks.discoverFeed.mockResolvedValue({ request_id: 'r0', ready: [], pending: [] });
    setState({ library: [], libraryReady: false });
  });

  it('waits for the library instead of asking the server with no seeds', async () => {
    ensureNodeFeed();
    await settle();
    expect(mocks.discoverFeed).not.toHaveBeenCalled();
    // Loading, so the view shows skeletons rather than the seed empty state.
    expect(nodeLoading()).toBe(true);
  });

  it('builds the feed as soon as the first sync lands tracks', async () => {
    ensureNodeFeed();
    await settle();

    mocks.discoverFeed.mockResolvedValue({
      request_id: 'r1',
      ready: [{ seed_track_id: 'a', recs: [{ id: 'v1', title: 'Rec one' }] }],
      pending: [],
    });
    setState({ library: [track('a'), track('b')], libraryReady: true });
    await settle();

    expect(mocks.discoverFeed).toHaveBeenCalledTimes(1);
    expect(nodeFeed().map((r) => r.id)).toEqual(['v1']);
    expect(nodeLoading()).toBe(false);
  });

  it('stops waiting when the sync settles on a genuinely empty library', async () => {
    ensureNodeFeed();
    await settle();
    expect(nodeLoading()).toBe(true);

    setState({ libraryReady: true });
    await settle();

    expect(mocks.discoverFeed).not.toHaveBeenCalled();
    expect(nodeFeed()).toEqual([]);
    // No longer loading: the seed empty state is now the truth.
    expect(nodeLoading()).toBe(false);
  });
});
