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
}));
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => ({ update: vi.fn() })),
}));
const discoverMock = vi.hoisted(() => ({
  ensureDiscover: vi.fn(),
  items: [] as Array<Record<string, unknown>>,
  sections: [] as Array<Record<string, unknown>>,
}));
const storeMock = vi.hoisted(() => {
  const libTrack: Track = { id: 'lib1', title: 'Local Song', artist: 'Local Artist' };
  return {
    libTrack,
    state: {
      library: [libTrack] as Track[],
      playback: { queue: [] as Track[], index: -1, currentTrack: null as Track | null },
      downloads: { queue: [] },
    },
    actions: {
      playNow: vi.fn(),
      enqueue: vi.fn(),
      playTrack: vi.fn(),
    },
  };
});

vi.mock('@solidjs/router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('../lib/toast', () => ({ toast: toastMock }));
vi.mock('../lib/discover', () => ({
  ensureDiscover: discoverMock.ensureDiscover,
  feedItems: () => discoverMock.items,
  feedSections: () => discoverMock.sections,
  revalidating: () => false,
}));
vi.mock('../stores', () => ({ state: storeMock.state, actions: storeMock.actions }));
vi.mock('./trackActions', () => ({ openTrackMenu: vi.fn() }));
vi.mock('./PlaylistPicker', () => ({ openPlaylistPicker: vi.fn() }));
vi.mock('./MetadataEditor', () => ({ openMetadataEditor: vi.fn() }));
vi.mock('./DeviceSheet', () => ({ openPlayOnDevice: vi.fn() }));

import { SearchPanel } from './SearchPanel';
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
    storeMock.state.playback.queue = [];
    storeMock.state.playback.currentTrack = null;
    discoverMock.items = [];
    discoverMock.sections = [];
    apiMock.searchCatalog.mockResolvedValue({ items: [], sections: [] });
    apiMock.searchYouTube.mockResolvedValue([]);
    apiMock.peekYouTube.mockResolvedValue(null);
    apiMock.resolveCatalogItem.mockResolvedValue({});
    apiMock.emitDiscoveryEvent.mockResolvedValue({ status: 'ok' });
  });

  afterEach(() => {
    setLocale('en');
    vi.clearAllMocks();
  });

  it('shows discovery rails as the empty state', async () => {
    setLocale('es');
    discoverMock.items = [
      { id: 'd1', title: 'Fresh Track', artist: 'New Artist', source: 'deezer_chart', deezer_id: '1' },
    ];
    discoverMock.sections = [{ id: 'because_you_listen_rosalia', title: 'More like Rosalía', item_ids: ['d1'] }];

    render(() => <SearchPanel />);

    expect(await screen.findByText('Más como Rosalía')).toBeInTheDocument();
    expect(screen.getByText('Fresh Track')).toBeInTheDocument();
    expect(discoverMock.ensureDiscover).toHaveBeenCalled();
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
});
