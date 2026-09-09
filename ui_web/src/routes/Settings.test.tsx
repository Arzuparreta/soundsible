import { createSignal } from 'solid-js';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { HashRouter, Route, type RouteSectionProps } from '@solidjs/router';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import tabStyles from '../components/TabBar.module.css';
import { TabBar } from '../components/TabBar';
import { NavRow } from '../components/SettingsRows';
import { OverlayOutlet, openOverlay } from '../lib/overlay';
import { setLocale } from '../lib/i18n';
import { setMediaQuery } from '../test-setup';
import Settings from './Settings';

const [admin, setAdmin] = createSignal(true);
vi.mock('../components/SettingsSections', () => {
  const sections = [
    { id: 'account', title: () => 'Cuenta', blurb: () => 'Tu perfil', icon: () => null,
      keywords: () => ['contraseña'], content: () => 'Perfil' },
    { id: 'devices', title: () => 'Dispositivos', blurb: () => 'Conexiones', icon: () => null,
      keywords: () => [], content: () => <>
        <button onClick={() => openOverlay(() => <button>Confirmar</button>, { ariaLabel: 'Emparejar' })}>Emparejar</button>
        <NavRow href="/downloads" label="Descargas" />
      </> },
    { id: 'users', title: () => 'Usuarios', blurb: () => 'Administración', icon: () => null,
      keywords: () => [], content: () => 'Administrar usuarios' },
  ];
  const visibleSections = () => sections.filter((section) => section.id !== 'users' || admin());
  return {
    SETTINGS_GROUPS: [{ label: () => 'Preferencias', ids: sections.map((section) => section.id) }],
    visibleSections,
    findSection: (id?: string) => visibleSections().find((section) => section.id === id),
  };
});

function mount(path = '/settings') {
  window.history.replaceState({}, '', `/player/#${path}`);
  const Root = (props: RouteSectionProps) => <><main>{props.children}</main><TabBar /><OverlayOutlet /></>;
  return render(() => <HashRouter root={Root}>
    <Route path="/settings" component={Settings} />
    <Route path="/settings/:section" component={Settings} />
    <Route path="/downloads" component={() => <h1>Descargas</h1>} />
    <Route path="/search" component={() => <h1>Buscar música</h1>} />
  </HashRouter>);
}

beforeEach(async () => {
  await setLocale('es');
  setAdmin(true);
  setMediaQuery('(min-width: 1024px)', false);
});
afterEach(() => setMediaQuery('(min-width: 1024px)', false));

describe('integrated settings routes', () => {
  it('keeps navigation available through categories, back and forward', async () => {
    mount('/search');
    fireEvent.click(screen.getByRole('button', { name: 'Más' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ajustes' }));
    await screen.findByRole('heading', { name: 'Ajustes' });
    fireEvent.click(screen.getByRole('button', { name: /Dispositivos/ }));
    await screen.findByRole('heading', { name: 'Dispositivos' });
    expect(window.location.hash).toBe('#/settings/devices');
    expect(screen.getByRole('button', { name: 'Más' })).toHaveClass(tabStyles.active);
    expect(screen.queryByRole('dialog')).toBeNull();
    window.history.back();
    await screen.findByRole('heading', { name: 'Ajustes' });
    window.history.back();
    await screen.findByRole('heading', { name: 'Buscar música' });
    window.history.forward();
    await screen.findByRole('heading', { name: 'Ajustes' });
    window.history.forward();
    await screen.findByRole('heading', { name: 'Dispositivos' });
    fireEvent.click(screen.getByRole('link', { name: 'Buscar' }));
    await screen.findByRole('heading', { name: 'Buscar música' });
  });

  it('keeps direct links on their URL and the mobile back button inside settings', async () => {
    mount('/settings/devices');
    await screen.findByRole('heading', { name: 'Dispositivos' });
    expect(window.location.hash).toBe('#/settings/devices');
    fireEvent.click(screen.getByRole('button', { name: 'Volver' }));
    await screen.findByRole('heading', { name: 'Ajustes' });
    expect(window.location.hash).toBe('#/settings');
  });

  it.each(['/settings/removed', '/settings/users'])('replaces invalid or inaccessible route %s', async (path) => {
    setAdmin(false);
    mount(path);
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(screen.queryByText('Administrar usuarios')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Ajustes' })).toBeInTheDocument();
  });

  it('returns to the index when permission is revoked while a section is open', async () => {
    mount('/settings/users');
    await screen.findByText('Administrar usuarios');
    setAdmin(false);
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(screen.queryByText('Administrar usuarios')).toBeNull();
  });

  it('shows the desktop default without rewriting history when the layout changes', async () => {
    setMediaQuery('(min-width: 1024px)', true);
    const view = mount();
    await screen.findByRole('heading', { name: 'Cuenta' });
    expect(window.location.hash).toBe('#/settings');
    expect(view.container.querySelectorAll('[data-primary-scroll]')).toHaveLength(1);
    setMediaQuery('(min-width: 1024px)', false);
    expect(screen.queryByRole('heading', { name: 'Cuenta' })).toBeNull();
    expect(window.location.hash).toBe('#/settings');
    expect(view.container.querySelectorAll('[data-primary-scroll]')).toHaveLength(1);
  });

  it('dismisses an action dialog with Escape without leaving settings', async () => {
    mount('/settings/devices');
    fireEvent.click(await screen.findByRole('button', { name: 'Emparejar' }));
    expect(screen.getByRole('dialog', { name: 'Emparejar' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Dispositivos' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(window.location.hash).toBe('#/settings/devices');
  });

  it('routes settings rows to other pages and restores the category on back', async () => {
    mount('/settings/devices');
    fireEvent.click(await screen.findByRole('link', { name: 'Descargas' }));
    await screen.findByRole('heading', { name: 'Descargas' });
    window.history.back();
    await screen.findByRole('heading', { name: 'Dispositivos' });
  });
});
