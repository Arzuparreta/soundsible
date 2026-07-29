import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';

const apiMock = vi.hoisted(() => ({
  searchCatalog: vi.fn(),
  searchYouTube: vi.fn(),
  peekYouTube: vi.fn(),
  resolveCatalogItem: vi.fn(),
  emitDiscoveryEvent: vi.fn(),
  prefetchPreviews: vi.fn(() => Promise.resolve({ status: 'queued' })),
  getTrackLyrics: vi.fn(),
  getLyricsByMetadata: vi.fn(),
}));
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => ({ update: vi.fn() })),
}));
const discoverMock = vi.hoisted(() => ({
  ensureDiscover: vi.fn(),
  saved: [] as Array<Record<string, unknown>>,
}));
const nodeMock = vi.hoisted(() => ({
  ensureNodeFeed: vi.fn(),
  refreshNodeFeed: vi.fn(),
  items: [] as Array<Record<string, unknown>>,
  loading: false,
}));
const storeMock = vi.hoisted(() => {
  const libTrack: Track = { id: 'lib1', title: 'Local Song', artist: 'Local Artist' };
  return {
    libTrack,
    state: {
      library: [libTrack] as Track[],
      favorites: [] as string[],
      playback: {
        queue: [] as Track[],
        index: -1,
        currentTrack: null as Track | null,
        radioMode: false,
        radioLoading: false,
      },
      downloads: { queue: [] },
    },
    actions: {
      playNow: vi.fn(),
      enqueue: vi.fn(),
      playTrack: vi.fn(),
      startRadio: vi.fn(),
      linkCatalogItem: vi.fn(),
    },
  };
});

