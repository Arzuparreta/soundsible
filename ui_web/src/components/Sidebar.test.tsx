import { fireEvent, render, within, waitFor } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../lib/i18n';
import styles from './Sidebar.module.css';
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
  it('uses the same five primary destinations and order as mobile', () => {
    const view = renderSidebar();
    const groups = view.container.querySelectorAll('nav');

    expect([...groups[0].children].map((item) => item.textContent?.trim()))
      .toEqual(['Biblioteca', 'Buscar', 'Live', 'Listas', 'Ajustes']);
    expect(within(groups[1] as HTMLElement).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Podcasts', 'Favoritos', 'Descargas']);
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
