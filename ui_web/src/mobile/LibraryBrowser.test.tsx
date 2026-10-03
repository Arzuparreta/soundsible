import { beforeEach, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import { setLocale } from '../lib/i18n';
import LibraryBrowser from './LibraryBrowser';
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
