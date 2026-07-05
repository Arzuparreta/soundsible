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
const discoverMock = vi.hoisted(() => ({
  ensureDiscover: vi.fn(),
  refreshDiscover: vi.fn(),
  items: [] as Array<Record<string, unknown>>,
  sections: [] as Array<Record<string, unknown>>,
  revalidating: false,
}));

vi.mock('@solidjs/router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/discover', () => ({
  ensureDiscover: discoverMock.ensureDiscover,
  refreshDiscover: discoverMock.refreshDiscover,
  feedItems: () => discoverMock.items,
  feedSections: () => discoverMock.sections,
  revalidating: () => discoverMock.revalidating,
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
    discoverMock.items = [];
    discoverMock.sections = [];
    discoverMock.revalidating = false;
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

  it('renders discovery rails as the empty search state', async () => {
    setLocale('es');
    discoverMock.items = [
      {
        id: 'deezer:1',
        title: 'New Track',
        artist: 'New Artist',
        source: 'deezer_chart',
        deezer_id: '1',
        action_state: { needs_resolution: true },
      },
    ];
    discoverMock.sections = [{
      id: 'because_you_listen_rosalia',
      title: 'More like Rosalía',
      reason: 'Based on artists you play, save, favourite, or collect in playlists.',
      item_ids: ['deezer:1'],
    }];

    render(() => <Search />);

    expect(await screen.findByText('Más como Rosalía')).toBeInTheDocument();
    expect(screen.getByText('Basado en los artistas que escuchas, guardas, marcas como favoritos o añades a listas.')).toBeInTheDocument();
    expect(screen.getByText('New Track')).toBeInTheDocument();
    expect(discoverMock.ensureDiscover).toHaveBeenCalled();
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
