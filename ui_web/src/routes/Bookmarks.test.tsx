import { onCleanup } from 'solid-js';
import { Route, Router, useNavigate } from '@solidjs/router';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Bookmarks from './Bookmarks';
import { api } from '../lib/api';
import { setLocale } from '../lib/i18n';
import { registerMusicNavigator } from '../lib/musicNavigation';
import { setSavedEntities, type SavedEntity } from '../lib/savedEntities';

vi.mock('../lib/shellLayout', () => ({ desktopShell: () => true }));

const SAMPLE: SavedEntity[] = [
  { kind: 'album', name: 'Oﬃce', artist: 'Björk', destination: '/album/Office?artist=Bjork&deezer_id=1' },
  { kind: 'artist', name: 'Band', destination: '/artist/Band?deezer_id=2' },
];

beforeEach(() => {
  setLocale('en');
  window.history.replaceState({}, '', '/bookmarks');
  setSavedEntities([]);
  vi.spyOn(api, 'getSavedEntities').mockResolvedValue(SAMPLE);
});
afterEach(() => vi.restoreAllMocks());

const show = (kind?: SavedEntity['kind']) => render(() => (
  <Router root={props => { onCleanup(registerMusicNavigator(useNavigate())); return props.children; }}>
    <Route path="*" component={() => <Bookmarks kind={kind} />} />
  </Router>
));

it('shows artists then albums on /bookmarks and links back to Home', async () => {
  show();
  await screen.findByRole('link', { name: 'Oﬃce' });
  const artistsSection = screen.getByRole('region', { name: 'Artists' });
  const albumsSection = screen.getByRole('region', { name: 'Albums' });
  expect(artistsSection.compareDocumentPosition(albumsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('link', { name: /Back to Home/ })).toHaveAttribute('href', '#/');
});

it('filters by kind and searches saved bookmarks using compatibility normalization', async () => {
  window.history.replaceState({}, '', '/bookmarks/albums');
  show('album');
  await screen.findByRole('link', { name: 'Oﬃce' });
  expect(screen.queryByRole('region', { name: 'Artists' })).toBeNull();
  const field = screen.getByRole('searchbox', { name: 'Filter this list' });
  fireEvent.input(field, { target: { value: 'BJORK' } });
  expect(screen.getByRole('link', { name: 'Oﬃce' })).toBeInTheDocument();
  fireEvent.input(field, { target: { value: 'missing' } });
  expect(await screen.findByText('No matches in this list.')).toBeInTheDocument();
});

it('shows only artists when opened for saved artists', async () => {
  window.history.replaceState({}, '', '/bookmarks/artists');
  show('artist');
  await screen.findByRole('link', { name: 'Band' });
  expect(screen.queryByRole('region', { name: 'Albums' })).toBeNull();
  expect(screen.getByRole('link', { name: /Back to Home/ })).toHaveAttribute('href', '#/');
});
