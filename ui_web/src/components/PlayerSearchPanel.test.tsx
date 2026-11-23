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
  getArtistProfile: vi.fn(),
}));
const menuMock = vi.hoisted(() => ({ open: vi.fn() }));
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
      enterAutoMode: vi.fn(),
      autoSessionToken: vi.fn(() => 1),
      beginAutoSessionChange: vi.fn(() => 1),
    },
  };
});

vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/toast', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(() => ({ dismiss: vi.fn() })) } }));
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
vi.mock('../lib/contextMenu', () => ({ openContextMenu: menuMock.open, attachContextMenu: vi.fn() }));
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

  it('shows only the field until something is typed', () => {
    render(() => <PlayerSearchPanel onClose={() => {}} />);
    expect(screen.queryAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Close panel']);
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
    // A collection opens its actions here; its page is one of them.
    fireEvent.click(screen.getByRole('button', { name: /Massive Attack — Artist/ }));
    const sheet = menuMock.open.mock.calls.at(-1)![0] as { actions: Array<{ label: string; onSelect: () => void }> };
    expect(sheet.actions.map((action) => action.label)).toEqual(expect.arrayContaining(['Play', 'Shuffle play', 'Start a DJ session', 'Go to artist']));
    sheet.actions.find((action) => action.label === 'Go to artist')!.onSelect();
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
    // A seam of the route takes one song, never a collection.
    expect(screen.queryByRole('button', { name: /Massive Attack/ })).toBeNull();
    fireEvent.click(within(banner).getByRole('button'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('starts a DJ session from a found artist in NORMAL, and mixes one into the session during an errand', async () => {
    cacheResults('daft');
    apiMock.getArtistProfile.mockResolvedValue({ top_tracks: [song] });
    render(() => <PlayerSearchPanel onClose={() => {}} />);
    await type('daft');
    fireEvent.click(screen.getByRole('button', { name: /Massive Attack — Artist/ }));
    const sheet = menuMock.open.mock.calls.at(-1)![0] as { actions: Array<{ label: string; onSelect: () => void }> };
    sheet.actions.find((action) => action.label === 'Start a DJ session')!.onSelect();
    // NORMAL enters DJ on the collection's first playable song, then opens on it.
    await waitFor(() => expect(storeMock.actions.enterAutoMode).toHaveBeenCalledWith(expect.objectContaining({ deferPlanning: true })));
  });

  it('hands a found collection whole to a Mix with errand', async () => {
    cacheResults('mix');
    storeMock.state.autoMode.active = true;
    apiMock.getArtistProfile.mockResolvedValue({ top_tracks: [song] });
    const onDone = vi.fn();
    render(() => <PlayerSearchPanel intent="reference" onDone={onDone} onClose={() => {}} />);
    await type('mix');
    fireEvent.click(screen.getByRole('button', { name: 'Mix into session: Massive Attack' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(menuMock.open).not.toHaveBeenCalled();
  });
});
