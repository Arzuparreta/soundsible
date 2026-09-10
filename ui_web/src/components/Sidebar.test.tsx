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
  it.each(['/', '/library', '/search', '/artist/example'])('opens Songs from %s even after choosing another view', async (path) => {
    window.history.replaceState({}, '', path);
    setLibraryTab('albums');
    const view = renderSidebar();
    fireEvent.click(view.getByRole('link', { name: 'Biblioteca' }));
    await waitFor(() => expect(libraryTab()).toBe('songs'));
    await waitFor(() => expect(['/', '/library']).toContain(window.location.pathname));
  });

  it('exposes the complete grouped navigation', () => {
    const view = renderSidebar();
    const groups = view.container.querySelectorAll('nav');
    expect(within(groups[0]).getAllByRole('link').map(link => link.textContent?.trim()))
      .toEqual(['Biblioteca', 'Canciones', 'Álbumes', 'Artistas', 'Favoritos', 'Listas']);
    expect(within(groups[1]).getAllByRole('link').map(link => link.textContent?.trim()))
      .toEqual(['Buscar', 'Podcasts', 'Live']);
    expect(within(groups[2]).getAllByRole('link').map(link => link.textContent?.trim()))
      .toEqual(['Descargas', 'Ajustes']);
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
