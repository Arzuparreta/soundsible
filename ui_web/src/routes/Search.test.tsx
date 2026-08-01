import type { Track } from '../types/music';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Search from './Search';
import { setLocale } from '../lib/i18n';
import { clearSearchCache } from '../lib/searchCache';
import { encodeTrackCapsule } from '../lib/trackShare';

const apiMock = vi.hoisted(() => ({
  searchCatalog: vi.fn(),
  searchYouTube: vi.fn(),
  suggest: vi.fn(),
  peekYouTube: vi.fn(),
  enqueueDownload: vi.fn(),
  emitDiscoveryEvent: vi.fn(),
  resolveCatalogItem: vi.fn(),
  saveCatalogItem: vi.fn(),
  saveDiscoveryTrack: vi.fn(),
  prefetchPreviews: vi.fn(() => Promise.resolve({ status: 'queued' })),
}));
const nodeMock = vi.hoisted(() => ({
  ensureNodeFeed: vi.fn(),
  refreshNodeFeed: vi.fn(),
  items: [] as Array<Record<string, unknown>>,
  loading: false,
}));
const storeMock = vi.hoisted(() => ({
  playTrack: vi.fn(),
  library: [] as Array<Record<string, unknown>>,
}));
const routerMock = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  setParams: vi.fn(),
}));

vi.mock('@solidjs/router', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [routerMock.params, routerMock.setParams],
}));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/nodeDiscover', () => ({
  ensureNodeFeed: nodeMock.ensureNodeFeed,
  refreshNodeFeed: nodeMock.refreshNodeFeed,
  nodeFeed: () => nodeMock.items,
  nodeLoading: () => nodeMock.loading,
}));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('../lib/toast', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => ({ update: vi.fn() })),
  },
}));
vi.mock('../stores', async () => {
  const { identityMock } = await import('../lib/identityMock');
  return {
    actions: {
      playTrack: storeMock.playTrack,
      loadDownloads: vi.fn(),
      linkCatalogItem: vi.fn(),
    },
    state: {
      get library() {
        return storeMock.library;
      },
      playback: { currentTrack: null, queue: [] },
      downloads: { queue: [] },
    },
    ...identityMock({ currentTrack: () => null, library: () => storeMock.library as unknown as Track[] }),
  };
});

