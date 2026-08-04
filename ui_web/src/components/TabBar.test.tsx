import { fireEvent, render, screen } from '@solidjs/testing-library';
import { Route, Router, type RouteSectionProps } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import { dismissSettings, settingsOpen } from '../lib/settingsSurface';
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
  dismissSettings();
  document.querySelectorAll('[data-primary-scroll]').forEach((node) => node.remove());
});

describe('mobile tab bar', () => {
  it('exposes the five decided top-level destinations', () => {
    const view = renderTabs();
    const bar = view.container.querySelector('nav')!;

    // Read the bar itself, not the links: settings is a button now, and the
    // IA is the order on screen regardless of what each entry is made of.
    expect([...bar.children].map((tab) => tab.textContent?.trim())).toEqual([
      'Biblioteca',
      'Buscar',
      'Live',
      'Listas',
      'Ajustes',
    ]);
  });

  it('settings opens its window instead of navigating anywhere', () => {
    renderTabs();
    expect(screen.queryByRole('link', { name: 'Ajustes' })).toBeNull();

    const tab = screen.getByRole('button', { name: 'Ajustes' });
    expect(tab).not.toHaveAttribute('aria-current');

    fireEvent.click(tab);

    expect(settingsOpen()).toBe(true);
    // Nothing routed, so the router's active state can't light the tab — the
    // window's own state has to.
    expect(tab).toHaveAttribute('aria-current', 'true');
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
