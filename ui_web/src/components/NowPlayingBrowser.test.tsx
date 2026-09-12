import { registerMusicNavigator } from '../lib/musicNavigation';
import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';
import { clearSearchCache, writeSearchCache } from '../lib/searchCache';
import { CATALOG_CACHE_NS } from '../lib/searchSections';

const listLayoutMock = vi.hoisted(() => ({ mobile: false }));
vi.mock('../lib/listLayout', () => ({ mobileListLayout: () => listLayoutMock.mobile }));

const apiMock = vi.hoisted(() => ({
  searchCatalog: vi.fn(),
  searchYouTube: vi.fn(),
  peekYouTube: vi.fn(),
  resolveCatalogItem: vi.fn(),
  getArtistProfile: vi.fn(),
  getAlbumProfile: vi.fn(),
  getLibraryAlbums: vi.fn().mockResolvedValue([]),
  getLibraryArtist: vi.fn().mockResolvedValue({ track_ids: ['local-1'] }),
  getLibraryAlbum: vi.fn().mockResolvedValue({ track_ids: ['local-1'] }),
}));
const nodeMock = vi.hoisted(() => ({
  ensureNodeFeed: vi.fn(),
  refreshNodeFeed: vi.fn(),
  items: [] as Array<Record<string, unknown>>,
  loading: false,
}));
const storeMock = vi.hoisted(() => {
  const local: Track = { id: 'local-1', title: 'Local Song', artist: 'Local Artist', album: 'Home' };
  return {
    local,
    state: {
      library: [local] as Track[],
      favorites: [] as string[],
      playlists: { Favourites: ['local-1'] } as Record<string, string[]>,
      librarySettings: {},
      // Artists come from the engine's catalog, not from grouping the flat list.
      catalog: {
        artists: [{ id: 'ar-local', name: 'Local Artist', track_count: 1, album_count: 1, cover_track_id: 'local-1' }],
        genres: [],
        years: [],
        ready: true,
        loading: false,
        revision: 1,
      },
      playback: {
        currentTrack: local as Track | null,
        queue: [] as Track[],
        radioMode: false,
        radioLoading: false,
      },
    },
    actions: {
      playNow: vi.fn(),
      playFrom: vi.fn(),
      enqueue: vi.fn(),
      startRadio: vi.fn(),
      linkCatalogItem: vi.fn(),
      placeAutoTrack: vi.fn(),
      placeAutoTracks: vi.fn(),
      autoSessionToken: vi.fn(() => 1),
      addAutoSource: vi.fn(),
      changeAutoSession: vi.fn().mockResolvedValue(true),
      beginAutoSessionChange: vi.fn(() => 1),
      useAutoTrackAsSource: vi.fn(),
    },
  };
});

vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/media')>()),
  coverUrl: (id: string) => `/cover/${id}`,
}));
vi.mock('../lib/prefetch', () => ({ prefetchPreviews: vi.fn() }));
vi.mock('../lib/nodeDiscover', () => ({
  ensureNodeFeed: nodeMock.ensureNodeFeed,
  refreshNodeFeed: nodeMock.refreshNodeFeed,
  nodeFeed: () => nodeMock.items,
  nodeLoading: () => nodeMock.loading,
}));
vi.mock('../lib/toast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));
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
vi.mock('./VirtualRows', () => ({ VirtualRows: (props: { items: Track[]; children: (item: () => Track, index: number) => unknown }) => props.items.map((item, index) => props.children(() => item, index)) }));
vi.mock('./trackActions', () => ({ openTrackMenu: vi.fn() }));
vi.mock('./PlaylistPicker', () => ({ openPlaylistPicker: vi.fn() }));
vi.mock('./MetadataEditor', () => ({ openMetadataEditor: vi.fn() }));
vi.mock('./DeviceSheet', () => ({ openPlayOnDevice: vi.fn() }));
vi.mock('./ActionMenu', () => ({ openActionMenu: vi.fn() }));

import { NowPlayingBrowser } from './NowPlayingBrowser';
import { musicBrowserNavigation as navigation } from '../lib/musicBrowserNavigation';
import { setLibraryTab, setLibraryFilter } from '../lib/libraryView';
import { openActionMenu } from './ActionMenu';
import { setLocale } from '../lib/i18n';

async function typeGlobalQuery(value: string) {
  vi.useFakeTimers();
  fireEvent.input(screen.getByPlaceholderText('Search everywhere'), { target: { value } });
  await vi.advanceTimersByTimeAsync(260);
  vi.useRealTimers();
}

beforeEach(() => {
  listLayoutMock.mobile = false;
  setLocale('en');
  navigation.reset();
  setLibraryTab('songs');
  setLibraryFilter('all');
  // Shared with the Search route and with every other test in this file.
  clearSearchCache();
  apiMock.searchCatalog.mockResolvedValue({ items: [], sections: [] });
  apiMock.searchYouTube.mockResolvedValue([]);
  apiMock.peekYouTube.mockResolvedValue(null);
  apiMock.resolveCatalogItem.mockResolvedValue({});
  nodeMock.items = [];
  nodeMock.loading = false;
  storeMock.state.favorites = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('NowPlayingBrowser', () => {
  it('searches eleven-character artist names through the intelligent catalog', async () => {
    render(() => <NowPlayingBrowser onClose={vi.fn()} />);
    await typeGlobalQuery('Extremoduro');
    expect(apiMock.searchCatalog).toHaveBeenCalledWith('Extremoduro', expect.any(AbortSignal));
    expect(apiMock.peekYouTube).not.toHaveBeenCalled();
  });

  it('opens as a music-only root with the global search always present', () => {
    render(() => <NowPlayingBrowser onClose={vi.fn()} />);

    expect(screen.getByPlaceholderText('Search everywhere')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Library/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Favourites/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Playlists/ })).toBeInTheDocument();
    expect(screen.queryByText('Listen now')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explore' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Podcasts')).not.toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  it.each(['auto-neutral', 'auto-route'] as const)(
    'hides Listen now in the %s Auto browser context',
    (purpose) => {
      render(() => <NowPlayingBrowser purpose={purpose} onClose={vi.fn()} />);

      expect(screen.queryByText('Listen now')).not.toBeInTheDocument();
    },
  );

  it.each(['auto-neutral', 'auto-route'] as const)(
    'gives every song one route control and no browse clutter in %s',
    async (purpose) => {
      nodeMock.items = [{ id: 'node-1', title: 'Node Song', channel: 'Node Artist' }];
      storeMock.state.favorites = ['local-1'];
      render(() => <NowPlayingBrowser purpose={purpose} onClose={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
      // The discover rail sits on the root view and used to keep both browse
      // controls in DJ Mode, because it never received the flag that hid them.
      expect(screen.queryByRole('button', { name: 'Add to queue' })).not.toBeInTheDocument();
      if (purpose === 'auto-neutral') expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
      else expect(screen.queryByRole('button', { name: 'More options' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add to session: Node Song' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^Favourites/ }));
      const add = await screen.findByRole('button', { name: 'Add to session: Local Song' });
      expect(screen.queryByRole('button', { name: 'Add to queue' })).not.toBeInTheDocument();
      fireEvent.click(add);
      expect(storeMock.actions.placeAutoTrack).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'local-1' }),
        undefined,
      );
    },
  );

  it('keeps the queue and overflow controls outside DJ Mode', () => {
    nodeMock.items = [{ id: 'node-1', title: 'Node Song', channel: 'Node Artist' }];
    render(() => <NowPlayingBrowser onClose={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Request' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /to the route$/ })).not.toBeInTheDocument();
  });

  it('opens catalog artists in the general page without placing a DJ request', async () => {
    // The two catalog views passed neither a track nor a carry handler, so a
    // song found by browsing an artist could not be dragged or added at all.
    apiMock.searchCatalog.mockResolvedValue({
      items: [{ id: 'deezer:artist:1', type: 'artist', source: 'deezer', title: 'Radiohead', artist: 'Radiohead' }],
      sections: [{ id: 'artists', layout: 'rows', item_ids: ['deezer:artist:1'], total: 1 }],
    });
    const navigate = vi.fn();
    const unregister = registerMusicNavigator(navigate);
    render(() => <NowPlayingBrowser purpose="auto-neutral" onClose={vi.fn()} />);
    await typeGlobalQuery('radiohead');
    fireEvent.click(await screen.findByRole('link', { name: /Radiohead/ }));

    expect(navigate).toHaveBeenCalledWith('/artist/Radiohead?view=discover');
    expect(storeMock.actions.placeAutoTrack).not.toHaveBeenCalled();
    unregister();
  });

  it('opens favourites as a first-class NORMAL collection', () => {
    storeMock.state.favorites = ['local-1'];
    render(() => <NowPlayingBrowser onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^Favourites/ }));
    expect(screen.getByRole('heading', { name: 'Favourites' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Local Song/ }));
    expect(storeMock.actions.playFrom).toHaveBeenCalledWith(
      [storeMock.local],
      0,
      { context: { id: 'favourites', kind: 'favourites', label: 'Favourites' } },
    );
  });

  it('offers a whole collection as a source without arming a mode first', () => {
    // This used to sit behind a ＋ in the Sources header whose only visible
    // effect was a highlight: the button it unlocked lived two screens away.
    storeMock.state.favorites = ['local-1'];
    render(() => <NowPlayingBrowser purpose="auto-neutral" onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^Favourites/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Favourites' }));
    const options = vi.mocked(openActionMenu).mock.calls.at(-1)![0];
    options.actions![0].onSelect();
    expect(storeMock.actions.addAutoSource).toHaveBeenCalledWith([storeMock.local], 'Favourites');
  });

  it('requests a collection at the selected route seam and completes the picker', async () => {
    storeMock.state.favorites = ['local-1'];
    const onPlaced = vi.fn();
    render(() => <NowPlayingBrowser purpose="auto-route" routeBeforeQueueId="chosen-seam" onPlaced={onPlaced} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Favourites/ }));
    fireEvent.click(within(screen.getByRole('heading', { name: 'Favourites' }).closest('header')!).getByRole('button', { name: 'Add to session' }));
    await waitFor(() => expect(storeMock.actions.placeAutoTracks).toHaveBeenCalledWith([storeMock.local], 'chosen-seam'));
    expect(onPlaced).toHaveBeenCalledOnce();
  });

  it('makes reference selection the primary collection action in the reference picker', () => {
    storeMock.state.favorites = ['local-1'];
    const onPlaced = vi.fn();
    render(() => <NowPlayingBrowser purpose="auto-reference" onPlaced={onPlaced} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Favourites/ }));
    expect(screen.queryByRole('button', { name: 'Add to session' })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('heading', { name: 'Favourites' }).closest('header')!).getByRole('button', { name: 'Mix into session' }));
    expect(storeMock.actions.addAutoSource).toHaveBeenCalledWith([storeMock.local], 'Favourites');
    expect(storeMock.actions.placeAutoTracks).not.toHaveBeenCalled();
    expect(onPlaced).toHaveBeenCalledOnce();
  });

  it('keeps sources out of the way outside DJ Mode', () => {
    storeMock.state.favorites = ['local-1'];
    render(() => <NowPlayingBrowser onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^Favourites/ }));
    expect(screen.queryByRole('button', { name: 'Add to sources' })).not.toBeInTheDocument();
  });

  it('only enters library scope explicitly and offers the same query globally', async () => {
    render(() => <NowPlayingBrowser onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Library/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Search your library' }));
    fireEvent.input(screen.getByPlaceholderText('Search your library'), { target: { value: 'local' } });

    expect(screen.getByRole('button', { name: /Local Song/ })).toBeInTheDocument();
    expect(apiMock.searchCatalog).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Search “local” everywhere' }));
    await waitFor(() => expect(apiMock.searchCatalog).toHaveBeenCalledWith('local', expect.any(AbortSignal)));
    expect(screen.getByPlaceholderText('Search everywhere')).toHaveValue('local');
  });

  it('renders global results in the order the server sent, hero first', async () => {
    // The panel used to draw entities and then songs, while the Search route
    // drew songs and then entities. Both now follow one server-side decision.
    apiMock.searchCatalog.mockResolvedValue({
      top_result: 'deezer:artist:1',
      items: [
        { id: 'deezer:artist:1', type: 'artist', source: 'deezer', title: 'Radiohead' },
        { id: 'deezer:track:1', type: 'track', source: 'deezer', title: 'Creep', artist: 'Radiohead' },
        { id: 'deezer:album:1', type: 'album', source: 'deezer', title: 'In Rainbows', artist: 'Radiohead' },
      ],
      sections: [
        { id: 'top', layout: 'hero', item_ids: ['deezer:artist:1'], total: 1 },
        { id: 'songs', layout: 'rows', item_ids: ['deezer:track:1'], total: 1 },
        { id: 'albums', layout: 'grid', item_ids: ['deezer:album:1'], total: 1 },
      ],
    });

    render(() => <NowPlayingBrowser onClose={vi.fn()} />);
    await typeGlobalQuery('radiohead');
    await screen.findByText('Creep');

    const rendered = Array.from(document.querySelectorAll('button[aria-label], [role="button"][aria-label], a[aria-label]'))
      .map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '')
      .filter((text) => /Radiohead|Creep|In Rainbows/.test(text));
    const firstIndexOf = (label: string) => rendered.findIndex((text) => text.includes(label));

    expect(firstIndexOf('Radiohead')).toBeLessThan(firstIndexOf('Creep'));
    expect(firstIndexOf('Creep')).toBeLessThan(firstIndexOf('In Rainbows'));
  });

  it('reuses the cache the Search route filled instead of re-fetching', async () => {
    writeSearchCache(CATALOG_CACHE_NS, 'cached query', {
      items: [{ id: 'deezer:track:9', type: 'track', source: 'deezer', title: 'Already Fetched' }],
      sections: [{ id: 'songs', layout: 'rows', item_ids: ['deezer:track:9'], total: 1 }],
      interpretedAs: '',
    });

    render(() => <NowPlayingBrowser onClose={vi.fn()} />);
    await typeGlobalQuery('cached query');

    expect(await screen.findByText('Already Fetched')).toBeInTheDocument();
    expect(apiMock.searchCatalog).not.toHaveBeenCalled();
  });

  it('plays global results without replacing the existing queue', async () => {
    apiMock.searchCatalog.mockResolvedValue({
      items: [{
        id: 'youtube:track:live',
        type: 'track',
        source: 'youtube',
        title: 'Internet Live Set',
        artist: 'Web Artist',
        raw: { id: '98u3AJVEL8Q', title: 'Internet Live Set', artist: 'Web Artist' },
      }],
      sections: [],
    });

    render(() => <NowPlayingBrowser onClose={vi.fn()} />);
    await typeGlobalQuery('internet live set');
    fireEvent.click(await screen.findByRole('button', { name: /Internet Live Set/ }));

    await waitFor(() => expect(storeMock.actions.playNow).toHaveBeenCalledWith(
      expect.objectContaining({ id: '98u3AJVEL8Q', source: 'preview' }),
    ));
    expect(storeMock.actions.playFrom).not.toHaveBeenCalled();
  });

  it('reuses global search with request as the primary Auto action', async () => {
    apiMock.searchCatalog.mockResolvedValue({
      items: [{
        id: 'youtube:track:requested',
        type: 'track',
        source: 'youtube',
        title: 'Requested Song',
        artist: 'Requested Artist',
        raw: { id: 'yt-requested', title: 'Requested Song', artist: 'Requested Artist' },
      }],
      sections: [],
    });
    const onPlaced = vi.fn();

    render(() => (
      <NowPlayingBrowser
        purpose="auto-route"
        onClose={vi.fn()}
        onPlaced={onPlaced}
      />
    ));
    vi.useFakeTimers();
    fireEvent.input(screen.getByPlaceholderText('Track or artist'), { target: { value: 'requested song' } });
    await vi.advanceTimersByTimeAsync(260);
    vi.useRealTimers();
    fireEvent.click(await screen.findByRole('button', { name: 'Add to session: Requested Song' }));

    await waitFor(() => expect(storeMock.actions.placeAutoTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'yt-requested', source: 'preview' }),
      undefined,
    ));
    expect(storeMock.actions.playNow).not.toHaveBeenCalled();
    expect(onPlaced).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Add to queue' })).not.toBeInTheDocument();
  });
});

