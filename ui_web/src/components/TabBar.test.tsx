import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { Route, Router, useLocation, useNavigate, type Navigator, type RouteSectionProps } from '@solidjs/router';
import { createEffect } from 'solid-js';
import { rememberTabLocation, resetTabMemoryForTests, tabRoot } from '../lib/tabMemory';
import { TAB_RETURN_STATE } from '../lib/scrollHistory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import styles from './TabBar.module.css';
import { NavigationMenuButton } from './NavigationMenu';
import { setBottomNavigation } from '../lib/bottomNavigation';
import { defaultBottomNavigation } from './primaryNavigation';
import { OverlayOutlet } from '../lib/overlay';
import { setState } from '../stores/core';
import { TabBar } from './TabBar';

let navigate: Navigator;
const here = () => window.location.pathname + window.location.search;

function renderTabs() {
  const Root = (props: RouteSectionProps) => {
    // What the shell does: every location is remembered for its tab.
    const location = useLocation();
    navigate = useNavigate();
    createEffect(() => rememberTabLocation(location.pathname, location.search));
    return (
      <>
        <TabBar /><NavigationMenuButton /><OverlayOutlet />
        {props.children}
      </>
    );
  };
  return render(() => (
    <Router root={Root}>
      <Route path="*" component={() => null} />
    </Router>
  ));
}

beforeEach(async () => {
  // Non-English dictionaries load on demand now.
  await setLocale('es');
  window.history.pushState({}, '', '/');
  resetTabMemoryForTests();
  setBottomNavigation([...defaultBottomNavigation]);
  setState('downloads', 'queue', []);
});

afterEach(() => {
  document.querySelectorAll('[data-primary-scroll]').forEach((node) => node.remove());
});

