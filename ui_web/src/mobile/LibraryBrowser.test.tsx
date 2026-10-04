import { beforeEach, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import { setLocale } from '../lib/i18n';
import LibraryBrowser from './LibraryBrowser';
import { dispatchNavigationBack } from './backNavigation';
import type { OfflineState } from './offline';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => ({ request }));
const a = { id: 'a', title: 'One', artist: 'Artist', album: 'Album' };
const b = { ...a, id: 'b', title: 'Two' };
beforeEach(() => { cleanup(); setLocale('en'); request.mockReset(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
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
  request.mockImplementation((path: string) => Promise.resolve(path === '/api/library/albums'
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
  request.mockImplementation((path: string) => path === '/api/library/albums'
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
