import { fireEvent, render, within } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../lib/i18n';
import { dismissSettings, settingsOpen } from '../lib/settingsSurface';
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

afterEach(() => dismissSettings());

describe('desktop sidebar', () => {
  it('uses the same five primary destinations and order as mobile', () => {
    const view = renderSidebar();
    const groups = view.container.querySelectorAll('nav');

    // Read the group's children rather than its links: settings opens a window,
    // so it is a button, and the shared IA is the order either way.
    expect([...groups[0].children].map((item) => item.textContent?.trim()))
      .toEqual(['Biblioteca', 'Buscar', 'Live', 'Listas', 'Ajustes']);
    expect(within(groups[1] as HTMLElement).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Podcasts', 'Favoritos', 'Descargas']);
  });

  it('settings opens its window instead of navigating anywhere', () => {
    const view = renderSidebar();

    expect(view.queryByRole('link', { name: 'Ajustes' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Ajustes' }));

    expect(settingsOpen()).toBe(true);
    expect(view.getByRole('button', { name: 'Ajustes' })).toHaveAttribute('aria-current', 'true');
  });
});
