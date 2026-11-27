import { fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { Route, Router, useLocation, useNavigate, type Navigator, type RouteSectionProps } from '@solidjs/router';
import { createEffect } from 'solid-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../lib/i18n';
import { resetSidebarStateForTests, sidebarCollapsed } from '../lib/sidebarState';
import { rememberTabLocation, resetTabMemoryForTests } from '../lib/tabMemory';
import { setState } from '../stores/core';
import styles from './NavigationMenu.module.css';
import { Sidebar } from './Sidebar';

let navigate: Navigator;

function renderSidebar() {
  const Root = (props: RouteSectionProps) => {
    const location = useLocation();
    navigate = useNavigate();
    createEffect(() => rememberTabLocation(location.pathname, location.search));
    return (
      <>
        <Sidebar />
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
  resetSidebarStateForTests();
  resetTabMemoryForTests();
  setState('downloads', 'queue', []);
  window.history.pushState({}, '', '/');
});

describe('desktop sidebar', () => {
  it.each(['/', '/songs', '/search', '/artist/example'])('opens Home from %s', async (path) => {
    window.history.replaceState({}, '', path);
    const view = renderSidebar();
    fireEvent.click(view.getByRole('link', { name: 'Inicio' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(view.getByRole('link', { name: 'Inicio' })).toHaveAttribute('aria-current', 'page');
  });

  it('exposes the three-tier navigation with Collection and bottom utilities', () => {
    const view = renderSidebar();
    const groups = view.container.querySelectorAll('nav');
    expect(groups).toHaveLength(3);
    expect(within(groups[0]).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Inicio', 'Descubrir', 'Podcasts', 'Live']);
    expect(within(groups[1]).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Canciones', 'Álbumes', 'Artistas', 'Listas', 'Favoritos']);
    expect(within(groups[2]).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Descargas', 'Ajustes']);
    expect(view.getByRole('heading', { level: 2, name: 'Colección' })).toBeInTheDocument();
  });

  it('opens Home directly when clicking Inicio after visiting Songs then an Artist', async () => {
    window.history.replaceState({}, '', '/songs');
    const view = renderSidebar();
    expect([...view.container.querySelectorAll('[aria-current="page"]')].map((link) => link.textContent?.trim())).toEqual(['Canciones']);

    navigate('/artist/example?view=library');
    await waitFor(() => expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(0));

    fireEvent.click(view.getByRole('link', { name: 'Inicio' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(view.getByRole('link', { name: 'Inicio' })).toHaveAttribute('aria-current', 'page');
  });

  it('navigates directly to destination roots in the sidebar instead of restoring another route subpage', async () => {
    window.history.replaceState({}, '', '/settings/devices');
    const view = renderSidebar();
    navigate('/songs');
    await waitFor(() => expect(window.location.pathname).toBe('/songs'));

    fireEvent.click(view.getByRole('link', { name: 'Ajustes' }));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    expect(view.getByRole('link', { name: 'Ajustes' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps Discover query root intact when returning from a neutral entity page', async () => {
    window.history.replaceState({}, '', '/search?q=band');
    const view = renderSidebar();
    navigate('/artist/example?view=discover');
    await waitFor(() => expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(0));

    fireEvent.click(view.getByRole('link', { name: 'Descubrir' }));
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/search?q=band'));
    expect(view.getByRole('link', { name: 'Descubrir' })).toHaveAttribute('aria-current', 'page');
  });

  it.each(['/bookmarks', '/bookmarks/albums', '/artist/example', '/album/record?artist=example'])('highlights no sidebar entry on %s and lets Inicio open Home', async (path) => {
    window.history.replaceState({}, '', path);
    const view = renderSidebar();
    expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    fireEvent.click(view.getByRole('link', { name: 'Inicio' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
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
    const brand = view.getByRole('link', { name: 'soundsible' });
    const home = view.getByRole('link', { name: 'Inicio' });
    const downloads = view.getByRole('link', { name: /Descargas/ });

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(aside).not.toHaveAttribute('data-collapsed');
    expect(downloads).toHaveTextContent('1');

    fireEvent.click(toggle);

    expect(sidebarCollapsed()).toBe(true);
    expect(aside).toHaveAttribute('data-collapsed', '');
    expect(document.documentElement.hasAttribute('data-sidebar-collapsed')).toBe(true);
    expect(localStorage.getItem('sidebar:collapsed:v1')).toBe('1');
    expect(view.queryByRole('link', { name: 'soundsible' })).toBeNull();
    expect(view.getByRole('button', { name: 'Expandir barra lateral' })).toBe(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(view.queryByRole('heading', { level: 2, name: 'Colección' })).toBeNull();
    expect(view.getByRole('link', { name: 'Inicio' })).toBe(home);
    expect(home).toHaveAttribute('title', 'Inicio');
    expect(view.getByRole('link', { name: 'Canciones' })).toHaveAttribute('data-nav-href', '/songs');
    expect(view.getByRole('link', { name: 'Descargas' })).toBe(downloads);
    expect(downloads.querySelector(`.${styles.badgeDot}`)).not.toBeNull();

    fireEvent.click(toggle);
    expect(sidebarCollapsed()).toBe(false);
    expect(aside).not.toHaveAttribute('data-collapsed');
    expect(view.getByRole('link', { name: 'soundsible' })).toBe(brand);
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
