import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Route, Router, type RouteSectionProps } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import styles from './TabBar.module.css';
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

beforeEach(async () => {
  // Non-English dictionaries load on demand now.
  await setLocale('es');
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  document.querySelectorAll('[data-primary-scroll]').forEach((node) => node.remove());
});

describe('mobile tab bar', () => {
  it('exposes the five decided top-level destinations', () => {
    const view = renderTabs();
    const bar = view.container.querySelector('nav')!;

    expect([...bar.children].map((tab) => tab.textContent?.trim())).toEqual([
      'Biblioteca',
      'Buscar',
      'Live',
      'Listas',
      'Ajustes',
    ]);
  });

  it('navigates to settings and marks its subroutes active', async () => {
    window.history.replaceState({}, '', '/settings/devices');
    renderTabs();
    const tab = screen.getByRole('link', { name: 'Ajustes' });
    expect(tab).toHaveClass(styles.active);
    fireEvent.click(tab);
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    expect(tab).toHaveAttribute('aria-current', 'page');
  });

  it('reselecting the settings index scrolls to the top', () => {
    window.history.replaceState({}, '', '/settings');
    const surface = document.createElement('div');
    surface.dataset.primaryScroll = '';
    surface.scrollTo = vi.fn();
    document.body.append(surface);
    renderTabs();
    fireEvent.click(screen.getByRole('link', { name: 'Ajustes' }));
    expect(surface.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
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
