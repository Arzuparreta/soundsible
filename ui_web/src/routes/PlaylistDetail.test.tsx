import type { JSX } from 'solid-js';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { LibrarySettings, Track } from '../types/music';

const store = vi.hoisted(() => ({
  state: {
    playlists: {} as Record<string, string[]>,
    librarySettings: {} as LibrarySettings,
    autoMode: { active: false },
    loading: false,
  },
  library: [] as Track[],
  playShuffled: vi.fn(),
  playFrom: vi.fn(),
  startDjSelection: vi.fn(),
}));

vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('../lib/format', () => ({ trackCount: (n: number) => `${n} songs` }));
vi.mock('../lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/media')>()),
  coverUrl: (id: string, size?: string) => `/cover/${id}${size ? `?size=${size}` : ''}`,
}));
vi.mock('../lib/appBar', () => ({ useAppBar: vi.fn() }));
vi.mock('../lib/shellLayout', () => ({ desktopShell: () => true }));
vi.mock('../components/playlistActions', () => ({ openPlaylistMenu: vi.fn() }));
vi.mock('../components/TrackList', () => ({
  default: (props: { tracks: Track[] }) => <ol>{props.tracks.map((track) => <li>{track.title}</li>)}</ol>,
}));
vi.mock('../stores', () => ({
  state: store.state,
  actions: { playFrom: store.playFrom, playShuffled: store.playShuffled, removeFromPlaylist: vi.fn(), startDjSelection: store.startDjSelection },
  musicLibrary: () => store.library,
}));
vi.mock('@solidjs/router', () => ({
  useParams: () => ({ name: 'Road%20trip' }),
  useNavigate: () => vi.fn(),
  A: (props: { href: string; children?: JSX.Element }) => <a href={props.href}>{props.children}</a>,
}));

import PlaylistDetail from './PlaylistDetail';
import { openPlaylistMenu } from '../components/playlistActions';
import { useAppBar } from '../lib/appBar';

const lib = (id: string): Track => ({ id, title: id, artist: 'A' });

describe('the playlist page header', () => {
  /** The detail page drew no artwork at all, so a cover picked by hand on the
   * playlists grid vanished one tap later. */
  it('shows the cover picked by hand, like the playlists grid', () => {
    store.state.playlists = { 'Road trip': ['first', 'picked'] };
    store.state.librarySettings = { playlist_covers: { 'Road trip': 'picked' } };
    store.library = [lib('first'), lib('picked')];
    const view = render(() => <PlaylistDetail />);
    const image = view.container.querySelector('header img');
    expect(image?.getAttribute('src')).toContain('/cover/picked');
    expect(screen.getByRole('heading', { level: 1, name: 'Road trip' })).toBeInTheDocument();
    expect(screen.getByText('2 songs')).toBeInTheDocument();
    const play = screen.getByRole('button', { name: 'playlistDetail.play' });
    const options = screen.getByRole('button', { name: 'playlistDetail.ariaOptions' });
    expect(play.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('keeps playback context and reaches management through one menu', () => {
    store.state.playlists = { 'Road trip': ['first', 'second'] };
    store.library = [lib('first'), lib('second')];
    render(() => <PlaylistDetail />);
    fireEvent.click(screen.getByRole('button', { name: 'playlistDetail.play' }));
    expect(store.playFrom).toHaveBeenCalledWith(store.library, 0, { context: expect.objectContaining({
      kind: 'playlist', label: 'Road trip', destination: '/playlists/Road%20trip',
    }) });
    expect(screen.queryByRole('button', { name: 'album.shuffle' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'playlistDetail.ariaOptions' }));
    expect(openPlaylistMenu).toHaveBeenCalledWith('Road trip', expect.objectContaining({ onRenamed: expect.any(Function), onDeleted: expect.any(Function) }));
    expect(vi.mocked(useAppBar).mock.calls.at(-1)?.[0].actions).toBeUndefined();
  });
  it('starts a fresh DJ selection with the playlist as its source', () => {
    store.state.autoMode.active = true;
    store.state.playlists = { 'Road trip': ['first', 'second'] };
    store.library = [lib('first'), lib('second')];
    render(() => <PlaylistDetail />);
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.startDj' }));
    expect(store.startDjSelection).toHaveBeenCalledWith(store.library, 'Road trip');
    store.state.autoMode.active = false;
  });
});
