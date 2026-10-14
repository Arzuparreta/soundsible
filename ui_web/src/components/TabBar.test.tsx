import { libraryTab, setLibraryTab } from '../lib/libraryView';
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
  it.each(['/', '/library', '/search', '/artist/example'])('opens the Library root from %s without selecting Songs', async (path) => {
    window.history.replaceState({}, '', path);
    setLibraryTab('albums');
    const view = renderTabs();
    fireEvent.click(view.getByRole('link', { name: 'Biblioteca' }));
    await waitFor(() => expect(libraryTab()).toBe('albums'));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
  });

  it('exposes the four default destinations', () => {
    const view = renderTabs();
    expect([...view.container.querySelector('nav')!.children].map((tab) => tab.textContent?.trim()))
      .toEqual(['Biblioteca', 'Favoritos', 'Descubrir', 'Ajustes']);
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

  it('opens the Library root through the mobile drawer without resetting its subview', async () => {
    setLibraryTab('artists');
    renderTabs();
    fireEvent.click(screen.getByRole('button', { name: 'Menú' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('link', { name: 'Biblioteca' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(libraryTab()).toBe('artists'));
  });

  it('keeps Library independent from the old Favourites preference', async () => {
    localStorage.setItem('library:mobileSection', 'favourites');
    window.history.replaceState({}, '', '/search');
    renderTabs();
    fireEvent.click(screen.getByRole('link', { name: 'Biblioteca' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(screen.getByRole('link', { name: 'Biblioteca' })).toHaveClass(styles.active);
  });

  it('reselecting the active root tab returns its primary surface to the top', () => {
    const surface = document.createElement('div');
    surface.dataset.primaryScroll = '';
    surface.scrollTop = 240;
    surface.scrollTo = vi.fn();
    document.body.append(surface);
    renderTabs();

    fireEvent.click(screen.getByRole('link', { name: 'Biblioteca' }));

    expect(surface.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });
});

it('opens a configured subentry directly and highlights it instead of the root', async () => {
  setBottomNavigation(['/', '/library?view=artists', '/?saved=albums', '/search']);
  const view = renderTabs();
  fireEvent.click(view.getByRole('link', { name: 'Artistas' }));
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/library?view=artists'));
  expect(view.getByRole('link', { name: 'Artistas' })).toHaveAttribute('aria-current', 'page');
  expect(view.getByRole('link', { name: 'Biblioteca' })).not.toHaveAttribute('aria-current');
  fireEvent.click(view.getByRole('link', { name: 'Álbumes guardados' }));
  await waitFor(() => expect(window.location.search).toBe('?saved=albums'));
  expect(view.getByRole('link', { name: 'Álbumes guardados' })).toHaveAttribute('aria-current', 'page');
  fireEvent.click(view.getByRole('link', { name: 'Biblioteca' }));
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/'));
});

describe('artist and album pages', () => {
  const here = () => window.location.pathname + window.location.search;

  it.each(['/artist/Band?view=library', '/album/Record?artist=Band&view=discover'])('belong to Search: %s', (path) => {
    window.history.replaceState({}, '', path);
    const view = renderTabs();
    expect(view.getByRole('link', { name: 'Descubrir' })).toHaveAttribute('aria-current', 'page');
    expect(view.getByRole('link', { name: 'Biblioteca' })).not.toHaveAttribute('aria-current');
  });

  it('stay open in Search while the listener visits another tab, on top of the search they came from', async () => {
    window.history.replaceState({}, '', '/search?q=band');
    const view = renderTabs();
    navigate('/artist/Band?view=discover');
    await waitFor(() => expect(here()).toBe('/artist/Band?view=discover'));

    fireEvent.click(view.getByRole('link', { name: 'Biblioteca' }));
    await waitFor(() => expect(here()).toBe('/'));
    fireEvent.click(view.getByRole('link', { name: 'Descubrir' }));
    await waitFor(() => expect(here()).toBe('/artist/Band?view=discover'));
    // A restored page has no parent in history: its back arrow climbs to the
    // search below it instead of into Library.
    expect(window.history.state?.[TAB_RETURN_STATE]).toBe(true);
    expect(tabRoot('/search')).toBe('/search?q=band');

    // Re-selecting the active tab climbs to its root, the search as it was left.
    fireEvent.click(view.getByRole('link', { name: 'Descubrir' }));
    await waitFor(() => expect(here()).toBe('/search?q=band'));
  });

  it('opened by a link from Library return to Library where it was left', async () => {
    window.history.replaceState({}, '', '/?saved=albums');
    setBottomNavigation(['/', '/search', '/settings']);
    const view = renderTabs();
    navigate('/album/Record?artist=Band&view=library');
    await waitFor(() => expect(view.getByRole('link', { name: 'Descubrir' })).toHaveAttribute('aria-current', 'page'));
    fireEvent.click(view.getByRole('link', { name: 'Biblioteca' }));
    await waitFor(() => expect(here()).toBe('/?saved=albums'));
  });
});
