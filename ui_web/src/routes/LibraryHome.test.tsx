import { registerMusicNavigator } from '../lib/musicNavigation';
import { useNavigate } from '@solidjs/router';
import { onCleanup } from 'solid-js';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Router, Route } from '@solidjs/router';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import LibraryHome from './LibraryHome';
import { api } from '../lib/api';
import { setLocale } from '../lib/i18n';
import { newReleasesApi } from '../lib/newReleasesApi';
import { setSavedEntities, syncSavedEntities } from '../lib/savedEntities';

beforeEach(() => {
  setLocale('en');
  window.history.replaceState({}, '', '/');
  setSavedEntities([]);
  vi.spyOn(api, 'getSavedEntities').mockResolvedValue([
    { kind: 'album', name: 'Record', artist: 'Band', destination: '/album/Record?artist=Band&deezer_id=1' },
    { kind: 'artist', name: 'Band', destination: '/artist/Band?deezer_id=2' },
  ]);
  vi.spyOn(newReleasesApi, 'getDiscoveryNewReleases').mockResolvedValue({ items: [], revalidating: false });
});
afterEach(() => vi.restoreAllMocks());
const show = () => render(() => <Router root={props => { onCleanup(registerMusicNavigator(useNavigate())); return props.children; }}><Route path="/" component={LibraryHome} /></Router>);
it('has library shortcuts and pinned artist-then-album rows, with reloadable bookmark routes', async () => {
  show();
  expect(screen.getByRole('link', { name: 'Albums' })).toHaveAttribute('href', '#/library?view=albums');
  expect(screen.getByRole('link', { name: 'Artists' })).toHaveAttribute('href', '#/library?view=artists');
  await screen.findByRole('link', { name: 'Record' });
  const artistsSection = screen.getByRole('region', { name: 'Artists' });
  const albumsSection = screen.getByRole('region', { name: 'Albums' });
  expect(artistsSection.compareDocumentPosition(albumsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(artistsSection.querySelector('h2 svg')).not.toBeNull();
  expect(albumsSection.querySelector('h2 svg')).not.toBeNull();
  fireEvent.click(screen.getByRole('link', { name: 'See all: Albums' }));
  await waitFor(() => expect(window.location.search).toBe('?saved=albums'));
  expect(screen.queryByRole('region', { name: 'Your library' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Artists' })).toBeNull();
  expect(screen.getByRole('link', { name: /Back to Library/ })).toBeInTheDocument();
});

it('shows both artists and albums in the unified Bookmarks route', async () => {
  window.history.replaceState({}, '', '/?saved=bookmarks');
  show();
  await screen.findByRole('link', { name: 'Record' });
  expect(screen.queryByRole('region', { name: 'Your library' })).toBeNull();
  const artistsSection = screen.getByRole('region', { name: 'Artists' });
  const albumsSection = screen.getByRole('region', { name: 'Albums' });
  expect(artistsSection.compareDocumentPosition(albumsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('link', { name: /Back to Library/ })).toBeInTheDocument();
});

it('hides both saved rows when the collection is empty', async () => {
  vi.mocked(api.getSavedEntities).mockResolvedValue([]);
  show();
  await waitFor(() => expect(api.getSavedEntities).toHaveBeenCalled());
  expect(screen.queryByRole('region', { name: 'Albums' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Artists' })).toBeNull();
  expect(screen.queryByText('Bookmark an album or artist from its page to find it here.')).toBeNull();
});
it('says once that the saved collection could not load, and retries it', async () => {
  // The root used to drop a failed read silently, which reads as "nothing
  // bookmarked". One line covers both rows, never one per kind.
  vi.mocked(api.getSavedEntities).mockRejectedValueOnce(new Error('unavailable'));
  show();
  const retry = await screen.findByRole('button', { name: 'Retry' });
  expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  expect(screen.queryByRole('region', { name: 'Albums' })).toBeNull();
  expect(screen.queryByText('Bookmark an album or artist from its page to find it here.')).toBeNull();
  fireEvent.click(retry);
  await screen.findByRole('link', { name: 'Record' });
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

it('renders Home New Releases rail lazily from taste-profile endpoint and toggles expansion', async () => {
  vi.mocked(newReleasesApi.getDiscoveryNewReleases).mockResolvedValue({
    items: [
      { id: 'deezer:album:10', type: 'album', source: 'deezer', title: 'Fresh EP', artist: 'Marea', record_type: 'ep', release_date: '2026-11-18', is_new: true, external_ids: { deezer_album_id: '10', deezer_artist_id: '1' } },
      { id: 'deezer:album:11', type: 'album', source: 'deezer', title: 'Season Single', artist: 'Robe', record_type: 'single', release_date: '2026-09-10', is_new: false, external_ids: { deezer_album_id: '11', deezer_artist_id: '2' } },
      { id: 'deezer:album:12', type: 'album', source: 'deezer', title: 'Latest LP', artist: 'Extremoduro', record_type: 'album', release_date: '2026-08-05', is_new: false, external_ids: { deezer_album_id: '12', deezer_artist_id: '3' } },
    ],
    revalidating: false,
  });
  show();
  const region = await screen.findByRole('region', { name: 'New releases' });
  expect(region).toBeInTheDocument();
  expect(screen.getAllByText('New')).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Fresh EP' })).toHaveAttribute('href', '#/album/Fresh%20EP?artist=Marea&view=discover&deezer_id=10');
  const toggle = screen.getByRole('button', { name: 'See all: New releases' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Show less: New releases' })).toHaveAttribute('aria-expanded', 'true'));
});
