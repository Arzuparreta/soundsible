import { libraryTab, setLibraryTab } from '../lib/libraryView';
import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { Route, Router, type RouteSectionProps } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import styles from './TabBar.module.css';
import { NavigationMenuButton } from './NavigationMenu';
import { setBottomNavigation } from '../lib/bottomNavigation';
import { defaultBottomNavigation } from './primaryNavigation';
import { OverlayOutlet } from '../lib/overlay';
import { setState } from '../stores/core';
import { TabBar } from './TabBar';

function renderTabs() {
  const Root = (props: RouteSectionProps) => (
    <>
      <TabBar /><NavigationMenuButton /><OverlayOutlet />
      {props.children}
    </>
  );
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
  setBottomNavigation([...defaultBottomNavigation]);
  setState('downloads', 'queue', []);
});

afterEach(() => {
  document.querySelectorAll('[data-primary-scroll]').forEach((node) => node.remove());
});

describe('mobile tab bar', () => {
  it.each(['/', '/library', '/search', '/artist/example'])('opens Songs from %s even after choosing another view', async (path) => {
    window.history.replaceState({}, '', path);
    setLibraryTab('albums');
    const view = renderTabs();
    fireEvent.click(view.getByRole('link', { name: 'Biblioteca' }));
    await waitFor(() => expect(libraryTab()).toBe('songs'));
    await waitFor(() => expect(['/', '/library']).toContain(window.location.pathname));
  });

  it('exposes the four default destinations', () => {
    const view = renderTabs();
    expect([...view.container.querySelector('nav')!.children].map((tab) => tab.textContent?.trim()))
      .toEqual(['Biblioteca', 'Buscar', 'Favoritos', 'Ajustes']);
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

  it('resets Library through the mobile drawer after closing it', async () => {
    setLibraryTab('artists');
    renderTabs();
    fireEvent.click(screen.getByRole('button', { name: 'Menú' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('link', { name: 'Biblioteca' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(libraryTab()).toBe('songs');
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
