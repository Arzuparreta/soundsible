import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal, type ComponentProps } from 'solid-js';
import type { AlbumProfile, ArtistProfile, CatalogItem, Track } from '../types/music';
import type { MigrationJob } from '../lib/migrationApi';
import NativeEntityProfile from './EntityProfile';
import { openContextMenu } from '../lib/contextMenu';
import { setLocale } from '../lib/i18n';

const mocks = vi.hoisted(() => ({
  profile: null as AlbumProfile | ArtistProfile | null,
  job: null as MigrationJob | null,
  pending: null as string | null,
  play: vi.fn(), act: vi.fn(), startRadio: vi.fn(), startDj: vi.fn(), save: vi.fn(), download: vi.fn(),
}));
vi.mock('./entityProfile', async original => ({
  ...await original<typeof import('./entityProfile')>(),
  createNativeEntityProfile: () => ({ profile: () => mocks.profile, loading: () => false, error: () => false, retry: vi.fn() }),
}));
vi.mock('./collection', () => ({ createNativeCollection: () => ({ job: () => mocks.job, busy: () => false, error: () => '',
  discography: () => null, saveSongs: mocks.save, download: mocks.download, control: vi.fn(), decide: vi.fn(), retry: vi.fn() }) }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: vi.fn() }));
vi.mock('./entityMarks', () => ({ nativeEntityMark: () => ({ label: 'Save', onSelect: vi.fn() }) }));
vi.mock('../components/MusicListRowView', () => ({ MusicListRowView: (props: { title: string; onActivate: () => void }) => <button onClick={props.onActivate}>{props.title}</button> }));

const items: CatalogItem[] = ['owned', 'stream'].map(id => ({ id, type: 'track', source: 'deezer', title: id, artist: 'Artist' }));
const track: Track = { id: 'local', title: 'owned', artist: 'Artist' };
const catalog = {
  trackFor: (item: CatalogItem) => item.id === 'owned' ? track : undefined,
  pending: () => mocks.pending,
  playCollection: mocks.play,
  act: mocks.act,
  startRadio: mocks.startRadio,
  startDj: mocks.startDj,
  adoptCollection: vi.fn(),
} as unknown as ComponentProps<typeof NativeEntityProfile>['catalog'];

