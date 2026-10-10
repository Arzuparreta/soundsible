import { registerMusicNavigator } from '../lib/musicNavigation';
import { useNavigate } from '@solidjs/router';
import { onCleanup } from 'solid-js';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Router, Route } from '@solidjs/router';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import LibraryHome from './LibraryHome';
import { api } from '../lib/api';
import { setLocale } from '../lib/i18n';
import { setSavedEntities, syncSavedEntities } from '../lib/savedEntities';

beforeEach(() => {
  setLocale('en');
  window.history.replaceState({}, '', '/');
  setSavedEntities([]);
  vi.spyOn(api, 'getSavedEntities').mockResolvedValue([
    { kind: 'album', name: 'Record', artist: 'Band', destination: '/album/Record?artist=Band&deezer_id=1' },
    { kind: 'artist', name: 'Band', destination: '/artist/Band?deezer_id=2' },
  ]);
});
afterEach(() => vi.restoreAllMocks());
const show = () => render(() => <Router root={props => { onCleanup(registerMusicNavigator(useNavigate())); return props.children; }}><Route path="/" component={LibraryHome} /></Router>);
it('has library shortcuts and separate saved rows, with a reloadable collection route', async () => {
  show();
  expect(screen.getByRole('link', { name: 'Albums' })).toHaveAttribute('href', '#/library?view=albums');
  expect(screen.getByRole('link', { name: 'Artists' })).toHaveAttribute('href', '#/library?view=artists');
  await screen.findByRole('link', { name: 'Record' });
  expect(screen.getByRole('region', { name: 'Saved artists' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'See all: Saved albums' }));
  await waitFor(() => expect(window.location.search).toBe('?saved=albums'));
  expect(screen.queryByRole('region', { name: 'Your library' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Saved artists' })).toBeNull();
  expect(screen.getByRole('link', { name: /Back to Library/ })).toBeInTheDocument();
});

it('hides both saved rows when the collection is empty', async () => {
  vi.mocked(api.getSavedEntities).mockResolvedValue([]);
  show();
  await waitFor(() => expect(api.getSavedEntities).toHaveBeenCalled());
  expect(screen.queryByRole('region', { name: 'Saved albums' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Saved artists' })).toBeNull();
  expect(screen.queryByText('Save an album or artist from its page to find it here.')).toBeNull();
});
it('keeps an unavailable optional collection quiet on the Library root', async () => {
  vi.mocked(api.getSavedEntities).mockRejectedValue(new Error('unavailable'));
  show();
  await waitFor(() => expect(api.getSavedEntities).toHaveBeenCalled());
  expect(screen.queryByRole('region', { name: 'Saved albums' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Saved artists' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

it('keeps cards and images mounted when a refresh returns fresh objects for the same bookmarks', async () => {
  const entry = { kind: 'album' as const, name: 'Record', artist: 'Band', destination: '/album/Record?deezer_id=1', cover: '/record.jpg' };
  vi.mocked(api.getSavedEntities).mockResolvedValue([entry]);
  show();
  const link = await screen.findByRole('link', { name: 'Record' });
  const image = link.querySelector('img');
  expect(image).not.toBeNull();
  vi.mocked(api.getSavedEntities).mockResolvedValue([{ ...entry, artist: 'Updated Band' }]);
  await syncSavedEntities();
  await screen.findByText('Updated Band');
  expect(screen.getByRole('link', { name: 'Record' })).toBe(link);
  expect(link.querySelector('img')).toBe(image);
  expect(screen.getByText('Updated Band')).toBeInTheDocument();
});
