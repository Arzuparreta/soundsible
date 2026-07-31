import { render, within } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../lib/i18n';
import { Sidebar } from './Sidebar';

beforeEach(async () => {
  // Non-English dictionaries load on demand now.
  await setLocale('es');
  window.history.pushState({}, '', '/');
});

describe('desktop sidebar', () => {
  it('uses the same five primary destinations and order as mobile', () => {
    const view = render(() => (
      <Router>
        <Route path="*" component={Sidebar} />
      </Router>
    ));
    const groups = view.container.querySelectorAll('nav');

    expect(within(groups[0] as HTMLElement).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Biblioteca', 'Buscar', 'Listas', 'Podcasts', 'Ajustes']);
    expect(within(groups[1] as HTMLElement).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Favoritos', 'Descargas']);
  });
});
