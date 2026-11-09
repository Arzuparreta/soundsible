import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Album from './Album';
import { setLocale } from '../lib/i18n';
import { trackCount } from '../lib/format';
import type { AlbumProfile, CatalogItem, Track } from '../types/music';

const apiMock = vi.hoisted(() => ({
  getAlbumProfile: vi.fn(),
  getLibraryAlbum: vi.fn(),
  resolveCatalogItem: vi.fn(),
  saveCatalogItem: vi.fn(),
}));
const storeMock = vi.hoisted(() => ({
  library: [] as Array<Record<string, unknown>>,
  playFrom: vi.fn(),
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
vi.mock('../lib/toast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(() => ({ update: vi.fn() })) },
}));
vi.mock('../stores', async () => {
  const { identityMock } = await import('../lib/identityMock');
  return {
    actions: {
      playFrom: (...args: unknown[]) => storeMock.playFrom(...args),
      playShuffled: vi.fn(),
      playTrack: vi.fn(),
      linkCatalogItem: vi.fn(),
    },
    state: {
      get library() { return storeMock.library; },
      autoMode: { active: false },
      playback: { currentTrack: null, queue: [] },
    },
    musicLibrary: () => storeMock.library,
    ...identityMock({ currentTrack: () => null, library: () => storeMock.library as unknown as Track[] }),
  };
});

const song = (n: number): CatalogItem => ({
  id: `deezer:track:${n}`, type: 'track', source: 'deezer', title: `Catalog song ${n}`, subtitle: 'Band',
  artist: 'Band', album: 'Record', duration: 180, cover: '', popularity: 1, track_id: null, external_ids: {},
  attribution_url: '', raw: {},
  action_state: { in_library: false, playable: false, downloadable: true, needs_resolution: true },
});

function profile(over: Partial<AlbumProfile> = {}): AlbumProfile {
  return {
    title: 'Record', artist: 'Band', cover: '', year: 2010, deezer_id: '9',
    tracklist: Array.from({ length: 12 }, (_, i) => song(i + 1)),
    in_library: true, resolved: true, partial_failures: [], cached: false,
    ...over,
  };
}

const owned = [
  { id: 'l1', title: 'Owned one', artist: 'Band', album: 'Record' },
  { id: 'l2', title: 'Owned two', artist: 'Band', album: 'Record' },
];
const libraryAlbum = { id: 'al-1', title: 'Record', album_artist: 'Band', is_compilation: false, track_count: 2, duration: 400, cover_track_id: 'l1', year: 2010 };

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(() => <Router><Route path="/album/:name" component={Album} /></Router>);
}

function navigateTo(path: string) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const headerCover = () => document.querySelector('[data-testid="collection-header-cover"] img');