describe('DJ direction picker', () => {
  it('changes from a collection with one primary action and returns to the route when preparation begins', async () => {
    storeMock.state.favorites = ['local-1'];
    const onPlaced = vi.fn();
    render(() => <NowPlayingBrowser purpose="auto-change" onPlaced={onPlaced} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Favourites/ }));
    const header = within(screen.getByRole('heading', { name: 'Favourites' }).closest('header')!);
    expect(header.queryByRole('button', { name: 'Add to session' })).not.toBeInTheDocument();
    expect(header.queryByRole('button', { name: 'Mix into session' })).not.toBeInTheDocument();
    fireEvent.click(header.getByRole('button', { name: 'Change session' }));
    expect(storeMock.actions.beginAutoSessionChange).toHaveBeenCalledOnce();
    expect(storeMock.actions.changeAutoSession).toHaveBeenCalledWith([storeMock.local], 'Favourites');
    expect(onPlaced).toHaveBeenCalledOnce();
    expect(storeMock.actions.placeAutoTracks).not.toHaveBeenCalled();
    expect(storeMock.actions.addAutoSource).not.toHaveBeenCalled();
  });

  it('cancels the picker without changing music', () => {
    const cancel = vi.fn();
    render(() => <NowPlayingBrowser purpose="auto-change" onCancelPlacement={cancel} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel selection' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(storeMock.actions.changeAutoSession).not.toHaveBeenCalled();
  });
});


describe('direction picker on mobile and desktop', () => {
  it.each([true, false])('offers only the selected song action (mobile=%s)', (mobile) => {
    listLayoutMock.mobile = mobile;
    storeMock.state.favorites = ['local-1'];
    const { container } = render(() => <NowPlayingBrowser purpose="auto-change" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Favourites/ }));
    expect(container.querySelector('[data-row-menu]')).toBeNull();
    expect(screen.queryByRole('button', { name: /More options/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mix into session' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change session: Local Song' }));
    expect(storeMock.actions.changeAutoSession).toHaveBeenCalledWith([storeMock.local], 'Local Song');
  });
});
