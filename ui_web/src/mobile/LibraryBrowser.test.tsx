import { beforeEach, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import { setLocale } from '../lib/i18n';
import LibraryBrowser from './LibraryBrowser';
import { dispatchNavigationBack } from './backNavigation';
import type { OfflineState } from './offline';
const { request, menu } = vi.hoisted(() => ({ request: vi.fn(), menu: vi.fn() }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: menu }));
// jsdom has no layout for the virtualizer; order is what is under test here, so render every row.
vi.mock('../components/VirtualBrowseRows', () => ({ VirtualBrowseRows: (props: { tracks: { title: string }[] }) => <ol data-all-rows>{props.tracks.map(track => <li>{track.title}</li>)}</ol> }));
vi.mock('../lib/http', () => ({ request }));
const a = { id: 'a', title: 'One', artist: 'Artist', album: 'Album' };
const b = { ...a, id: 'b', title: 'Two' };
beforeEach(() => { cleanup(); setLocale('en'); request.mockReset(); menu.mockReset(); localStorage.clear(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
it('collection preparation includes all members even when song search filters the view', () => {
  const menu = vi.fn();
  const view = render(() => <LibraryBrowser snapshot={{ tracks: [a, b], playlists: { Flight: ['a', 'b', 'a'] } }} revision={0} onCollectionMenu={menu} />);
  fireEvent.click(view.getByText('Playlists'));
  fireEvent.click(view.getByText('Flight'));
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'One' } });
  fireEvent.click(view.container.querySelector('[data-collection-menu]')!);
  expect(menu.mock.calls[0][0]).toEqual([a, b, a]);
});
it('derives offline album and artist navigation without REST or incomplete songs', async () => {
  const state: OfflineState = { user: null, usedBytes: 10, limitBytes: 100, playlists: { Flight: ['a', 'b', 'a'] }, items: [
    { track: a, state: 'ready', bytes: 10, total: 10, error: '' }, { track: b, state: 'downloading', bytes: 0, total: 10, error: '' },
  ] };
  const view = render(() => <LibraryBrowser snapshot={{ tracks: [a, b] }} revision={0} disconnected offline={state} />);
  fireEvent.click(view.getByText('Albums'));
  await waitFor(() => expect(view.getByText('Album')).toBeTruthy());
  fireEvent.click(view.getByText('Album'));
  expect(view.getByRole('heading', { name: 'Album' })).toBeTruthy();
  fireEvent.click(view.getByText('Artists'));
  await waitFor(() => expect(view.getByText('Artist')).toBeTruthy());
  expect(request).not.toHaveBeenCalled();
});
it('album row and collection menus retain the catalog identity without acquiring songs', async () => {
  const entityMenu = vi.fn(), collectionMenu = vi.fn();
  request.mockImplementation((path: string) => Promise.resolve(path.startsWith('/api/library/albums?')
    ? { albums: [{ id: 'album-one', title: 'Album', album_artist: 'Artist', track_count: 2 }] }
    : { track_ids: ['a', 'b'] }));
  const view = render(() => <LibraryBrowser snapshot={{ tracks: [a, b] }} revision={0} onEntityMenu={entityMenu} onCollectionMenu={collectionMenu} />);
  fireEvent.click(view.getByText('Albums'));
  await waitFor(() => expect(view.getByText('Album')).toBeTruthy());
  fireEvent.click(view.container.querySelector('[data-row-menu]')!);
  expect(entityMenu.mock.calls[0][0]).toMatchObject({ kind: 'album', name: 'Album', artist: 'Artist' });
  expect(new URLSearchParams(entityMenu.mock.calls[0][0].destination.split('?')[1]).get('album_id')).toBe('album-one');
  fireEvent.click(view.getByText('Album'));
  await waitFor(() => expect(view.getByRole('heading', { name: 'Album' })).toBeTruthy());
  fireEvent.click(view.container.querySelector('[data-collection-menu]')!);
  expect(collectionMenu.mock.calls[0][0]).toEqual([a, b]);
  expect(collectionMenu.mock.calls[0][3].bookmark).toEqual(entityMenu.mock.calls[0][0]);
  expect(request.mock.calls.every(([path]) => typeof path === 'string' && path.startsWith('/api/library/albums'))).toBe(true);
});

