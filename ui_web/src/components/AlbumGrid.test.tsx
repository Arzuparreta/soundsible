import type { JSX } from 'solid-js';
import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('../lib/format', () => ({ trackCount: (n: number) => `${n} songs` }));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('../lib/contextMenu', () => ({ attachContextMenu: vi.fn() }));
vi.mock('./albumActions', () => ({ albumMenuOptions: vi.fn() }));
vi.mock('@solidjs/router', () => ({
  useNavigate: () => vi.fn(),
  A: (props: { href: string; children?: JSX.Element }) => <a href={props.href}>{props.children}</a>,
}));

import AlbumGrid from './AlbumGrid';
import type { CatalogAlbum } from '../types/music';

const album = (over: Partial<CatalogAlbum> = {}): CatalogAlbum => ({
  id: 'al-1',
  title: 'Album',
  album_artist: 'Artist',
  is_compilation: false,
  track_count: 10,
  duration: 1800,
  cover_track_id: 't1',
  ...over,
});

describe('AlbumGrid', () => {
  it('carries the catalog id in the link, so the page can ask which songs these are', () => {
    render(() => <AlbumGrid albums={[album({ id: 'al-abc' })]} />);
    const href = screen.getByRole('link').getAttribute('href') ?? '';
    expect(href).toContain('album_id=al-abc');
    expect(href).toContain('view=library');
  });

  /**
   * The reason this grid exists. Grouping the flat track list by title merged
   * these two into one card holding both records' songs; the engine gives them
   * separate ids, and the grid has to keep them separate.
   */
  it('draws two cards for two records that share a title', () => {
    render(() => (
      <AlbumGrid
        albums={[
          album({ id: 'al-queen', title: 'Greatest Hits', album_artist: 'Queen' }),
          album({ id: 'al-abba', title: 'Greatest Hits', album_artist: 'ABBA' }),
        ]}
      />
    ));
    expect(screen.getAllByText('Greatest Hits')).toHaveLength(2);
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.some((href) => href.includes('al-queen'))).toBe(true);
    expect(hrefs.some((href) => href.includes('al-abba'))).toBe(true);
  });

  it('credits a compilation to the album artist the engine chose', () => {
    render(() => (
      <AlbumGrid albums={[album({ is_compilation: true, album_artist: 'Various Artists' })]} />
    ));
    expect(screen.getByText('Various Artists')).toBeInTheDocument();
  });

  it('renders a record whose artwork the engine could not name', () => {
    // No cover track means no image — the gradient carries the card. Rendering
    // `/cover/undefined` would put a broken request behind every such tile.
    render(() => <AlbumGrid albums={[album({ cover_track_id: null })]} />);
    expect(screen.getByRole('link').innerHTML).not.toContain('/cover/');
  });
});
