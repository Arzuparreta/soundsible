import { fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../lib/i18n';
import { libraryTab, setLibraryTab } from '../lib/libraryView';
import { resetSidebarStateForTests, sidebarCollapsed } from '../lib/sidebarState';
import { setState } from '../stores/core';
import styles from './NavigationMenu.module.css';
import { Sidebar } from './Sidebar';

function renderSidebar() {
  return render(() => (
    <Router>
      <Route path="*" component={Sidebar} />
    </Router>
  ));
}

beforeEach(async () => {
  // Non-English dictionaries load on demand now.
  await setLocale('es');
  resetSidebarStateForTests();
  setState('downloads', 'queue', []);
  window.history.pushState({}, '', '/');
});

describe('desktop sidebar', () => {
  it.each(['/', '/library', '/search', '/artist/example'])('opens the Library root from %s without selecting Songs', async (path) => {
    window.history.replaceState({}, '', path);
    setLibraryTab('albums');
    const view = renderSidebar();
    fireEvent.click(view.getByRole('link', { name: 'Biblioteca' }));
    await waitFor(() => expect(libraryTab()).toBe('albums'));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
  });

  it('exposes the three-tier navigation with Collection and bottom utilities', () => {
    const view = renderSidebar();
    const groups = view.container.querySelectorAll('nav');
    expect(groups).toHaveLength(3);
    expect(within(groups[0]).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Biblioteca', 'Descubrir', 'Podcasts', 'Live']);
    expect(within(groups[1]).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Canciones', 'Álbumes', 'Artistas', 'Listas', 'Favoritos']);
    expect(within(groups[2]).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Descargas', 'Ajustes']);
    expect(view.getByRole('heading', { level: 2, name: 'Colección' })).toBeInTheDocument();
  });

  it('announces only the active Collection view while preserving Library climb-to-root', async () => {
    window.history.replaceState({}, '', '/library?view=songs');
    const view = renderSidebar();
    const current = view.container.querySelectorAll('[aria-current="page"]');
    expect([...current].map((link) => link.textContent?.trim())).toEqual(['Canciones']);
    const library = view.getByRole('link', { name: 'Biblioteca' });
    expect(library).not.toHaveAttribute('aria-current');
    expect(library).not.toHaveClass(styles.active);
    // Library remains the logical parent: clicking it climbs back to `/`.
    fireEvent.click(library);
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(library).toHaveAttribute('aria-current', 'page');
    expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it.each([['/?saved=albums', 'Biblioteca'], ['/artist/example', 'Descubrir'], ['/search', 'Descubrir']])('gives %s exactly one current entry', (path, name) => {
    window.history.replaceState({}, '', path);
    const view = renderSidebar();
    const current = view.container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent?.trim()).toBe(name);
  });

  it('keeps the lowercase brand a link home that never claims the current page', async () => {
    window.history.replaceState({}, '', '/search');
    const view = renderSidebar();
    const brand = view.getByRole('link', { name: 'soundsible' });
    expect(brand.querySelector('svg')).toBeNull();
    fireEvent.click(brand);
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(brand).not.toHaveAttribute('aria-current');
  });

  it('navigates from a settings subroute back to its index', async () => {
    window.history.replaceState({}, '', '/settings/devices');
    const view = renderSidebar();
    const link = view.getByRole('link', { name: 'Ajustes' });
    expect(link).toHaveClass(styles.active);
    fireEvent.click(link);
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('collapses into an icon-only rail with accessible labels and persists state', () => {
    setState('downloads', 'queue', [{ id: 'dl-1', status: 'pending' }]);
    const view = renderSidebar();
    const aside = view.container.querySelector('aside')!;
    const toggle = view.getByRole('button', { name: 'Contraer barra lateral' });

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(aside).not.toHaveAttribute('data-collapsed');
    expect(view.getByRole('link', { name: 'soundsible' })).toBeInTheDocument();
    expect(view.getByRole('link', { name: /Descargas/ })).toHaveTextContent('1');

    fireEvent.click(toggle);

    expect(sidebarCollapsed()).toBe(true);
    expect(aside).toHaveAttribute('data-collapsed', '');
    expect(document.documentElement.hasAttribute('data-sidebar-collapsed')).toBe(true);
    expect(localStorage.getItem('sidebar:collapsed:v1')).toBe('1');
    expect(view.queryByRole('link', { name: 'soundsible' })).toBeNull();
    expect(view.getByRole('button', { name: 'Expandir barra lateral' })).toHaveAttribute('aria-expanded', 'false');
    expect(view.queryByRole('heading', { level: 2, name: 'Colección' })).toBeNull();
    // Collapsed links unmount label spans and preserve aria-label + data-nav-href.
    expect(view.getByRole('link', { name: 'Biblioteca' })).toHaveAttribute('data-nav-href', '/');
    expect(view.getByRole('link', { name: 'Canciones' })).toHaveAttribute('data-nav-href', '/library?view=songs');
    expect(view.getByRole('link', { name: 'Descargas' }).querySelector(`.${styles.badgeDot}`)).not.toBeNull();

    fireEvent.click(view.getByRole('button', { name: 'Expandir barra lateral' }));
    expect(sidebarCollapsed()).toBe(false);
    expect(aside).not.toHaveAttribute('data-collapsed');
    expect(view.getByRole('link', { name: 'soundsible' })).toBeInTheDocument();
  });

  it('claims the shared stage surface attribute without colliding with player backdrop locators', () => {
    const view = renderSidebar();
    const aside = view.container.querySelector('aside')!;
    expect(aside).toHaveAttribute('data-stage-surface', '');
    expect(aside).not.toHaveAttribute('data-player-stage');
    expect(aside.querySelector('[data-player-backdrop]')).toBeNull();
    expect(aside.querySelector('[data-player-veil]')).toBeNull();
  });
});
