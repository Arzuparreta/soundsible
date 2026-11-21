import type { JSX } from 'solid-js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { clearSearchCache } from '../lib/searchCache';
import { dispatchDiscoveryFeedReady } from '../lib/discoveryEvents';
import { setLocale } from '../lib/i18n';

const mocks = vi.hoisted(() => ({
  getDiscoveryMusicFeed: vi.fn(),
  resolveCatalogItem: vi.fn(),
  prefetchPreviews: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@solidjs/router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../lib/api', () => ({
  api: {
    getDiscoveryMusicFeed: mocks.getDiscoveryMusicFeed,
    resolveCatalogItem: mocks.resolveCatalogItem,
  },
}));
vi.mock('../lib/prefetch', () => ({ prefetchPreviews: mocks.prefetchPreviews }));
vi.mock('../lib/session', () => ({ userKey: (k: string) => `u1:${k}` }));
vi.mock('../stores', async () => {
  const { identityMock } = await import('../lib/identityMock');
  const library: never[] = [];
  return {
    musicLibrary: () => library,
    state: {
      autoMode: { active: false },
      playback: { isLoading: false, currentTrack: null, queue: [] },
      library,
      saved: [],
      downloads: { queue: [] },
      favourites: [],
    },
    ...identityMock({ currentTrack: () => null, library: () => library }),
    actions: {},
  };
});
vi.mock('./MusicLinks', () => ({
  MusicLink: (props: { children: JSX.Element; class?: string; label?: string }) => (
    <a class={props.class} aria-label={props.label}>{props.children}</a>
  ),
  ArtistLinks: (props: { fallback?: string }) => <span>{props.fallback}</span>,
}));

import { SearchDiscovery } from './SearchDiscovery';

beforeEach(() => {
  setLocale('en');
  clearSearchCache();
  vi.clearAllMocks();
  mocks.resolveCatalogItem.mockResolvedValue({ video_id: 'vid12345678' });
});

afterEach(() => {
  cleanup();
});

it('reloads via discovery_feed_ready push, supports refresh, and speculatively prefetches top songs', async () => {
  mocks.getDiscoveryMusicFeed
    .mockResolvedValueOnce({
      revalidating: true,
      sections: [{ id: 'more_like_x', title: 'More like X', item_ids: ['deezer:1', 'youtube:yt1'] }],
      items: [
        { id: 'deezer:1', title: 'Track One', artist: 'Band One', duration: 200 },
        { id: 'youtube:yt1', title: 'Track Two', artist: 'Band Two', external_ids: { youtube_id: 'yt123456789' } },
      ],
    })
    .mockResolvedValueOnce({
      revalidating: false,
      sections: [{ id: 'more_like_x', title: 'More like X', item_ids: ['deezer:1', 'youtube:yt1'] }],
      items: [
        { id: 'deezer:1', title: 'Track One', artist: 'Band One', duration: 200 },
        { id: 'youtube:yt1', title: 'Track Two', artist: 'Band Two', external_ids: { youtube_id: 'yt123456789' } },
      ],
    })
    .mockResolvedValueOnce({
      revalidating: false,
      sections: [{ id: 'more_like_x', title: 'More like X', item_ids: ['deezer:2'] }],
      items: [{ id: 'deezer:2', title: 'Rotated Track', artist: 'Band Three', duration: 190 }],
    });

  const onReady = vi.fn();
  const view = render(() => (
    <SearchDiscovery onReady={onReady} onPlay={vi.fn()} onSave={vi.fn()} saving={new Set()} />
  ));

  await waitFor(() => expect(view.getByText('Track One')).toBeTruthy());
  await waitFor(() => expect(mocks.resolveCatalogItem).toHaveBeenCalledWith({
    artist: 'Band One',
    title: 'Track One',
    duration: 200,
  }));
  await waitFor(() => expect(mocks.prefetchPreviews).toHaveBeenCalledWith(['yt123456789']));
  await waitFor(() => expect(mocks.prefetchPreviews).toHaveBeenCalledWith(['vid12345678']));

  dispatchDiscoveryFeedReady({ limit: 10 });
  await waitFor(() => expect(mocks.getDiscoveryMusicFeed).toHaveBeenCalledTimes(2));

  fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(view.getByText('Rotated Track')).toBeTruthy());
  expect(mocks.getDiscoveryMusicFeed.mock.calls[2][1]).toBe(true);
});