describe('native entity composition', () => {
  beforeEach(() => {
    vi.clearAllMocks(); setLocale('en'); mocks.job = null; mocks.pending = null;
    mocks.profile = { title: 'Record', artist: 'Artist', cover: '', tracklist: items, deezer_id: '7', in_library: true, resolved: true, cached: false };
  });
  function mount() {
    const [view, setView] = createSignal<'discover' | 'library'>('discover');
    return render(() => <NativeEntityProfile view={view()} onViewChange={setView} subject={{ kind: 'album', name: 'Record', artist: 'Artist', deezerId: '7', view: 'discover' }}
      generation={1} disconnected={false} tracks={[track]} catalog={catalog} onBack={vi.fn()} onOpen={vi.fn()} onTrackMenu={vi.fn()}
      onChanged={async () => {}} offlineMenuActions={() => [{ label: 'Keep offline', onSelect: vi.fn() }]} />);
  }
  it('plays the selected view through the native controller without acquiring songs', () => {
    const { container } = mount();
    expect(container.querySelectorAll('[data-entity-toolbar]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(mocks.play).toHaveBeenLastCalledWith(items, 0, { kind: 'album', id: '7' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'library' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(mocks.play.mock.calls.at(-1)?.[0]).toEqual([expect.objectContaining({ track_id: 'local', type: 'library_track' })]);
    expect(mocks.play.mock.calls.at(-1)?.[2]).toEqual({ kind: 'album', id: '7' });
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it('places the bookmark pin in the hero and retains shuffle, bulk song, download and offline operations in options', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Shuffle' })).not.toBeInTheDocument();
    const pin = screen.getByRole('button', { name: 'Add to bookmarks' });
    expect(pin).toHaveAttribute('title', 'Add to bookmarks');
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Options: Record' }));
    const actions = vi.mocked(openContextMenu).mock.calls.at(-1)?.[0].actions ?? [];
    expect(actions.map(action => action.label)).toEqual(expect.arrayContaining(['Shuffle', 'Add all songs', 'Download the album', 'Keep offline']));
    expect(actions.some(action => /bookmark|save/i.test(action.label))).toBe(false);
    actions.find(action => action.label === 'Shuffle')?.onSelect();
    expect(mocks.play).toHaveBeenCalledWith(items, 0, { kind: 'album', id: '7' }, true);
  });
  it('keeps a collection needing review visible in its identity and reachable from options', () => {
    mocks.job = { id: 'job', provider: 'album:7', source_name: 'Record', state: 'completed', selected_track_count: 2,
      manifest: { track_count: 2, library_count: 1, favourite_count: 0, playlists: [], warnings: [] }, selection: {},
      playlist_names: {}, counts: {}, estimated_download_bytes: 0, tracks: [],
      selected_counts: { needs_review: 1, existing: 1, completed: 0 } };
    const { container } = mount();
    expect(container.querySelector('header [data-android-collection-progress]')).toHaveTextContent('Review 1');
    fireEvent.click(screen.getByRole('button', { name: 'Options: Record' }));
    expect(vi.mocked(openContextMenu).mock.calls.at(-1)?.[0].actions?.find(action => action.label === 'Review 1')).toBeDefined();
    expect(container.querySelectorAll('[data-entity-toolbar]')).toHaveLength(1);
  });

  it('renders album metadata, label credit, and More by rail only in Discover view', () => {
    mocks.profile = {
      title: 'Record', artist: 'Artist', cover: '', year: 2021, release_date: '2021-04-02',
      duration: 2400, genre: 'Electronic', label: 'Indie Label',
      tracklist: items, deezer_id: '7', in_library: true, resolved: true, cached: false,
      more_by_artist: [{ deezer_id: '8', title: 'Next Album', cover: '', year: 2023, record_type: 'album' }],
    };
    mount();
    expect(screen.getByText('40 min')).toBeInTheDocument();
    expect(screen.queryByText('Electronic')).toBeNull();
    expect(screen.getByText('℗ Indie Label')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'More by Artist' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'library' } });
    expect(screen.queryByText('℗ Indie Label')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'More by Artist' })).toBeNull();
  });

  it.each(['artist', 'album'] as const)('opens a name-only library %s from local tags without a catalog profile', kind => {
    mocks.profile = null;
    const owned: Track = { id: 'local', title: 'Local track', artist: 'Guest', artists: ['Guest', 'Artist'],
      album: 'Record', album_artist: 'Artist' };
    const other: Track = { id: 'other', title: 'Another track', artist: 'Someone else', album: 'Record' };
    const preview: Track = { ...owned, id: 'preview', title: 'Preview', source: 'preview' };
    render(() => <NativeEntityProfile subject={{ kind, name: kind === 'artist' ? 'Artist' : 'Record', artist: 'Artist', view: 'library' }}
      generation={1} disconnected tracks={[owned, other, preview]} catalog={catalog} onBack={vi.fn()} onOpen={vi.fn()}
      onTrackMenu={vi.fn()} onChanged={async () => {}} />);
    expect(screen.getByRole('button', { name: 'Local track' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Another track' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
  });

  it('shows local album metadata in the hero when offline or Deezer profile is null', () => {
    mocks.profile = null;
    const localTracks: Track[] = [
      { id: 'l1', title: 'One', artist: 'Artist', deezer_album_id: '7', year: 2019, genre: 'House', duration: 600 },
      { id: 'l2', title: 'Two', artist: 'Artist', deezer_album_id: '7', year: 2019, genre: 'House', duration: 600 },
    ];
    render(() => <NativeEntityProfile subject={{ kind: 'album', name: 'Record', artist: 'Artist', deezerId: '7', view: 'library' }}
      generation={1} disconnected tracks={localTracks} catalog={catalog} onBack={vi.fn()} onOpen={vi.fn()} onTrackMenu={vi.fn()}
      onChanged={async () => {}} />);
    expect(screen.getByText('2019')).toBeInTheDocument();
    expect(screen.getByText('2 tracks')).toBeInTheDocument();
    expect(screen.getByText('20 min')).toBeInTheDocument();
    expect(screen.queryByText('House')).toBeNull();
  });

  it('shows resolved multi-artist album credit in the Android header', () => {
    mocks.profile = {
      title: 'Midnight Jazz Confidential',
      artist: 'Piero Piccioni, Ennio Morricone, Nino Rota, Philippe Sarde',
      artists: ['Piero Piccioni', 'Ennio Morricone', 'Nino Rota', 'Philippe Sarde'],
      artist_deezer_id: null,
      cover: '',
      tracklist: items,
      deezer_id: '1126150202',
      in_library: false,
      resolved: true,
      cached: false,
    };
    render(() => <NativeEntityProfile subject={{ kind: 'album', name: 'Midnight Jazz Confidential', artist: 'Ennio Morricone', deezerId: '1126150202', view: 'discover' }}
      generation={1} disconnected={false} tracks={[]} catalog={catalog} onBack={vi.fn()} onOpen={vi.fn()} onTrackMenu={vi.fn()}
      onChanged={async () => {}} />);
    expect(screen.getByText('Piero Piccioni, Ennio Morricone, Nino Rota, Philippe Sarde')).toBeInTheDocument();
  });

  it('renders artist latest release spotlight, Start radio button, and DJ options entry', () => {
    mocks.profile = {
      name: 'Artist', resolved: true, deezer_id: '27',
      metadata: { name: 'Artist', picture: '', nb_fans: 5000 },
      candidates: [], top_tracks: items, albums: [], singles_eps: [], related_artists: [],
      latest_release: { deezer_id: '99', title: 'Fresh EP', cover: '', year: 2026, release_date: '2026-10-01', record_type: 'ep' },
      in_library: false, cached: false,
    };
    render(() => <NativeEntityProfile subject={{ kind: 'artist', name: 'Artist', deezerId: '27', view: 'discover' }}
      generation={1} disconnected={false} tracks={[]} catalog={catalog} onBack={vi.fn()} onOpen={vi.fn()} onTrackMenu={vi.fn()}
      onChanged={async () => {}} canStartRadio canStartDj />);
    expect(screen.getByRole('heading', { name: 'Latest release' })).toBeInTheDocument();
    expect(screen.getByText('Fresh EP')).toBeInTheDocument();
    const radioBtn = screen.getByRole('button', { name: 'Start radio' });
    fireEvent.click(radioBtn);
    expect(mocks.startRadio).toHaveBeenCalledWith(items);
    fireEvent.click(screen.getByRole('button', { name: 'Options: Artist' }));
    const actions = vi.mocked(openContextMenu).mock.calls.at(-1)?.[0].actions ?? [];
    actions.find(action => action.label === 'Start a DJ session')?.onSelect();
    expect(mocks.startDj).toHaveBeenCalledWith(items, 'Artist');
  });
});
