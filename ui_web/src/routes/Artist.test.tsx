import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Artist from './Artist';
import { setLocale } from '../lib/i18n';
import type { ArtistProfile, Track } from '../types/music';
import { mockScrollportLayout } from '../testLayout';

mockScrollportLayout();

const apiMock = vi.hoisted(() => ({
  getArtistProfile: vi.fn(),
  getLibraryArtist: vi.fn(),
  resolveCatalogItem: vi.fn(),
  saveCatalogItem: vi.fn(),
}));
const storeMock = vi.hoisted(() => ({
  library: [] as Array<Record<string, unknown>>,
  playFrom: vi.fn(),
  playShuffled: vi.fn(),
  playTrack: vi.fn(),
  startRadio: vi.fn(),
  enterAutoMode: vi.fn(),
  startDjSelection: vi.fn(),
  beginAutoSessionChange: vi.fn(() => 1),
  autoSessionToken: vi.fn(() => 1),
  autoModeActive: false,
  currentTrack: null as Record<string, unknown> | null,
}));
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => ({ update: vi.fn(), dismiss: vi.fn() })),
}));

vi.mock('../lib/api', () => ({ api: apiMock }));
const menuMock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../components/ActionMenu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../components/ActionMenu')>()),
  openActionMenu: (...args: unknown[]) => menuMock.open(...args),
}));
vi.mock('../lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/media')>()),
  coverUrl: (id: string) => `/cover/${id}`,
}));
vi.mock('../lib/toast', () => ({ toast: toastMock }));
vi.mock('../stores', async () => {
  const { identityMock } = await import('../lib/identityMock');
  return {
    actions: {
      playFrom: (...args: unknown[]) => storeMock.playFrom(...args),
      playShuffled: (...args: unknown[]) => storeMock.playShuffled(...args),
      playTrack: (...args: unknown[]) => storeMock.playTrack(...args),
      startRadio: (...args: unknown[]) => storeMock.startRadio(...args),
      enterAutoMode: (...args: unknown[]) => { storeMock.autoModeActive = true; return storeMock.enterAutoMode(...args); },
      startDjSelection: (...args: unknown[]) => storeMock.startDjSelection(...args),
      beginAutoSessionChange: () => storeMock.beginAutoSessionChange(),
      autoSessionToken: () => storeMock.autoSessionToken(),
      linkCatalogItem: vi.fn(),
    },
    state: {
      get library() {
        return storeMock.library;
      },
      autoMode: {
        get active() { return storeMock.autoModeActive; },
      },
      playback: {
        get currentTrack() { return storeMock.currentTrack; },
        queue: [],
      },
    },
    musicLibrary: () => storeMock.library,
    ...identityMock({ currentTrack: () => null, library: () => storeMock.library as unknown as Track[] }),
  };
});

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
    storeMock.autoModeActive = false;
    storeMock.currentTrack = null;
  });

  it('removes the previous artist content while a new profile is pending', async () => {
    apiMock.getArtistProfile.mockResolvedValueOnce(profileFor('First', false))
      .mockImplementationOnce(() => new Promise(() => {}));
    renderAt('/artist/First?view=discover');
    await screen.findByText('First Hit');
    await navigateTo('/artist/Second?view=discover');
    await waitFor(() => expect(screen.queryByText('First Hit')).toBeNull());
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
  });

  it('renders local tracks without waiting for the external profile', async () => {
    storeMock.library = [{ id: 'l1', title: 'Already owned', artist: 'Owned Artist', album: 'A' }];
    apiMock.getArtistProfile.mockImplementationOnce(() => new Promise(() => {}));
    renderAt('/artist/Owned%20Artist?view=library');
    expect(screen.getByText('Already owned')).toBeInTheDocument();
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
    // track, which evicted whichever owned track sorted first. The tapped row
    // plays from its own place, so the owned song above it stays where it was.
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

    screen.getByRole('button', { name: 'Fresh Hit' }).click();

    await waitFor(() => expect(storeMock.playFrom).toHaveBeenCalled());
    const [queue, index, opts] = storeMock.playFrom.mock.calls.at(-1)!;
    expect(index).toBe(1);
    expect((queue as Array<{ id: string }>).map((tr) => tr.id)).toEqual(['l1', 'vid-fresh']);
    // The card in the queue leads back to this page, on the tab it was played from.
    expect((opts as { context: { destination?: string } }).context.destination)
      .toBe('/artist/Mixed?view=discover&deezer_id=1');
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

  it('keeps a library link on its library tab when the membership read fails, and retries the same id', async () => {
    // The failed read used to become an empty list: the toggle vanished and the
    // page fell to Discover, as though the user owned nothing by this artist.
    storeMock.library = [{ id: 'l1', title: 'Owned', artist: 'Someone Else', album: 'A' }];
    apiMock.getArtistProfile.mockResolvedValue(profileFor('Owned Artist', true));
    apiMock.getLibraryArtist.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ artist: { id: 'ar-1', name: 'Owned Artist' }, track_ids: ['l1'] });

    renderAt('/artist/Owned%20Artist?view=library&artist_id=ar-1');

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('combobox', { name: 'Shown content' })).toHaveValue('library');
    // Neither the catalogue listing nor a guess by name stands in for the answer.
    expect(screen.queryByText('Owned Artist Hit')).toBeNull();
    expect(screen.queryByText('Owned')).toBeNull();

    fireEvent.click(retry);
    await screen.findByText('Owned');
    expect(apiMock.getLibraryArtist.mock.calls.map(([id]) => id)).toEqual(['ar-1', 'ar-1']);
    expect(screen.getByRole('option', { name: 'My library (1)' })).toHaveProperty('selected', true);
  });

  it('does not carry a failed catalog read into a name-only library link', async () => {
    storeMock.library = [{ id: 'l1', title: 'Already owned', artist: 'Second', album: 'A' }];
    apiMock.getArtistProfile.mockImplementation((name: string) => Promise.resolve(profileFor(name, true)));
    apiMock.getLibraryArtist.mockRejectedValue(new Error('offline'));
    renderAt('/artist/First?view=library&artist_id=ar-1');
    await screen.findByRole('button', { name: 'Retry' });

    await navigateTo('/artist/Second?view=library');

    await screen.findByText('Already owned');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(apiMock.getLibraryArtist).toHaveBeenCalledTimes(1);
  });

  it('still leaves the library tab when the engine answers that nothing is owned', async () => {
    apiMock.getArtistProfile.mockResolvedValue(profileFor('Former', false));
    apiMock.getLibraryArtist.mockResolvedValue({ artist: { id: 'ar-2', name: 'Former' }, track_ids: [] });

    renderAt('/artist/Former?view=library&artist_id=ar-2');

    await screen.findByText('Former Hit');
    expect(screen.queryByRole('combobox', { name: 'Shown content' })).toBeNull();
  });

  it('puts listening first and offers other matches in the shared sheet', async () => {
    const profile = profileFor('Twin', false);
    profile.candidates = [{ deezer_id: '7', name: 'Twin (band)', picture: '', nb_fans: 1200 }];
    apiMock.getArtistProfile.mockResolvedValue(profile);

    renderAt('/artist/Twin?view=discover');
    await screen.findByText('Twin Hit');

    const play = screen.getByRole('button', { name: 'Play' });
    const options = screen.getByRole('button', { name: 'Options' });
    const pin = screen.getByRole('button', { name: 'Add to bookmarks' });
    expect(pin).toHaveAttribute('title', 'Add to bookmarks');
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    expect(pin.textContent?.trim()).toBe('');
    expect(play.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(options);
    expect(menuMock.open).toHaveBeenCalledTimes(1);
    const first = menuMock.open.mock.calls[0][0] as { actions: Array<{ label: string; onSelect: () => void }> };
    expect(first.actions.some(action => /bookmark|save/i.test(action.label))).toBe(false);
    first.actions.find(action => action.label === 'Not this artist?')!.onSelect();
    const [{ actions }] = menuMock.open.mock.calls[1] as [{ actions: Array<{ label: string; onSelect: () => void }> }];
    expect(actions.map((action) => action.label)).toEqual(['Twin (band) · 1.2K fans']);
    actions[0].onSelect();
    await waitFor(() => expect(window.location.search).toContain('deezer_id=7'));
  });

  it('switches mode without fetching the profile again', async () => {
    // A fresh resource key per query-string write refetched the profile and
    // replaced the page with a skeleton under the tap.
    storeMock.library = [{ id: 'l1', title: 'Owned', artist: 'Owned Artist', album: 'A' }];
    apiMock.getArtistProfile.mockResolvedValue(profileFor('Owned Artist', true));

    renderAt('/artist/Owned%20Artist?view=library');
    await screen.findByText('Owned');
    fireEvent.change(screen.getByRole('combobox', { name: 'Shown content' }), { target: { value: 'discover' } });

    await screen.findByText('Owned Artist Hit');
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(apiMock.getArtistProfile).toHaveBeenCalledTimes(1);
  });

  it('shows latest release spotlight, starts artist radio, and starts a DJ session from options', async () => {
    const profile = profileFor('Daft Punk', false);
    profile.latest_release = { deezer_id: '77', title: 'Latest Single', cover: '', year: 2025, release_date: '2025-09-01', record_type: 'single' };
    apiMock.getArtistProfile.mockResolvedValue(profile);
    apiMock.resolveCatalogItem.mockResolvedValue({ video_id: 'vid-dp-1' });

    renderAt('/artist/Daft%20Punk?view=discover');
    await screen.findByText('Daft Punk Hit');

    expect(screen.getByRole('heading', { name: 'Latest release' })).toBeInTheDocument();
    expect(screen.getByText('Latest Single')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start radio' }));
    await waitFor(() => expect(storeMock.startRadio).toHaveBeenCalledWith(expect.objectContaining({ id: 'vid-dp-1', title: 'Daft Punk Hit' })));

    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    const menu = menuMock.open.mock.calls.at(-1)![0] as { actions: Array<{ label: string; onSelect: () => void }> };
    const startDj = menu.actions.find(action => action.label === 'Start a DJ session');
    expect(startDj).toBeDefined();
    startDj!.onSelect();

    await waitFor(() => expect(storeMock.enterAutoMode).toHaveBeenCalledWith(expect.objectContaining({ deferPlanning: true })));
    await waitFor(() => expect(storeMock.startDjSelection).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'vid-dp-1', title: 'Daft Punk Hit' })],
      'Daft Punk',
    ));
  });

  it('falls back past an unresolvable first track for Radio and DJ, and surfaces podcast/library errors', async () => {
    const profile = profileFor('Daft Punk', false);
    profile.top_tracks = [
      { ...profile.top_tracks[0], id: 'deezer:track:bad', title: 'Broken Track' },
      { ...profile.top_tracks[0], id: 'deezer:track:good', title: 'Working Track' },
    ];
    apiMock.getArtistProfile.mockResolvedValue(profile);
    apiMock.resolveCatalogItem.mockImplementation(({ title }: { title: string }) =>
      title === 'Broken Track' ? Promise.resolve({}) : Promise.resolve({ video_id: 'vid-good' }),
    );

    renderAt('/artist/Daft%20Punk?view=discover');
    await screen.findByText('Working Track');

    fireEvent.click(screen.getByRole('button', { name: 'Start radio' }));
    await waitFor(() => expect(storeMock.startRadio).toHaveBeenCalledWith(expect.objectContaining({ id: 'vid-good', title: 'Working Track' })));

    storeMock.currentTrack = { id: 'ep-1', title: 'Episode', artist: 'Show', media_kind: 'podcast_episode' };
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    const podcastMenu = menuMock.open.mock.calls.at(-1)![0] as { actions: Array<{ label: string; disabled?: boolean; onSelect: () => void }> };
    const disabledDj = podcastMenu.actions.find(action => action.label === 'Start a DJ session');
    expect(disabledDj?.disabled).toBe(true);
    disabledDj!.onSelect();
    expect(toastMock.info).toHaveBeenCalledWith('DJ only mixes music. Playing this podcast will end the DJ session.');
    expect(storeMock.enterAutoMode).not.toHaveBeenCalled();

    storeMock.currentTrack = null;
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    const djMenu = menuMock.open.mock.calls.at(-1)![0] as { actions: Array<{ label: string; onSelect: () => void }> };
    djMenu.actions.find(action => action.label === 'Start a DJ session')!.onSelect();
    await waitFor(() => expect(storeMock.startDjSelection).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'vid-good', title: 'Working Track' })],
      'Daft Punk',
    ));
  });

  it('re-enables Start radio when a DJ start makes the pending radio start stale', async () => {
    apiMock.getArtistProfile.mockResolvedValue(profileFor('Daft Punk', false));
    let finishRadioResolve: (value: unknown) => void = () => {};
    apiMock.resolveCatalogItem
      .mockImplementationOnce(() => new Promise(resolve => { finishRadioResolve = resolve; }))
      .mockResolvedValue({ video_id: 'vid-dp-1' });

    renderAt('/artist/Daft%20Punk?view=discover');
    await screen.findByText('Daft Punk Hit');

    const radio = screen.getByRole('button', { name: 'Start radio' });
    fireEvent.click(radio);
    await waitFor(() => expect(radio).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    const menu = menuMock.open.mock.calls.at(-1)![0] as { actions: Array<{ label: string; onSelect: () => void }> };
    menu.actions.find(action => action.label === 'Start a DJ session')!.onSelect();
    await waitFor(() => expect(storeMock.startDjSelection).toHaveBeenCalled());

    finishRadioResolve({ video_id: 'vid-late' });
    await waitFor(() => expect(radio).not.toBeDisabled());
    expect(storeMock.startRadio).not.toHaveBeenCalled();
  });

  it('catches library Start radio errors with a toast instead of an unhandled rejection', async () => {
    storeMock.library = [{ id: 'l1', title: 'Owned', artist: 'Owned Artist', album: 'A' }];
    storeMock.startRadio.mockRejectedValueOnce(new Error('offline'));
    apiMock.getArtistProfile.mockResolvedValue(profileFor('Owned Artist', true));

    renderAt('/artist/Owned%20Artist?view=library');
    await screen.findByText('Owned');
    fireEvent.click(screen.getByRole('button', { name: 'Start radio' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
  });
});
