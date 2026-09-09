import { createSignal } from 'solid-js';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import { setMediaQuery } from '../test-setup';
import SettingsShell from './SettingsShell';

/**
 * The registry is stubbed on purpose. What is under test here is the shell —
 * how it pushes, splits, searches and recovers from a dead id — and the real
 * registry drags the whole app in to prove none of that. Its own rules are
 * covered by lib/settingsIndex.test.ts.
 */
const { sections } = vi.hoisted(() => ({
  sections: [
    {
      id: 'account',
      title: () => 'Cuenta',
      blurb: () => 'Tu perfil',
      tone: 'accent',
      icon: () => null,
      keywords: () => ['contraseña'],
      content: () => 'panel de cuenta',
    },
    {
      id: 'playback',
      title: () => 'Reproducción',
      blurb: () => 'Cómo suena',
      tone: 'neutral',
      icon: () => null,
      keywords: () => ['crossfade'],
      content: () => 'panel de reproducción',
    },
  ],
}));

vi.mock('./SettingsSections', () => ({
  SETTINGS_GROUPS: [
    { label: () => 'Tú', ids: ['account'] },
    { label: () => 'Sistema', ids: ['playback'] },
  ],
  visibleSections: () => sections,
  findSection: (id?: string) => sections.find((section) => section.id === id),
}));

const DESKTOP = '(min-width: 1024px)';

function renderShell(initial: string | null = null) {
  const [section, setSection] = createSignal<string | null>(initial);
  const view = render(() => (
    <SettingsShell section={section()} onSectionChange={setSection} />
  ));
  return { ...view, section };
}

beforeEach(async () => {
  await setLocale('es');
  setMediaQuery(DESKTOP, false);
});

afterEach(() => setMediaQuery(DESKTOP, false));

describe('settings shell on mobile', () => {
  it('pushes a submenu over the index and comes back', () => {
    const { section } = renderShell();

    expect(screen.getByRole('heading', { name: 'Ajustes', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Tu perfil')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Reproducción/ }));

    expect(section()).toBe('playback');
    // The submenu fills the route outlet, so the index is gone and the title
    // names where you are — one h1, not two with one hidden.
    expect(screen.getByRole('heading', { name: 'Reproducción' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ajustes' })).toBeNull();
    expect(screen.getByText('panel de reproducción')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Volver' }));

    expect(section()).toBeNull();
    expect(screen.getByRole('heading', { name: 'Ajustes', level: 1 })).toBeInTheDocument();
  });

  it('starts on the index rather than resuming a submenu', () => {
    renderShell();
    expect(screen.getByRole('heading', { name: 'Ajustes', level: 1 })).toBeInTheDocument();
  });

  it('filters the index by a label living inside a submenu', () => {
    renderShell();

    fireEvent.input(screen.getByPlaceholderText('Buscar en ajustes'), {
      target: { value: 'crossfade' },
    });

    expect(screen.getByRole('button', { name: /Reproducción/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cuenta/ })).toBeNull();
  });

  it('has no modal close control and registers the index scroller', () => {
    const view = renderShell();
    expect(screen.queryByRole('button', { name: 'Cerrar ajustes' })).toBeNull();
    expect(view.container.querySelectorAll('[data-primary-scroll]')).toHaveLength(1);
  });

});

describe('settings shell on desktop', () => {
  beforeEach(() => setMediaQuery(DESKTOP, true));

  it('keeps the index beside the open submenu, with nothing to go back to', () => {
    renderShell('playback');

    expect(screen.getByRole('button', { name: /Cuenta/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Reproducción' })).toBeInTheDocument();
    expect(screen.getByText('panel de reproducción')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Volver' })).toBeNull();
  });

  it('never leaves the right-hand pane empty', () => {
    const { section } = renderShell();

    expect(section()).toBeNull();
    expect(screen.getByRole('button', { name: /Cuenta/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('panel de cuenta')).toBeInTheDocument();
  });

  it('drops the blurbs the narrow rail has no room for', () => {
    renderShell('account');

    expect(screen.getByRole('button', { name: /Cuenta/ })).toBeInTheDocument();
    expect(screen.queryByText('Tu perfil')).toBeNull();
  });

  it('reveals the index again when the window narrows', () => {
    renderShell('playback');
    expect(screen.getByRole('button', { name: /Cuenta/ })).toBeInTheDocument();

    setMediaQuery(DESKTOP, false);

    // Mobile is a push stack: the open submenu fills the route outlet.
    expect(screen.queryByRole('button', { name: /Cuenta/ })).toBeNull();
    expect(screen.getByText('panel de reproducción')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volver' })).toBeInTheDocument();
  });
});

// Navigation behavior is covered by the router integration and browser tests.
vi.mock('./NavigationMenu', () => ({ NavigationMenuButton: () => null }));