describe('Album route', () => {
  beforeEach(() => {
    setLocale('en');
    vi.clearAllMocks();
    storeMock.library = owned;
  });

  it('keeps a library link on its library tab when the membership read fails, and retries the same id', async () => {
    // The failed read used to become "not in the library": the toggle vanished
    // and the record fell to its catalogue listing.
    apiMock.getAlbumProfile.mockResolvedValue(profile());
    apiMock.getLibraryAlbum.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ album: libraryAlbum, track_ids: ['l1', 'l2'] });

    renderAt('/album/Record?artist=Band&view=library&album_id=al-1');

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('combobox', { name: 'Shown content' })).toHaveValue('library');
    expect(screen.queryByText('Catalog song 1')).toBeNull();
    // A matching title is not evidence of membership when the link named the record.
    expect(screen.queryByText('Owned one')).toBeNull();

    fireEvent.click(retry);
    await screen.findByText('Owned one');
    expect(apiMock.getLibraryAlbum.mock.calls.map(([id]) => id)).toEqual(['al-1', 'al-1']);
  });

  it('counts the songs of the tab it shows', async () => {
    // The header always counted the catalogue listing, even over a library
    // copy holding two of its twelve songs.
    apiMock.getAlbumProfile.mockResolvedValue(profile());
    apiMock.getLibraryAlbum.mockResolvedValue({ album: libraryAlbum, track_ids: ['l1', 'l2'] });

    renderAt('/album/Record?artist=Band&view=library&album_id=al-1');

    await screen.findByText('Owned one');
    expect(screen.getByText(trackCount(2))).toBeInTheDocument();
    expect(screen.queryByText(trackCount(12))).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Shown content' }), { target: { value: 'discover' } });
    expect(await screen.findByText(trackCount(12))).toBeInTheDocument();
    expect(screen.getByText('Catalog song 1')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Shown content' })).toHaveValue('discover');
    // Changing the shown mode is not a reason to ask the catalogue again.
    expect(apiMock.getAlbumProfile).toHaveBeenCalledTimes(1);
  });

  it('does not carry the previous catalog record metadata into a name-only link', async () => {
    storeMock.library = [...owned, { id: 'l3', title: 'Different owned', artist: 'Band', album: 'Different' }];
    apiMock.getAlbumProfile.mockImplementation((title: string) => Promise.resolve(profile({ title, year: undefined })));
    apiMock.getLibraryAlbum.mockResolvedValue({
      album: { ...libraryAlbum, album_artist_id: 'previous-artist' }, track_ids: ['l1', 'l2'],
    });
    renderAt('/album/Record?artist=Band&view=library&album_id=al-1');
    await screen.findByText('Owned one');
    expect(screen.getByText('2010')).toBeInTheDocument();
    expect(headerCover()?.getAttribute('src')).toContain('/cover/l1');

    navigateTo('/album/Different?artist=Band&view=library');

    await screen.findByText('Different owned');
    expect(screen.queryByText('2010')).toBeNull();
    expect(headerCover()?.getAttribute('src')).toContain('/cover/l3');
    expect(document.querySelector('header a[href*="artist_id=previous-artist"]')).toBeNull();
    expect(apiMock.getLibraryAlbum).toHaveBeenCalledTimes(1);
  });

  it('does not carry a failed catalog read into a name-only library link', async () => {
    apiMock.getAlbumProfile.mockResolvedValue(profile());
    apiMock.getLibraryAlbum.mockRejectedValue(new Error('offline'));
    renderAt('/album/Record?artist=Band&view=library&album_id=al-1');
    await screen.findByRole('button', { name: 'Retry' });

    navigateTo('/album/Record?artist=Band&view=library');

    await screen.findByText('Owned one');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(apiMock.getLibraryAlbum).toHaveBeenCalledTimes(1);
  });

  it('shows the owned sleeve when the catalogue cannot be reached', async () => {
    apiMock.getAlbumProfile.mockRejectedValue(new Error('offline'));
    apiMock.getLibraryAlbum.mockResolvedValue({ album: libraryAlbum, track_ids: ['l1', 'l2'] });

    renderAt('/album/Record?artist=Band&view=library&album_id=al-1');

    await screen.findByText('Owned one');
    await waitFor(() => expect(headerCover()?.getAttribute('src')).toContain('/cover/l1'));
  });

  it('keeps the primary command visible and management in its menu', async () => {
    apiMock.getAlbumProfile.mockResolvedValue(profile({ in_library: false }));
    storeMock.library = [];

    renderAt('/album/Record?artist=Band&view=discover');

    await screen.findByText('Catalog song 1');
    const play = screen.getByRole('button', { name: 'Play' });
    const options = screen.getByRole('button', { name: 'Options' });
    expect(play.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(options);
    const menu = menuMock.open.mock.calls.at(-1)![0] as { actions: Array<{ label: string }> };
    expect(menu.actions.map(action => action.label)).toEqual(expect.arrayContaining(['Save', 'Shuffle']));
    // The whole title is the heading, never a clipped copy of it.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Record');
  });
});
