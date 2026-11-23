import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';
import { clearSearchCache, writeSearchCache } from '../lib/searchCache';
import { CATALOG_CACHE_NS } from '../lib/searchSections';
import { registerMusicNavigator } from '../lib/musicNavigation';
import { mockScrollportLayout } from '../testLayout';

mockScrollportLayout();

const listLayoutMock = vi.hoisted(() => ({ mobile: false }));
vi.mock('../lib/listLayout', () => ({ mobileListLayout: () => listLayoutMock.mobile }));

const apiMock = vi.hoisted(() => ({
  searchCatalog: vi.fn(),
  searchYouTube: vi.fn().mockResolvedValue([]),
  peekYouTube: vi.fn(),
  resolveCatalogItem: vi.fn(),
  emitDiscoveryEvent: vi.fn().mockResolvedValue(undefined),
}));
const exploreMock = vi.hoisted(() => ({
  retainDiscoveryFeed: vi.fn(() => vi.fn()),
  refreshDiscoveryFeed: vi.fn(),
  items: [] as Array<Record<string, unknown>>,
}));
const storeMock = vi.hoisted(() => {
  const local: Track = { id: 'local-1', title: 'Local Song', artist: 'Local Artist', album: 'Home' };
  return {
    local,
    state: {
      library: [local] as Track[],
      favorites: ['local-1'] as string[],
      playlists: { Running: ['local-1'] } as Record<string, string[]>,
      librarySettings: {},
      autoMode: { active: false },
      playback: { currentTrack: null as Track | null, queue: [] as Track[], isLoading: false, isPlaying: false },
    },
    actions: {
      playTrack: vi.fn(),
      playFrom: vi.fn(),
      playShuffled: vi.fn(),
      startDjSelection: vi.fn(),
      enqueue: vi.fn(),
      linkCatalogItem: vi.fn(),
      placeAutoTrack: vi.fn(),
      useAutoTrackAsSource: vi.fn(),
      changeAutoSession: vi.fn().mockResolvedValue(true),
      addAutoSource: vi.fn(),
      autoSessionToken: vi.fn(() => 1),
      beginAutoSessionChange: vi.fn(() => 1),
    },
  };
});

vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/discoveryFeedStore', () => ({
  retainDiscoveryFeed: exploreMock.retainDiscoveryFeed,
  refreshDiscoveryFeed: exploreMock.refreshDiscoveryFeed,
  dismissDiscoveryItem: vi.fn(),
  restoreDiscoveryItem: vi.fn(),
  dismissDiscoveryArtist: vi.fn(),
  restoreDiscoveryArtist: vi.fn(),
  discoveryExploreItems: () => exploreMock.items,
  discoveryLoading: () => false,
  discoveryRefreshing: () => false,
}));
vi.mock('../lib/toast', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn() } }));
vi.mock('../stores', async () => {
  const { identityMock } = await import('../lib/identityMock');
  return {
    setNowPlayingOpen: vi.fn(),
    state: storeMock.state,
    actions: storeMock.actions,
    musicLibrary: () => storeMock.state.library,
    ...identityMock({
      currentTrack: () => storeMock.state.playback.currentTrack,
      library: () => storeMock.state.library,
      queue: () => storeMock.state.playback.queue,
    }),
    favouriteTracks: () => storeMock.state.favorites.includes(storeMock.local.id) ? [storeMock.local] : [],
  };
});
vi.mock('../stores/player', () => ({
  player: () => ({ playback: storeMock.state.playback, autoMode: storeMock.state.autoMode, actions: storeMock.actions, remote: false }),
}));
vi.mock('./entryActions', () => ({ openEntryMenu: vi.fn() }));
vi.mock('./trackActions', () => ({ openTrackMenu: vi.fn() }));
vi.mock('./PlaylistPicker', () => ({ openPlaylistPicker: vi.fn() }));
vi.mock('./MetadataEditor', () => ({ openMetadataEditor: vi.fn() }));
vi.mock('./DeviceSheet', () => ({ openPlayOnDevice: vi.fn() }));

import { clearPlayerSearch, PlayerSearchPanel } from './PlayerSearchPanel';
import { setLocale } from '../lib/i18n';

const song = { id: 'yt:abc', type: 'track', source: 'youtube', title: 'Teardrop', artist: 'Massive Attack', external_ids: { youtube_id: 'abcdefghijk' }, raw: { id: 'abcdefghijk', title: 'Teardrop', artist: 'Massive Attack', source: 'preview' } };
const artist = { id: 'artist:1', type: 'artist', title: 'Massive Attack', external_ids: { deezer_artist_id: 7 } };