it('system Back leaves a collection before its tab and unregisters on disposal', () => {
  const view = render(() => <LibraryBrowser snapshot={{ tracks: [a], playlists: { Flight: ['a'] } }} revision={0} disconnected />);
  fireEvent.click(view.getByText('Playlists')); fireEvent.click(view.getByText('Flight'));
  expect(dispatchNavigationBack()).toBe(true);
  expect(view.queryByRole('heading', { name: 'Flight' })).toBeNull();
  expect(view.getByText('Playlists')).toHaveAttribute('aria-pressed', 'true');
  expect(dispatchNavigationBack()).toBe(true);
  expect(view.getByText('Songs')).toHaveAttribute('aria-pressed', 'true');
  expect(dispatchNavigationBack()).toBe(false);
  view.unmount(); expect(dispatchNavigationBack()).toBe(false);
});
it('system Back cancels an unfinished album and ignores its late detail', async () => {
  let resolve!: (value: {track_ids: string[]}) => void;
  request.mockImplementation((path: string) => path.startsWith('/api/library/albums?')
    ? Promise.resolve({ albums: [{ id: 'album-one', title: 'Album', album_artist: 'Artist', track_count: 1 }] })
    : new Promise(done => { resolve = done; }));
  const view = render(() => <LibraryBrowser snapshot={{ tracks: [a] }} revision={0} />);
  fireEvent.click(view.getByText('Albums'));
  await waitFor(() => expect(view.getByText('Album')).toBeTruthy()); fireEvent.click(view.getByText('Album'));
  const signal = request.mock.calls.find(([path]) => path === '/api/library/albums/album-one')![1].signal as AbortSignal;
  expect(dispatchNavigationBack()).toBe(true); expect(signal.aborted).toBe(true);
  resolve({ track_ids: ['a'] }); await Promise.resolve();
  expect(view.queryByRole('heading', { name: 'Album' })).toBeNull();
  expect(view.getByText('Songs')).toHaveAttribute('aria-pressed', 'true');
});

const pick = (label: string) => { const actions = menu.mock.calls.at(-1)![0]; const all = [...(actions.actions ?? []), ...(actions.sections ?? []).flatMap((s: { actions: unknown[] }) => s.actions)];
  (all.find((action: { label: string }) => action.label === label) as { onSelect(): void }).onSelect(); };
it('orders and narrows the songs list with the shared preferences, but never a collection', async () => {
  const songs = [{ ...a, id: 'z', title: 'Zulu' }, { ...a, id: 'm', title: 'Mike', source: 'preview' as const }, { ...a, id: 'b2', title: 'Bravo' }];
  const view = render(() => <LibraryBrowser snapshot={{ tracks: songs, playlists: { Mix: ['z', 'm', 'b2'] } }} revision={0} onManageOffline={vi.fn()} isFavourite={track => track.id === 'b2'} />);
  const titles = () => Array.from(view.container.querySelectorAll('[data-all-rows] li')).map(row => row.textContent);
  fireEvent.click(view.container.querySelector('[data-library-menu]')!); pick('A–Z');
  await waitFor(() => expect(titles()).toEqual(['Bravo', 'Mike', 'Zulu']));
  fireEvent.click(view.container.querySelector('[data-library-menu]')!); pick('Downloaded');
  await waitFor(() => expect(titles()).toEqual(['Bravo', 'Zulu']));
  expect(localStorage.getItem('library:sort')).toBe('az'); expect(localStorage.getItem('library:filter')).toBe('downloaded');
  fireEvent.click(view.getByText('Playlists')); fireEvent.click(view.getByText('Mix'));
  await waitFor(() => expect(titles()).toEqual(['Zulu', 'Mike', 'Bravo']));
});
it('asks the engine for the chosen album order and genre, and offers to clear a filter that matches nothing', async () => {
  request.mockImplementation((path: string) => Promise.resolve(path.startsWith('/api/library/genres') ? { genres: [{ name: 'Jazz', album_count: 1 }] }
    : path.startsWith('/api/library/years') ? { years: [] }
    : path.includes('genre=Jazz') ? { albums: [] } : { albums: [{ id: 'x', title: 'Album', album_artist: 'Artist', track_count: 1 }] }));
  const view = render(() => <LibraryBrowser snapshot={{ tracks: [a] }} revision={0} />);
  fireEvent.click(view.getByText('Albums')); await waitFor(() => expect(view.getByText('Album')).toBeTruthy());
  fireEvent.click(view.container.querySelector('[data-album-menu]')!); await waitFor(() => expect(menu).toHaveBeenCalled());
  pick('Most played'); await waitFor(() => expect(request.mock.calls.some(([path]) => String(path).includes('sort=frequent'))).toBe(true));
  fireEvent.click(view.container.querySelector('[data-album-menu]')!); await waitFor(() => expect(menu).toHaveBeenCalledTimes(2));
  pick('Genre'); pick('Jazz');
  await waitFor(() => expect(view.getByText('No albums match this filter.')).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: 'All albums' }));
  await waitFor(() => expect(view.getByText('Album')).toBeTruthy());
});
