import { fireEvent, render, screen } from '@solidjs/testing-library';
import { Route, Router, type RouteSectionProps } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import { TabBar } from './TabBar';

function renderTabs() {
  const Root = (props: RouteSectionProps) => (
    <>
      <TabBar />
      {props.children}
    </>
  );
  return render(() => (
    <Router root={Root}>
      <Route path="*" component={() => null} />
    </Router>
  ));
}

beforeEach(() => {
  setLocale('es');
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  document.querySelectorAll('[data-primary-scroll]').forEach((node) => node.remove());
});

describe('mobile tab bar', () => {
  it('exposes the five decided top-level destinations', () => {
    renderTabs();
    expect(screen.getAllByRole('link').map((link) => link.textContent?.trim())).toEqual([
      'Buscar',
      'Biblioteca',
      'Listas',
      'Podcasts',
      'Ajustes',
    ]);
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
