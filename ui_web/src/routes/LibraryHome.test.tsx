import { registerMusicNavigator } from '../lib/musicNavigation';
import { useNavigate } from '@solidjs/router';
import { onCleanup } from 'solid-js';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Router, Route } from '@solidjs/router';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import LibraryHome from './LibraryHome';
import { api } from '../lib/api';
import { setLocale } from '../lib/i18n';
import { setSavedEntities } from '../lib/savedEntities';

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
