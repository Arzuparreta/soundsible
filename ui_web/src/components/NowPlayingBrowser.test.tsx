import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';

const apiMock = vi.hoisted(() => ({
  searchCatalog: vi.fn(),
  searchYouTube: vi.fn(),
  peekYouTube: vi.fn(),
  resolveCatalogItem: vi.fn(),
  getArtistProfile: vi.fn(),
  getAlbumProfile: vi.fn(),
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
      requestAutoTrack: vi.fn(),
      requestAutoArtist: vi.fn(),
    },
  };
});

vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
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
    state: storeMock.state,
    actions: storeMock.actions,
    musicLibrary: () => storeMock.state.library,
    ...identityMock({
      currentTrack: () => storeMock.state.playback.currentTrack,
      library: () => storeMock.state.library,
      queue: () => storeMock.state.playback.queue,
    }),
  };
});
vi.mock('./trackActions', () => ({ openTrackMenu: vi.fn() }));
vi.mock('./PlaylistPicker', () => ({ openPlaylistPicker: vi.fn() }));
vi.mock('./MetadataEditor', () => ({ openMetadataEditor: vi.fn() }));
vi.mock('./DeviceSheet', () => ({ openPlayOnDevice: vi.fn() }));
vi.mock('./ActionMenu', () => ({ openActionMenu: vi.fn() }));

import { NowPlayingBrowser } from './NowPlayingBrowser';
import { setLocale } from '../lib/i18n';

async function typeGlobalQuery(value: string) {
  vi.useFakeTimers();
  fireEvent.input(screen.getByPlaceholderText('Search everywhere'), { target: { value } });
  await vi.advanceTimersByTimeAsync(260);
  vi.useRealTimers();
}

describe('NowPlayingBrowser', () => {
  beforeEach(() => {
    setLocale('en');
    apiMock.searchCatalog.mockResolvedValue({ items: [], sections: [] });
    apiMock.searchYouTube.mockResolvedValue([]);
    apiMock.peekYouTube.mockResolvedValue(null);
    apiMock.resolveCatalogItem.mockResolvedValue({});
    nodeMock.items = [];
    nodeMock.loading = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('opens as a music-only root with the global search always present', () => {
    render(() => <NowPlayingBrowser onClose={vi.fn()} />);

    expect(screen.getByPlaceholderText('Search everywhere')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Library/ })).toHaveAttribute('data-pressable');
    expect(screen.getByRole('button', { name: /^Playlists/ })).toHaveAttribute('data-pressable');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Podcasts')).not.toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  it('only enters library scope explicitly and offers the same query globally', async () => {
    render(() => <NowPlayingBrowser onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Library/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Search your library' }));
    fireEvent.input(screen.getByPlaceholderText('Search your library'), { target: { value: 'local' } });

    expect(screen.getByText('Local Song')).toBeInTheDocument();
    expect(apiMock.searchCatalog).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Search “local” everywhere' }));
    await waitFor(() => expect(apiMock.searchCatalog).toHaveBeenCalledWith('local', expect.any(AbortSignal), 'all'));
    expect(screen.getByPlaceholderText('Search everywhere')).toHaveValue('local');
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
    fireEvent.click(await screen.findByText('Internet Live Set'));

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
    const onRequested = vi.fn();

    render(() => (
      <NowPlayingBrowser
        purpose="auto-request"
        onClose={vi.fn()}
        onRequested={onRequested}
      />
    ));
    vi.useFakeTimers();
    fireEvent.input(screen.getByPlaceholderText('Track or artist'), { target: { value: 'requested song' } });
    await vi.advanceTimersByTimeAsync(260);
    vi.useRealTimers();
    fireEvent.click(await screen.findByRole('button', { name: 'Request from the DJ: Requested Song' }));

    await waitFor(() => expect(storeMock.actions.requestAutoTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'yt-requested', source: 'preview' }),
    ));
    expect(storeMock.actions.playNow).not.toHaveBeenCalled();
    expect(onRequested).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Add to queue' })).not.toBeInTheDocument();
  });
});