function cacheResults(query: string) {
  writeSearchCache(CATALOG_CACHE_NS, query, {
    items: [song, artist],
    sections: [{ id: 'songs', item_ids: [song.id] }, { id: 'artists', item_ids: [artist.id] }],
    interpretedAs: '',
  });
}

async function type(value: string) {
  vi.useFakeTimers();
  fireEvent.input(screen.getByRole('searchbox'), { target: { value } });
  await vi.advanceTimersByTimeAsync(260);
  vi.useRealTimers();
}

const navigate = vi.fn();

beforeEach(() => {
  setLocale('en');
  vi.clearAllMocks();
  clearSearchCache();
  listLayoutMock.mobile = false;
  storeMock.state.autoMode.active = false;
  exploreMock.items = [];
  registerMusicNavigator(navigate);
});
afterEach(() => {
  clearPlayerSearch();
  clearSearchCache();
});

describe('PlayerSearchPanel', () => {
  it('has one search field and no browser of its own', () => {
    render(() => <PlayerSearchPanel onClose={() => {}} />);
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('offers collections to play when idle, and starts a DJ session from them during one', () => {
    render(() => <PlayerSearchPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play: Running' }));
    expect(storeMock.actions.playFrom).toHaveBeenCalledWith([storeMock.local], 0, expect.objectContaining({ context: expect.objectContaining({ kind: 'playlist' }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Play: Shuffle library' }));
    expect(storeMock.actions.playShuffled).toHaveBeenCalled();

    storeMock.state.autoMode.active = true;
    fireEvent.click(screen.getByRole('button', { name: 'Play: Favourites' }));
    expect(storeMock.actions.startDjSelection).toHaveBeenCalledWith([storeMock.local], 'Favourites');
  });

  it('plays a result through the same path as any other list, in a DJ session too', async () => {
    cacheResults('teardrop');
    storeMock.state.autoMode.active = true;
    render(() => <PlayerSearchPanel onClose={() => {}} />);
    await type('teardrop');
    fireEvent.click(screen.getByRole('button', { name: 'Play Teardrop by Massive Attack' }));
    // `playTrack` is what every list calls; in a DJ session it starts a new one.
    await waitFor(() => expect(storeMock.actions.playTrack).toHaveBeenCalledWith(expect.objectContaining({ title: 'Teardrop' })));
    expect(storeMock.actions.placeAutoTrack).not.toHaveBeenCalled();
    // The quick button is the route's during a session.
    expect(screen.getByRole('button', { name: 'Add to route: Teardrop' })).toBeTruthy();
  });

  it('queues from the row button and opens an artist on its own page', async () => {
    cacheResults('massive');
    render(() => <PlayerSearchPanel onClose={() => {}} />);
    await type('massive');
    fireEvent.click(screen.getByRole('button', { name: 'Add to queue: Teardrop' }));
    await waitFor(() => expect(storeMock.actions.enqueue).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('link', { name: /Massive Attack — Artist/ }));
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining('/artist'));
    fireEvent.click(screen.getByRole('button', { name: 'See all results in Search' }));
    expect(navigate).toHaveBeenCalledWith('/search?q=massive');
  });

  it('takes the first result with Enter', async () => {
    cacheResults('enter');
    render(() => <PlayerSearchPanel onClose={() => {}} />);
    await type('enter');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    await waitFor(() => expect(storeMock.actions.playTrack).toHaveBeenCalled());
  });

  it('does the DJ errand it was opened for, and says which', async () => {
    cacheResults('errand');
    storeMock.state.autoMode.active = true;
    const onDone = vi.fn();
    const onCancel = vi.fn();
    render(() => <PlayerSearchPanel intent="route" beforeQueueId="q-3" onDone={onDone} onCancelIntent={onCancel} onClose={() => {}} />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('Choose music for this position in Route');
    // A seam takes one song: no collection shortcuts.
    expect(screen.queryByRole('button', { name: 'Play: Running' })).toBeNull();
    await type('errand');
    // The press is the errand: no second button repeats it.
    expect(screen.queryByRole('button', { name: /^Add to route: Teardrop$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add to queue/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to route: Teardrop' }));
    await waitFor(() => expect(storeMock.actions.placeAutoTrack).toHaveBeenCalledWith(expect.objectContaining({ title: 'Teardrop' }), 'q-3'));
    expect(onDone).toHaveBeenCalled();
    expect(storeMock.actions.playTrack).not.toHaveBeenCalled();
    // Leaving for an artist page would abandon the errand.
    expect(screen.queryByRole('link', { name: /Massive Attack — Artist/ })).toBeNull();
    fireEvent.click(within(banner).getByRole('button'));
    expect(onCancel).toHaveBeenCalled();
  });
});