describe('mobile tab bar', () => {
  it.each(['/', '/songs', '/search', '/artist/example'])('opens Home directly from %s', async (path) => {
    window.history.replaceState({}, '', path);
    const view = renderTabs();
    fireEvent.click(view.getByRole('link', { name: 'Inicio' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(view.getByRole('link', { name: 'Inicio' })).toHaveAttribute('aria-current', 'page');
  });

  it('exposes the four default destinations', () => {
    const view = renderTabs();
    expect([...view.container.querySelector('nav')!.children].map((tab) => tab.textContent?.trim()))
      .toEqual(['Inicio', 'Favoritos', 'Descubrir', 'Ajustes']);
  });

  it('marks settings subroutes active', () => {
    window.history.replaceState({}, '', '/settings/devices');
    renderTabs();
    expect(screen.getByRole('link', { name: 'Ajustes' })).toHaveClass(styles.active);
  });

  it('keeps the download count live while the menu is open', async () => {
    renderTabs();
    setState('downloads', 'queue', [{ id: 'one', status: 'pending' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Menú' }));
    expect(await screen.findByRole('link', { name: /Descargas/ })).toHaveTextContent('1');
    setState('downloads', 'queue', []);
    expect(screen.getByRole('link', { name: 'Descargas' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens Home directly through the mobile drawer from any route', async () => {
    window.history.replaceState({}, '', '/artists');
    renderTabs();
    fireEvent.click(screen.getByRole('button', { name: 'Menú' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('link', { name: 'Inicio' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(window.location.pathname).toBe('/'));
  });

  it('keeps Home independent from the old Favourites preference', async () => {
    localStorage.setItem('library:mobileSection', 'favourites');
    window.history.replaceState({}, '', '/search');
    renderTabs();
    fireEvent.click(screen.getByRole('link', { name: 'Inicio' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(screen.getByRole('link', { name: 'Inicio' })).toHaveClass(styles.active);
  });

  it('reselecting the active root tab returns its primary surface to the top', () => {
    const surface = document.createElement('div');
    surface.dataset.primaryScroll = '';
    surface.scrollTop = 240;
    surface.scrollTo = vi.fn();
    document.body.append(surface);
    renderTabs();

    fireEvent.click(screen.getByRole('link', { name: 'Inicio' }));

    expect(surface.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('never absorbs Songs, Albums or Artists under Home in the tab bar', async () => {
    window.history.replaceState({}, '', '/songs');
    const view = renderTabs();
    expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    navigate('/artist/Band?view=library');
    await waitFor(() => expect(here()).toBe('/artist/Band?view=library'));
    fireEvent.click(view.getByRole('link', { name: 'Inicio' }));
    await waitFor(() => expect(here()).toBe('/'));
  });

  it('remembers real subroutes in the bottom tab bar and climbs to root on a second tap', async () => {
    const surface = document.createElement('div');
    surface.dataset.primaryScroll = '';
    surface.scrollTop = 180;
    surface.scrollTo = vi.fn();
    document.body.append(surface);
    window.history.replaceState({}, '', '/settings/devices');
    const view = renderTabs();

    fireEvent.click(view.getByRole('link', { name: 'Favoritos' }));
    await waitFor(() => expect(here()).toBe('/favourites'));

    fireEvent.click(view.getByRole('link', { name: 'Ajustes' }));
    await waitFor(() => expect(here()).toBe('/settings/devices'));

    fireEvent.click(view.getByRole('link', { name: 'Ajustes' }));
    await waitFor(() => expect(here()).toBe('/settings'));

    fireEvent.click(view.getByRole('link', { name: 'Ajustes' }));
    expect(surface.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });
});

it('opens configured collection destinations directly and highlights them', async () => {
  setBottomNavigation(['/', '/artists', '/bookmarks', '/search']);
  const view = renderTabs();
  fireEvent.click(view.getByRole('link', { name: 'Artistas' }));
  await waitFor(() => expect(here()).toBe('/artists'));
  expect(view.getByRole('link', { name: 'Artistas' })).toHaveAttribute('aria-current', 'page');
  expect(view.getByRole('link', { name: 'Inicio' })).not.toHaveAttribute('aria-current');
  fireEvent.click(view.getByRole('link', { name: 'Marcadores' }));
  await waitFor(() => expect(here()).toBe('/bookmarks'));
  expect(view.getByRole('link', { name: 'Marcadores' })).toHaveAttribute('aria-current', 'page');
  fireEvent.click(view.getByRole('link', { name: 'Inicio' }));
  await waitFor(() => expect(here()).toBe('/'));
});

describe('artist and album pages', () => {
  it.each(['/artist/Band?view=library', '/album/Record?artist=Band&view=discover'])('highlight no tab: %s', (path) => {
    window.history.replaceState({}, '', path);
    const view = renderTabs();
    expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
  });

  it('leave Search and Home tab memory intact when opened', async () => {
    window.history.replaceState({}, '', '/search?q=band');
    const view = renderTabs();
    navigate('/artist/Band?view=discover');
    await waitFor(() => expect(here()).toBe('/artist/Band?view=discover'));
    expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);

    fireEvent.click(view.getByRole('link', { name: 'Inicio' }));
    await waitFor(() => expect(here()).toBe('/'));
    fireEvent.click(view.getByRole('link', { name: 'Descubrir' }));
    await waitFor(() => expect(here()).toBe('/search?q=band'));
    expect(window.history.state?.[TAB_RETURN_STATE]).toBe(true);
    expect(tabRoot('/search')).toBe('/search?q=band');
  });

  it('remembers a configured Bookmarks subroute across entity visits and climbs on re-tap', async () => {
    window.history.replaceState({}, '', '/bookmarks/albums');
    setBottomNavigation(['/', '/bookmarks', '/search']);
    const view = renderTabs();
    navigate('/album/Record?artist=Band&view=library');
    await waitFor(() => expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(0));
    fireEvent.click(view.getByRole('link', { name: 'Marcadores' }));
    await waitFor(() => expect(here()).toBe('/bookmarks/albums'));
    fireEvent.click(view.getByRole('link', { name: 'Marcadores' }));
    await waitFor(() => expect(here()).toBe('/bookmarks'));
  });
});
