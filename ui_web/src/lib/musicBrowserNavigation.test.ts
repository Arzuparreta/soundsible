import { beforeEach, describe, expect, it } from 'vitest';
import { musicBrowserNavigation as nav } from './musicBrowserNavigation';

describe('music explorer history', () => {
  beforeEach(() => nav.reset());
  it('restores a search and its scroll after artist and album navigation', () => {
    nav.update({ query: 'Björk', filter: 'artists', scroll: 600 });
    nav.push({ kind: 'catalogArtist', name: 'Björk' });
    nav.update({ scroll: 250 });
    nav.push({ kind: 'catalogAlbum', name: 'Post', artist: 'Björk' });
    nav.back();
    expect(nav.current().scroll).toBe(250);
    nav.back();
    expect(nav.current()).toMatchObject({ query: 'Björk', filter: 'artists', scroll: 600 });
  });
  it('keeps independent section histories and updates renamed playlists everywhere', () => {
    nav.select('playlists'); nav.push({ kind: 'playlist', name: 'Viaje' });
    nav.select('library'); nav.update({ query: 'Viaje' }); nav.push({ kind: 'playlist', name: 'Viaje' });
    nav.renamePlaylist('Viaje', 'Viaje largo');
    expect(nav.current().view).toEqual({ kind: 'playlist', name: 'Viaje largo' });
    nav.select('playlists');
    expect(nav.current().view).toEqual({ kind: 'playlist', name: 'Viaje largo' });
  });
});
