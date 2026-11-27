import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Route, Router, useNavigate } from '@solidjs/router';
import { type Component } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { asyncPage } from './AsyncPage';
import { currentAppBar } from '../lib/appBar';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('route feedback', () => {
  it('commits the destination before its module resolves and ignores departed mounts', async () => {
    const module = deferred<{ default: Component }>();
    const load = vi.fn(() => module.promise);
    const Page = asyncPage(load, () => 'Destination');
    let navigate!: ReturnType<typeof useNavigate>;
    render(() => <Router root={props => { navigate = useNavigate(); return props.children; }}>
      <Route path="/" component={() => <p>Home</p>} />
      <Route path="/destination" component={Page} />
    </Router>);
    navigate('/destination');
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.queryByText('Home')).toBeNull();
    expect(currentAppBar()?.title()).toBe('Destination');
    expect(window.location.pathname).toBe('/destination');
    navigate('/');
    await screen.findByText('Home');
    module.resolve({ default: () => <p>Loaded</p> });
    await Promise.resolve();
    expect(screen.queryByText('Loaded')).toBeNull();
    navigate('/destination');
    await screen.findByText('Loaded');
    expect(load).toHaveBeenCalledOnce();
    navigate('/');
    await screen.findByText('Home');
  });

  it('offers retry after a failed module and then replaces the skeleton', async () => {
    const load = vi.fn<() => Promise<{ default: Component }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ default: () => <p>Recovered</p> });
    const Page = asyncPage(load, () => 'Destination');
    render(() => <Page />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByText('Recovered');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders route-matched skeleton shapes with a single status announcement', () => {
    const pending = () => new Promise<{ default: Component }>(() => {});

    const FavouritesPage = asyncPage(pending, () => 'Favourites', 'favourites');
    const favRender = render(() => <FavouritesPage />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(favRender.container.querySelectorAll('[data-skeleton-row][data-variant], [data-variant="song"] [data-skeleton-row]').length).toBe(12);
    favRender.unmount();

    const ArtistsPage = asyncPage(pending, () => 'Artists', 'artists');
    const artistsRender = render(() => <ArtistsPage />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(artistsRender.container.querySelector('[data-skeleton-cards][data-shape="round"]')).toBeInTheDocument();
    artistsRender.unmount();

    const HomePage = asyncPage(pending, () => 'Home', 'home');
    const homeRender = render(() => <HomePage />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(homeRender.container.querySelector('[data-skeleton-cards][data-layout="rail"]')).toBeInTheDocument();
    homeRender.unmount();

    const SettingsPage = asyncPage(pending, () => 'Settings', 'settings');
    const settingsRender = render(() => <SettingsPage />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(settingsRender.container.querySelectorAll('[data-skeleton-row]')).toHaveLength(5);
    settingsRender.unmount();

    const ArtistPage = asyncPage(pending, () => 'Artist', 'artist');
    const artistRender = render(() => <ArtistPage />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(artistRender.container.querySelectorAll('[data-variant="song"] [data-skeleton-row]')).toHaveLength(6);
    artistRender.unmount();

    const DownloadsPage = asyncPage(pending, () => 'Downloads', 'downloads');
    const downloadsRender = render(() => <DownloadsPage />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(downloadsRender.container.querySelectorAll('[data-skeleton-row]')).toHaveLength(4);
    downloadsRender.unmount();
  });
});
