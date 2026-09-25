import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Library from './Library';
import { setLibraryTab } from '../lib/libraryView';
import { setState } from '../stores/core';
import { api } from '../lib/api';
import { setLocale } from '../lib/i18n';
import type { CatalogAlbum } from '../types/music';

vi.mock('../components/ArtistGrid', () => ({ default: () => <p>Artist grid</p> }));
vi.mock('../components/AlbumGrid', () => ({ default: () => <p>Album grid</p> }));
vi.mock('../components/TrackList', () => ({ default: () => <p>Songs</p> }));
vi.mock('../components/LibrarySearchResults', () => ({ default: () => null }));

beforeEach(() => {
  setLocale('en');
  window.history.replaceState({}, '', '/');
  setState('loading', false);
  setState('libraryError', false);
  setState('catalog', { artists: [], loading: false, ready: true });
});
afterEach(() => vi.restoreAllMocks());
const show = () => render(() => <Router><Route path="/" component={Library} /></Router>);

describe('library initial feedback', () => {
  it('shows artist placeholders until the catalog arrives, never a false empty state', async () => {
    setLibraryTab('artists');
    setState('catalog', 'loading', true);
    show();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('Artist grid')).toBeNull();
    setState('catalog', { loading: false, artists: [{ id: 'a', name: 'Artist', track_count: 1, album_count: 1, cover_track_id: 'track' }] });
    await screen.findByText('Artist grid');
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
  });

  it('shows album placeholders while pending and offers retry on failure', async () => {
    let reject!: (error: Error) => void;
    const request = vi.spyOn(api, 'getLibraryAlbums').mockImplementationOnce(() => new Promise<CatalogAlbum[]>((_yes, no) => { reject = no; })).mockResolvedValue([]);
    setLibraryTab('albums');
    show();
    expect(screen.getByRole('status')).toBeInTheDocument();
    reject(new Error('offline'));
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
  });
});
