import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Search from './Search';
import { setLocale } from '../lib/i18n';

const apiMock = vi.hoisted(() => ({
  searchCatalog: vi.fn(),
  suggestCatalog: vi.fn(),
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

vi.mock('@solidjs/router', () => ({ useNavigate: () => vi.fn() }));
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
vi.mock('../stores', () => ({
  actions: {
    playTrack: vi.fn(),
    loadDownloads: vi.fn(),
  },
  state: {
    library: [],
    playback: {},
    downloads: { queue: [] },
  },
}));

describe('Search route', () => {
  beforeEach(() => {
    setLocale('en');
    vi.useFakeTimers();
    nodeMock.items = [];
    nodeMock.loading = false;
    apiMock.searchCatalog.mockResolvedValue({ items: [], sections: [] });
    apiMock.suggestCatalog.mockResolvedValue([]);
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

    expect(await screen.findByText('Para ti')).toBeInTheDocument();
    expect(screen.getByText('Novedades que parten de tu biblioteca — lo último que añadiste pesa más.')).toBeInTheDocument();
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
});
