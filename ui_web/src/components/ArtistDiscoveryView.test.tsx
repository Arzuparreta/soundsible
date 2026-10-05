import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import { ArtistDiscoveryView } from './ArtistDiscoveryView';
import type { CatalogItem } from '../types/music';
afterEach(cleanup);
it('delegates full entity identities and song context through the shared discography layout', () => {
  setLocale('en'); const open = vi.fn(), play = vi.fn();
  const songs: CatalogItem[] = [{ id: 'song:1', title: 'Song', type: 'track', source: 'deezer' }];
  const view = render(() => <ArtistDiscoveryView artistName="Artist" topTracks={songs} loading={false}
    albums={[{ deezer_id: '1', title: 'Same album', cover: '', year: 2001 }]}
    singlesEps={[{ deezer_id: '2', title: 'Same album', cover: '' }]}
    related={[{ deezer_id: '3', name: 'Related', picture: '', nb_fans: 12300 }]}
    renderSong={(item, index, queue) => <button onClick={() => play(item, index, queue)}>{item.title}</button>}
    renderLink={link => <button onClick={() => open(link.entity)}>{link.children}</button>} />);
  const albums = view.getAllByRole('button', { name: /Same album/ });
  fireEvent.click(albums[0]); fireEvent.click(albums[1]);
  expect(open.mock.calls[0][0].destination).toContain('deezer_id=1');
  expect(open.mock.calls[1][0].destination).toContain('deezer_id=2');
  expect(open.mock.calls[0][0].artist).toBe('Artist');
  fireEvent.click(view.getByRole('button', { name: /Related/ }));
  expect(open.mock.calls[2][0].destination).toContain('deezer_id=3');
  fireEvent.click(view.getByRole('button', { name: 'Song' })); expect(play).toHaveBeenCalledWith(songs[0], 1, songs);
  expect(view.container.querySelector('audio')).toBeNull();
});
