import type { JSX } from 'solid-js';
import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { LibrarySettings, Track } from '../types/music';

// Hoisted: `vi.mock` factories run before the module body, so the store they
// close over has to exist by then.
const store = vi.hoisted(() => ({
  state: { playlists: {} as Record<string, string[]>, librarySettings: {} as LibrarySettings },
  library: [] as Track[],
}));

vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('../lib/format', () => ({ trackCount: (n: number) => `${n} songs` }));
// Partial: `trackCoverUrl` and `hasCoverArt` are the code under test and must
// be the real ones. Only the engine URL is stubbed, to keep it recognisable.
vi.mock('../lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/media')>()),
  coverUrl: (id: string, size?: string) => `/cover/${id}${size ? `?size=${size}` : ''}`,
}));
vi.mock('../lib/contextMenu', () => ({ attachContextMenu: vi.fn() }));
vi.mock('../lib/scrollHistory', () => ({ registerPrimaryScroll: vi.fn() }));
vi.mock('../lib/prompt', () => ({ promptDialog: vi.fn() }));
vi.mock('../components/playlistActions', () => ({
  openPlaylistMenu: vi.fn(),
  playlistMenuOptions: vi.fn(),
}));
vi.mock('../stores', () => ({
  state: store.state,
  actions: { createPlaylist: vi.fn() },
  musicLibrary: () => store.library,
}));
vi.mock('@solidjs/router', () => ({
  useNavigate: () => vi.fn(),
  A: (props: { href: string; children?: JSX.Element }) => <a href={props.href}>{props.children}</a>,
}));

import Playlists from './Playlists';
import { NEUTRAL_COVER } from '../lib/cover';

const lib = (id: string): Track => ({ id, title: id, artist: 'A' });
const preview = (id: string, cover?: string): Track =>
  ({ id, title: id, artist: 'A', source: 'preview', cover });

function show(playlists: Record<string, string[]>, library: Track[], settings: LibrarySettings = {}) {
  store.state.playlists = playlists;
  store.state.librarySettings = settings;
  store.library = library;
  render(() => <Playlists />);
  // The card is the link; its cover is a background on a child.
  return screen.getByRole('link').innerHTML;
}

describe('the playlists grid draws a cover whenever any song in the list has one', () => {
  /**
   * The reported bug. "techno tracks for session" opens on a song saved from
   * YouTube and never downloaded, so the card asked the engine for a cover it
   * has no row for, got a 404 and drew the flat neutral placeholder — while
   * every song in that playlist, that one included, had artwork.
   */
  it('shows a saved-only first song’s own thumbnail instead of asking the engine', () => {
    const thumb = 'https://img.youtube.com/vi/95dB-ObZ7Ho/mqdefault.jpg';
    const html = show(
      { 'techno tracks for session': ['95dB-ObZ7Ho', 'hash-2'] },
      [preview('95dB-ObZ7Ho', thumb), lib('hash-2')],
    );
    expect(html).toContain(thumb);
    expect(html).not.toContain('/cover/');
  });

  it('falls through to the next song when the first has no artwork at all', () => {
    const html = show({ mix: ['no-art', 'owned'] }, [preview('no-art'), lib('owned')]);
    expect(html).toContain('/cover/owned');
    expect(html).not.toContain('/cover/no-art');
  });

  it('asks for the thumbnail variant, not the multi-megabyte original', () => {
    const html = show({ mix: ['owned'] }, [lib('owned')]);
    expect(html).toContain('size=thumb');
  });

  it('draws the neutral placeholder alone when nothing in the list has artwork', () => {
    const html = show({ mix: ['a', 'b'] }, [preview('a'), preview('b')]);
    expect(html).toContain(NEUTRAL_COVER);
    expect(html).not.toContain('url(');
  });

  it('uses the cover you picked by hand over the first song', () => {
    const html = show({ mix: ['first', 'picked'] }, [lib('first'), lib('picked')], {
      playlist_covers: { mix: 'picked' },
    });
    expect(html).toContain('/cover/picked');
    expect(html).not.toContain('/cover/first');
  });
});
