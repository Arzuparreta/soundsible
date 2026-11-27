import { createRoot } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import type { DiscoveryNewReleasesResponse } from './api';
import { dispatchDiscoveryFeedReady } from './discoveryEvents';
import { createNewReleases } from './newReleases';
import { newReleasesApi } from './newReleasesApi';

const release = { id: 'release', type: 'album', source: 'deezer', title: 'New album' } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('ignores an old connection response and drops pending work on disposal', async () => {
  const response = Promise.withResolvers<DiscoveryNewReleasesResponse>();
  const get = vi.spyOn(newReleasesApi, 'getDiscoveryNewReleases')
    .mockReturnValueOnce(response.promise)
    .mockResolvedValue({ items: [release], revalidating: false });
  let generation = 1;
  let disconnected = false;
  const { releases, dispose } = createRoot((dispose) => {
    const releases = createNewReleases(() => generation, () => disconnected);
    releases.subscribe();
    return { releases, dispose };
  });

  try {
    const oldLoad = releases.load();
    generation++;
    disconnected = true;
    releases.reset();
    response.resolve({ items: [release], revalidating: false });
    await oldLoad;
    dispatchDiscoveryFeedReady({ reason: 'new_releases' });
    expect(releases.items()).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);

    disconnected = false;
    await releases.load();
    expect(releases.items()).toEqual([release]);
    expect(get.mock.calls[0][0]?.aborted).toBe(true);
    dispose();
    dispatchDiscoveryFeedReady({ reason: 'new_releases' });
    expect(get.mock.calls[1][0]?.aborted).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
  }
});

it('uses a push in place of the timer and falls back at most once', async () => {
  vi.useFakeTimers();
  const get = vi.spyOn(newReleasesApi, 'getDiscoveryNewReleases')
    .mockResolvedValue({ items: [], revalidating: true });
  const { releases, dispose } = createRoot((dispose) => {
    const releases = createNewReleases(() => 'account');
    releases.subscribe();
    return { releases, dispose };
  });

  try {
    await releases.load();
    await vi.advanceTimersByTimeAsync(4000);
    dispatchDiscoveryFeedReady({ reason: 'other_feed' });
    expect(get).toHaveBeenCalledTimes(1);
    dispatchDiscoveryFeedReady({ reason: 'new_releases' });
    expect(get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9000);
    expect(get).toHaveBeenCalledTimes(3);
  } finally {
    dispose();
  }
});
