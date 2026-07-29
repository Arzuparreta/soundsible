import { render, within } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../lib/i18n';
import { Sidebar } from './Sidebar';

beforeEach(() => {
  setLocale('es');
  window.history.pushState({}, '', '/');
});

describe('desktop sidebar', () => {
  it('keeps the complete desktop IA while mobile stays thumb-sized', () => {
    const view = render(() => (
      <Router>
        <Route path="*" component={Sidebar} />
      </Router>
    ));
    const groups = view.container.querySelectorAll('nav');

    expect(within(groups[0] as HTMLElement).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Buscar', 'Biblioteca', 'Listas', 'Podcasts', 'Ajustes']);
    expect(within(groups[1] as HTMLElement).getAllByRole('link').map((link) => link.textContent?.trim()))
      .toEqual(['Favoritos', 'Descargas']);
  });
});
