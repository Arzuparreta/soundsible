import { render, screen, waitFor } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Artist from './Artist';
import { setLocale } from '../lib/i18n';
import type { ArtistProfile } from '../types/music';

const apiMock = vi.hoisted(() => ({
  getArtistProfile: vi.fn(),
  resolveCatalogItem: vi.fn(),
  saveCatalogItem: vi.fn(),
}));
const storeMock = vi.hoisted(() => ({
  library: [] as Array<Record<string, unknown>>,
  playFrom: vi.fn(),
  playShuffled: vi.fn(),
  playTrack: vi.fn(),
}));

vi.mock('../lib/api', () => ({ api: apiMock }));
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
    playFrom: (...args: unknown[]) => storeMock.playFrom(...args),
    playShuffled: (...args: unknown[]) => storeMock.playShuffled(...args),
    playTrack: (...args: unknown[]) => storeMock.playTrack(...args),
  },
  state: {
    get library() {
      return storeMock.library;
    },
    playback: { currentTrack: null },
  },
  musicLibrary: () => storeMock.library,
}));

function profileFor(name: string, inLibrary: boolean): ArtistProfile {
  return {
    name,
    resolved: true,
    deezer_id: '1',
    metadata: { name, picture: '', nb_fans: 10 },
    candidates: [],
    top_tracks: [
      {
        id: `deezer:track:${name}`,
        type: 'track',
        source: 'deezer',
        title: `${name} Hit`,
        subtitle: name,
        artist: name,
        album: 'Some Album',
        duration: 180,
        cover: '',
        popularity: 1,
        track_id: null,
        external_ids: {},
        attribution_url: '',
        action_state: { in_library: false, playable: false, downloadable: true, needs_resolution: true },
        raw: {},
      },
    ],
    albums: [],
    singles_eps: [],
    related_artists: [],
    in_library: inLibrary,
    partial_failures: [],
    cached: false,
  };
}

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(() => (
    <Router>
      <Route path="/artist/:name" component={Artist} />
    </Router>
  ));
}

async function navigateTo(path: string) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

describe('Artist route view mode', () => {
  beforeEach(() => {
    setLocale('en');
    vi.clearAllMocks();
    storeMock.library = [];
  });

  it('honours ?view=library for an artist in the library', async () => {
    storeMock.library = [{ id: 'l1', title: 'Owned', artist: 'Owned Artist', album: 'A' }];
    apiMock.getArtistProfile.mockResolvedValue(profileFor('Owned Artist', true));

    renderAt('/artist/Owned%20Artist?view=library');

    await waitFor(() => expect(screen.getByText('Owned')).toBeInTheDocument());
  });

  it('does not carry a library tab onto the next artist, who has no toggle', async () => {
    // The trap: the router reuses this component across :name changes, so a tab
    // held in a mount-seeded signal survived navigation. Landing on an artist
    // the user does not own hides the toggle, leaving no way back to discover.
    storeMock.library = [{ id: 'l1', title: 'Owned', artist: 'Owned Artist', album: 'A' }];
    apiMock.getArtistProfile.mockImplementation((name: string) =>
      Promise.resolve(profileFor(name, name === 'Owned Artist')),
    );

    renderAt('/artist/Owned%20Artist?view=library');
    await waitFor(() => expect(screen.getByText('Owned')).toBeInTheDocument());

    await navigateTo('/artist/Stranger?view=discover');

    // The new artist's discover content must render...
    await waitFor(() => expect(screen.getByText('Stranger Hit')).toBeInTheDocument());
    // ...and the previous artist's library track must be gone.
    expect(screen.queryByText('Owned')).not.toBeInTheDocument();
  });

  it('keeps owned tracks in the queue when playing an unowned top track', async () => {
    // The queue used to be built by overwriting index 0 with the resolved
    // track, which evicted whichever owned track sorted first.
    storeMock.library = [{ id: 'l1', title: 'Owned Hit', artist: 'Mixed', album: 'A', duration: 200 }];
    const profile = profileFor('Mixed', true);
    profile.top_tracks = [
      { ...profile.top_tracks[0], id: 'owned', title: 'Owned Hit', track_id: 'l1' },
      { ...profile.top_tracks[0], id: 'fresh', title: 'Fresh Hit', track_id: null },
    ];
    apiMock.getArtistProfile.mockResolvedValue(profile);
    apiMock.resolveCatalogItem.mockResolvedValue({ video_id: 'vid-fresh' });

    renderAt('/artist/Mixed?view=discover');
    await waitFor(() => expect(screen.getByText('Fresh Hit')).toBeInTheDocument());

    screen.getByText('Fresh Hit').click();

    await waitFor(() => expect(storeMock.playFrom).toHaveBeenCalled());
    const [queue, index] = storeMock.playFrom.mock.calls.at(-1)!;
    expect(index).toBe(0);
    expect((queue as Array<{ id: string }>).map((tr) => tr.id)).toEqual(['vid-fresh', 'l1']);
  });

  it('clamps to discover when a library deep-link lands on an artist not owned', async () => {
    storeMock.library = [];
    apiMock.getArtistProfile.mockResolvedValue(profileFor('Stranger', false));

    renderAt('/artist/Stranger?view=library');

    // No toggle is offered, so the requested library tab must not be honoured —
    // discover content shows instead of an inescapable empty list.
    await waitFor(() => expect(screen.getByText('Stranger Hit')).toBeInTheDocument());
    expect(screen.queryByText('No tracks in your library yet.')).not.toBeInTheDocument();
  });
});