vi.mock('@solidjs/router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('../lib/toast', () => ({ toast: toastMock }));
vi.mock('../lib/discover', () => ({
  ensureDiscover: discoverMock.ensureDiscover,
  recentSaved: () => discoverMock.saved,
}));
vi.mock('../lib/nodeDiscover', () => ({
  ensureNodeFeed: nodeMock.ensureNodeFeed,
  refreshNodeFeed: nodeMock.refreshNodeFeed,
  nodeFeed: () => nodeMock.items,
  nodeLoading: () => nodeMock.loading,
}));
vi.mock('../stores', async () => {
  const { identityMock } = await import('../lib/identityMock');
  return {
    state: storeMock.state,
    actions: storeMock.actions,
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

import { panelTab, SearchPanel, selectPanelTab } from './SearchPanel';
import { setLocale } from '../lib/i18n';

async function typeQuery(value: string) {
  vi.useFakeTimers();
  fireEvent.input(screen.getByPlaceholderText('Search on Soundsible'), { target: { value } });
  await vi.advanceTimersByTimeAsync(260);
  vi.useRealTimers();
}

describe('SearchPanel', () => {
  beforeEach(() => {
    setLocale('en');
    selectPanelTab('search');
    storeMock.state.playback.queue = [];
    storeMock.state.playback.currentTrack = null;
    storeMock.state.playback.currentTrack = null;
    discoverMock.saved = [];
    nodeMock.items = [];
    nodeMock.loading = false;
    apiMock.searchCatalog.mockResolvedValue({ items: [], sections: [] });
    apiMock.searchYouTube.mockResolvedValue([]);
    apiMock.peekYouTube.mockResolvedValue(null);
    apiMock.resolveCatalogItem.mockResolvedValue({});
    apiMock.emitDiscoveryEvent.mockResolvedValue({ status: 'ok' });
    apiMock.getTrackLyrics.mockResolvedValue({ synced: null, plain: null, instrumental: false, cached: true });
    apiMock.getLyricsByMetadata.mockResolvedValue({ synced: null, plain: null, instrumental: false, cached: true });
  });

  afterEach(() => {
    setLocale('en');
    vi.clearAllMocks();
  });

  it('shows the node feed in the Discover tab', async () => {
    setLocale('es');
    nodeMock.items = [
      { id: 'rec00000001', title: 'Fresh Track', channel: 'New Artist', seedId: 'lib1', seedTitle: 'Local Song', seedArtist: 'Local Artist' },
    ];

    render(() => <SearchPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Descubrir' }));

    expect(await screen.findByText('Recomendaciones')).toBeInTheDocument();
    expect(screen.getByText('Fresh Track')).toBeInTheDocument();
    expect(screen.getByText('Radio de esta canción')).toBeInTheDocument();
    expect(nodeMock.ensureNodeFeed).toHaveBeenCalled();

    fireEvent.click(screen.getByText('Fresh Track'));
    expect(storeMock.actions.playNow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rec00000001', source: 'preview' }),
    );
  });

  it('starts radio from a library pick via Surprise me', () => {
    render(() => <SearchPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Discover' }));
    fireEvent.click(screen.getByText('Surprise me'));
    expect(storeMock.actions.startRadio).toHaveBeenCalledWith(storeMock.libTrack);
  });

  it('plays a library result via playNow (queue-preserving), never playTrack', async () => {
    apiMock.searchCatalog.mockResolvedValue({
      items: [
        { id: 'cat1', type: 'library_track', source: 'library', title: 'Local Song', artist: 'Local Artist', track_id: 'lib1' },
      ],
      sections: [{ id: 'songs', title: 'Canciones', item_ids: ['cat1'] }],
    });

    render(() => <SearchPanel />);
    await typeQuery('local');

    fireEvent.click(await screen.findByText('Local Song'));
    await waitFor(() => expect(storeMock.actions.playNow).toHaveBeenCalledWith(storeMock.libTrack));
    expect(storeMock.actions.playTrack).not.toHaveBeenCalled();
  });

  it('resolves an external catalog track before queueing it as a preview', async () => {
    apiMock.searchCatalog.mockResolvedValue({
      items: [
        { id: 'ext1', type: 'track', source: 'deezer', title: 'Internet Song', artist: 'Web Artist', duration: 201 },
      ],
      sections: [{ id: 'songs', title: 'Canciones', item_ids: ['ext1'] }],
    });
    apiMock.resolveCatalogItem.mockResolvedValue({ status: 'resolved', video_id: 'vidvidvid01' });

    render(() => <SearchPanel />);
    await typeQuery('internet song');

    await screen.findByText('Internet Song');
    fireEvent.click(screen.getByLabelText('Add to queue'));

    await waitFor(() =>
      expect(apiMock.resolveCatalogItem).toHaveBeenCalledWith({ artist: 'Web Artist', title: 'Internet Song', duration: 201 }),
    );
    await waitFor(() =>
      expect(storeMock.actions.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'vidvidvid01', source: 'preview' }),
      ),
    );
  });

  it('plays a raw YouTube catalog result through the preview stream', async () => {
    apiMock.searchCatalog.mockResolvedValue({
      items: [
        {
          id: 'youtube:track:live',
          type: 'track',
          source: 'youtube',
          title: 'Internet Live Set',
          artist: 'Web Artist',
          raw: {
            id: '98u3AJVEL8Q',
            title: 'Internet Live Set',
            artist: 'Web Artist',
            duration: 3600,
          },
        },
      ],
      sections: [{ id: 'songs', title: 'Canciones', item_ids: ['youtube:track:live'] }],
    });

    render(() => <SearchPanel />);
    await typeQuery('internet live set');

    await waitFor(() =>
      expect(apiMock.prefetchPreviews).toHaveBeenCalledWith(['98u3AJVEL8Q'], false),
    );
    fireEvent.click(await screen.findByText('Internet Live Set'));

    await waitFor(() =>
      expect(storeMock.actions.playNow).toHaveBeenCalledWith(
        expect.objectContaining({
          id: '98u3AJVEL8Q',
          source: 'preview',
        }),
      ),
    );
  });

  it('falls back to YouTube when the catalog has no songs', async () => {
    apiMock.searchCatalog.mockResolvedValue({ items: [], sections: [] });
    apiMock.searchYouTube.mockResolvedValue([
      { id: 'ytresult001', title: 'Only On YouTube', channel: 'Uploader', duration: 240 },
    ]);

    render(() => <SearchPanel />);
    await typeQuery('rare live set');

    expect(await screen.findByText('YouTube results')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Only On YouTube'));
    expect(storeMock.actions.playNow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ytresult001', source: 'preview' }),
    );
  });

  it('hides Lyrics for podcasts without overwriting the persisted music tab', () => {
    selectPanelTab('lyrics');
    storeMock.state.playback.currentTrack = {
      id: 'episode',
      title: 'Episode',
      artist: 'Show',
      media_kind: 'podcast_episode',
      podcast_episode_guid: 'episode-guid',
    };

    const { unmount } = render(() => <SearchPanel />);
    expect(screen.queryByRole('tab', { name: 'Lyrics' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByPlaceholderText('Search on Soundsible')).toBeInTheDocument();
    expect(panelTab()).toBe('lyrics');
    unmount();

    storeMock.state.playback.currentTrack = storeMock.libTrack;
    render(() => <SearchPanel />);
    expect(screen.getByRole('tab', { name: 'Lyrics' })).toHaveAttribute('aria-selected', 'true');
  });
});