describe('Search route', () => {
  beforeEach(() => {
    setLocale('en');
    // Module scope outlives a test the way it outlives a navigation.
    clearSearchCache();
    vi.useFakeTimers();
    nodeMock.items = [];
    nodeMock.loading = false;
    storeMock.library = [];
    routerMock.params = {};
    window.location.hash = '#/search';
    apiMock.searchCatalog.mockResolvedValue({ items: [], sections: [] });
    apiMock.searchYouTube.mockResolvedValue([
      { id: 'abc12345678', title: 'Oliver Heldens Live Set', channel: 'Oliver Heldens', duration: 3600 },
    ]);
    apiMock.suggest.mockResolvedValue([]);
    apiMock.peekYouTube.mockResolvedValue({
      id: 'dQw4w9WgXcQ',
      title: 'Direct Video',
      channel: 'Uploader',
    });
    apiMock.enqueueDownload.mockResolvedValue({ status: 'queued' });
    apiMock.emitDiscoveryEvent.mockResolvedValue({ status: 'ok' });
    apiMock.resolveCatalogItem.mockResolvedValue({});
    apiMock.saveCatalogItem.mockResolvedValue({ status: 'queued' });
    apiMock.saveDiscoveryTrack.mockResolvedValue({ status: 'queued' });
  });

  afterEach(() => {
    setLocale('en');
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('bridges empty Musica results into YouTube search', async () => {
    render(() => <Search />);

    fireEvent.input(screen.getByPlaceholderText('What do you want to play?'), {
      target: { value: 'Oliver Heldens live set' },
    });
    await vi.advanceTimersByTimeAsync(230);

    await screen.findByText('Search on YouTube');
    fireEvent.click(screen.getByText('Search on YouTube'));

    await waitFor(() => expect(apiMock.searchYouTube).toHaveBeenCalledWith('Oliver Heldens live set', expect.any(AbortSignal)));
    expect(await screen.findByText('YouTube results')).toBeInTheDocument();
    expect(screen.getByText('Oliver Heldens Live Set')).toBeInTheDocument();
  });

  it('reconstructs an executed search from route parameters', async () => {
    routerMock.params = { q: 'Boards of Canada', tab: 'album' };
    render(() => <Search />);

    await waitFor(() => expect(apiMock.searchCatalog).toHaveBeenCalledWith(
      'Boards of Canada',
      expect.any(AbortSignal),
    ));
    expect(screen.getByDisplayValue('Boards of Canada')).toBeInTheDocument();
    expect(routerMock.setParams).toHaveBeenCalledWith(
      { q: 'Boards of Canada', domain: undefined, tab: 'album' },
      { replace: true },
    );
  });

  it('renders the complete neutral mixed response in one list', async () => {
    apiMock.searchCatalog.mockResolvedValue({
      items: [
        {
          id: 'youtube:track:one',
          type: 'track',
          source: 'youtube',
          title: 'El Toro Guapo',
          artist: 'El Fary',
          raw: { id: 'video000001', title: 'El Toro Guapo', artist: 'El Fary' },
        },
        {
          id: 'musicbrainz:artist:two',
          type: 'artist',
          source: 'musicbrainz',
          title: 'El Fary',
          subtitle: 'Artist',
        },
        {
          id: 'deezer:track:three',
          type: 'track',
          source: 'deezer',
          title: 'Fari',
          artist: 'Literal Artist',
        },
      ],
      sections: [],
    });
    render(() => <Search />);

    fireEvent.input(screen.getByPlaceholderText('What do you want to play?'), {
      target: { value: 'fari' },
    });
    await vi.advanceTimersByTimeAsync(230);

    expect(await screen.findByText('El Toro Guapo')).toBeInTheDocument();
    expect(screen.getByText('Literal Artist')).toBeInTheDocument();
    expect(screen.getAllByText('El Fary')).toHaveLength(2);
    expect(apiMock.searchYouTube).not.toHaveBeenCalled();
  });

  it('switches tabs by filtering the response it already has', async () => {
    // Every tab used to re-run the whole provider fan-out for a strictly
    // smaller answer than `type=all` had already returned.
    apiMock.searchCatalog.mockResolvedValue({
      items: [
        {
          id: 'deezer:track:one',
          type: 'track',
          source: 'deezer',
          title: 'Previous song',
          artist: 'Previous artist',
        },
        {
          id: 'deezer:artist:one',
          type: 'artist',
          source: 'deezer',
          title: 'Previous artist',
          subtitle: 'Artist',
        },
      ],
      sections: [
        { id: 'songs', layout: 'rows', item_ids: ['deezer:track:one'], total: 1 },
        { id: 'artists', layout: 'grid_round', item_ids: ['deezer:artist:one'], total: 1 },
      ],
    });
    render(() => <Search />);

    fireEvent.input(screen.getByPlaceholderText('What do you want to play?'), {
      target: { value: 'previous' },
    });
    await vi.advanceTimersByTimeAsync(230);
    expect(await screen.findByText('Previous song')).toBeInTheDocument();
    expect(apiMock.searchCatalog).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: 'Artists' }));

    expect(await screen.findByText('Previous artist')).toBeInTheDocument();
    expect(screen.queryByText('Previous song')).not.toBeInTheDocument();
    expect(apiMock.searchCatalog).toHaveBeenCalledTimes(1);
    expect(routerMock.setParams).toHaveBeenLastCalledWith(
      { q: 'previous', domain: undefined, tab: 'artist' },
      { replace: true },
    );
  });

  it('leads with the top result the server picked, above a capped songs list', async () => {
    apiMock.searchCatalog.mockResolvedValue({
      top_result: 'deezer:artist:one',
      items: [
        {
          id: 'deezer:artist:one',
          type: 'artist',
          source: 'deezer',
          title: 'Radiohead',
          subtitle: 'Artist',
        },
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `deezer:track:${i}`,
          type: 'track',
          source: 'deezer',
          title: `Song ${i}`,
          artist: 'Radiohead',
        })),
      ],
      sections: [
        { id: 'top', layout: 'hero', item_ids: ['deezer:artist:one'], total: 1 },
        {
          id: 'songs',
          layout: 'rows',
          item_ids: Array.from({ length: 8 }, (_, i) => `deezer:track:${i}`),
          total: 61,
        },
      ],
    });
    render(() => <Search />);

    fireEvent.input(screen.getByPlaceholderText('What do you want to play?'), {
      target: { value: 'radiohead' },
    });
    await vi.advanceTimersByTimeAsync(230);

    expect(await screen.findByText('Top result')).toBeInTheDocument();
    // The card says *what kind of thing* it is — that is the whole point of it.
    expect(screen.getByText('Artist')).toBeInTheDocument();
    expect(screen.getAllByText('Radiohead').length).toBeGreaterThan(0);
    // Five of the eight, with the count from the server's pre-cap total.
    expect(screen.getByText('Song 4')).toBeInTheDocument();
    expect(screen.queryByText('Song 5')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'See all 61 songs' }));

    expect(await screen.findByText('Song 5')).toBeInTheDocument();
    expect(apiMock.searchCatalog).toHaveBeenCalledTimes(1);
  });

  it('renders sections in the order the server sent them', async () => {
    // An album search leads with albums; the client used to hardcode
    // songs -> artists -> albums regardless of what was asked for.
    apiMock.searchCatalog.mockResolvedValue({
      items: [
        { id: 'deezer:album:1', type: 'album', source: 'deezer', title: 'In Rainbows', subtitle: 'Radiohead' },
        { id: 'deezer:artist:1', type: 'artist', source: 'deezer', title: 'Radiohead', subtitle: 'Artist' },
      ],
      sections: [
        { id: 'albums', layout: 'grid', item_ids: ['deezer:album:1'], total: 1 },
        { id: 'artists', layout: 'grid_round', item_ids: ['deezer:artist:1'], total: 1 },
      ],
    });
    render(() => <Search />);

    fireEvent.input(screen.getByPlaceholderText('What do you want to play?'), {
      target: { value: 'in rainbows' },
    });
    await vi.advanceTimersByTimeAsync(230);

    await screen.findByText('In Rainbows');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((el) => el.textContent);
    expect(headings).toEqual(['Albums', 'Artists']);
  });

  it('uses a round card skeleton for a cold Artists tab', async () => {
    apiMock.searchCatalog.mockImplementation(() => new Promise(() => {}));
    routerMock.params = { q: 'artist query', tab: 'artist' };
    render(() => <Search />);

    await vi.advanceTimersByTimeAsync(230);

    expect(document.querySelector('[data-shape="round"]')).toBeInTheDocument();
  });

  it('renders the node feed as the empty search state', async () => {
    setLocale('es');
    nodeMock.items = [
      {
        id: 'rec00000001',
        title: 'New Track',
        channel: 'New Artist',
        seedId: 'lib1',
        seedTitle: 'Seed Song',
        seedArtist: 'Seed Artist',
      },
    ];

    render(() => <Search />);

    expect(await screen.findByText('Recomendaciones')).toBeInTheDocument();
    expect(screen.getByText('New Track')).toBeInTheDocument();
    expect(nodeMock.ensureNodeFeed).toHaveBeenCalled();
  });

  it('treats pasted YouTube URLs as exact YouTube items', async () => {
    render(() => <Search />);

    fireEvent.input(screen.getByPlaceholderText('What do you want to play?'), {
      target: { value: 'https://youtu.be/dQw4w9WgXcQ?t=42' },
    });
    await vi.advanceTimersByTimeAsync(230);

    await waitFor(() =>
      expect(apiMock.peekYouTube).toHaveBeenCalledWith('https://www.youtube.com/watch?v=dQw4w9WgXcQ', expect.any(AbortSignal)),
    );
    expect(await screen.findByText('Detected video')).toBeInTheDocument();
    expect(screen.getByText('Direct Video')).toBeInTheDocument();
    expect(apiMock.searchCatalog).not.toHaveBeenCalled();
  });

  it('opens a shared identity as the only result and plays the recipient preview', async () => {
    const encoded = encodeTrackCapsule({
      v: 1,
      kind: 'music',
      yt: 'dQw4w9WgXcQ',
      title: 'Shared title',
      artist: 'Shared artist',
    });
    window.location.hash = `#/search?shared=${encoded}`;

    render(() => <Search />);

    expect(await screen.findByText('Shared with you')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Shared title — Shared artist')).toBeInTheDocument();
    expect(screen.getByText('Direct Video')).toBeInTheDocument();
    expect(apiMock.searchCatalog).not.toHaveBeenCalled();
    expect(apiMock.searchYouTube).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Direct Video'));
    expect(storeMock.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dQw4w9WgXcQ', source: 'preview' }),
    );
  });

  it('reuses the local track only when youtube_id matches exactly', async () => {
    storeMock.library = [
      {
        id: 'local-track',
        title: 'My local title',
        artist: 'My local artist',
        youtube_id: 'dQw4w9WgXcQ',
      },
    ];
    const encoded = encodeTrackCapsule({
      v: 1,
      kind: 'music',
      yt: 'dQw4w9WgXcQ',
      title: 'Shared title',
      artist: 'Shared artist',
    });
    window.location.hash = `#/search?shared=${encoded}`;

    render(() => <Search />);
    fireEvent.click(await screen.findByText('My local title'));

    expect(apiMock.peekYouTube).not.toHaveBeenCalled();
    expect(storeMock.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local-track', youtube_id: 'dQw4w9WgXcQ' }),
    );
  });

  it('shows an exact-version error without substituting search results', async () => {
    apiMock.peekYouTube.mockResolvedValue(null);
    const encoded = encodeTrackCapsule({
      v: 1,
      kind: 'music',
      yt: 'dQw4w9WgXcQ',
      title: 'Gone',
      artist: 'Artist',
    });
    window.location.hash = `#/search?shared=${encoded}`;

    render(() => <Search />);

    expect(await screen.findByText(/exact shared version is unavailable/i)).toBeInTheDocument();
    expect(apiMock.searchCatalog).not.toHaveBeenCalled();
    expect(apiMock.searchYouTube).not.toHaveBeenCalled();
  });
});
