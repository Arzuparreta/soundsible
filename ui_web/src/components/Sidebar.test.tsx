import { libraryTab, setLibraryTab } from '../lib/libraryView';
import { fireEvent, render, within, waitFor } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../lib/i18n';
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

  it('exposes the complete grouped navigation', () => {
    const view = renderSidebar();
    const groups = view.container.querySelectorAll('nav');
    expect(within(groups[0]).getAllByRole('link').map(link => link.textContent?.trim()))
      .toEqual(['Biblioteca', 'Canciones', 'Álbumes', 'Artistas', 'Favoritos', 'Listas']);
    expect(within(groups[1]).getAllByRole('link').map(link => link.textContent?.trim()))
      .toEqual(['Descubrir', 'Podcasts', 'Live']);
    expect(within(groups[2]).getAllByRole('link').map(link => link.textContent?.trim()))
      .toEqual(['Descargas', 'Ajustes']);
  });

  it('announces one current page: the Library view, with Library marked as its branch', async () => {
    window.history.replaceState({}, '', '/library?view=songs');
    const view = renderSidebar();
    const current = view.container.querySelectorAll('[aria-current="page"]');
    expect([...current].map(link => link.textContent?.trim())).toEqual(['Canciones']);
    const library = view.getByRole('link', { name: 'Biblioteca' });
    expect(library).not.toHaveAttribute('aria-current');
    expect(library).toHaveClass(styles.inside);
    // Library is still the selected destination: choosing it climbs to its root.
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

  it('keeps the brand a link home that never claims the current page', async () => {
    window.history.replaceState({}, '', '/search');
    const view = renderSidebar();
    const brand = view.getByRole('link', { name: 'Soundsible' });
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
});
