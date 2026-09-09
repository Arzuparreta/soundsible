import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Route, Router, type RouteSectionProps } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import styles from './TabBar.module.css';
import { OverlayOutlet } from '../lib/overlay';
import { setMobileLibrarySection } from '../lib/libraryView';
import { setState } from '../stores/core';
import { TabBar } from './TabBar';

function renderTabs() {
  const Root = (props: RouteSectionProps) => (
    <>
      <TabBar /><OverlayOutlet />
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
  setMobileLibrarySection('library');
  setState('downloads', 'queue', []);
});

afterEach(() => {
  document.querySelectorAll('[data-primary-scroll]').forEach((node) => node.remove());
});

describe('mobile tab bar', () => {
  it('exposes three destinations and More', () => {
    const view = renderTabs();
    expect([...view.container.querySelector('nav')!.children].map((tab) => tab.textContent?.trim()))
      .toEqual(['Biblioteca', 'Buscar', 'Listas', 'Más']);
  });

  it('opens settings through More and marks its subroutes active', async () => {
    window.history.replaceState({}, '', '/settings/devices');
    renderTabs();
    const tab = screen.getByRole('button', { name: 'Más' });
    expect(tab).toHaveClass(styles.active);
    fireEvent.click(tab);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajustes' }));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the download count live while More is open', async () => {
    renderTabs();
    setState('downloads', 'queue', [{ id: 'one', status: 'pending' }]);
    fireEvent.click(screen.getByRole('button', { name: /Más/ }));
    expect(await screen.findByRole('button', { name: 'Descargas (1)' })).toBeInTheDocument();
    setState('downloads', 'queue', []);
    expect(screen.getByRole('button', { name: 'Descargas' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('restores Favourites when returning to Library', async () => {
    setMobileLibrarySection('favourites');
    window.history.replaceState({}, '', '/search');
    renderTabs();
    fireEvent.click(screen.getByRole('link', { name: 'Biblioteca' }));
    await waitFor(() => expect(window.location.pathname).toBe('/favourites'));
    expect(screen.getByRole('link', { name: 'Biblioteca' })).toHaveClass(styles.active);
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
