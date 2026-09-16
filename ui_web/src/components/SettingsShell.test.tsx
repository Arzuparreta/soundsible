import { createSignal, Show, type JSX } from 'solid-js';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import { setMediaQuery } from '../test-setup';
import SettingsShell from './SettingsShell';

/**
 * The registry is stubbed on purpose. What is under test here is the shell —
 * how it pushes, splits, searches and recovers from a dead id — and the real
 * registry drags the whole app in to prove none of that. Its own rules are
 * covered by lib/settingsIndex.test.ts; the search reads the real catalog, so
 * these two stand-ins find the real settings of the submenus they stand for.
 */
const { sections } = vi.hoisted(() => ({
  sections: [
    {
      id: 'account',
      title: () => 'Cuenta',
      blurb: () => 'Tu perfil',
      tone: 'accent',
      icon: () => null,
      content: (): unknown => 'panel de cuenta',
    },
    {
      id: 'playback',
      title: () => 'Reproducción',
      blurb: () => 'Cómo suena',
      tone: 'neutral',
      icon: () => null,
      content: (): unknown => 'panel de reproducción',
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
  settingsCapabilities: () => ({ admin: true, sharedLinks: false }),
}));

const DESKTOP = '(min-width: 1024px)';

function renderShell(initial: string | null = null, landing: string | null = null) {
  const [section, setSection] = createSignal<string | null>(initial);
  const [setting, setSetting] = createSignal<string | null>(landing);
  const [query, setQuery] = createSignal('');
  const view = render(() => (
    <SettingsShell
      section={section()}
      setting={setting()}
      query={query()}
      onQueryChange={setQuery}
      onSectionChange={(id, anchor) => {
        setSection(id);
        setSetting(anchor ?? null);
      }}
    />
  ));
  return { ...view, section, setting, query };
}

/** Swap what a stand-in submenu draws, for one test. */
function drawing(id: string, content: () => JSX.Element) {
  const section = sections.find((candidate) => candidate.id === id)!;
  const original = section.content;
  section.content = content;
  onTestFinished(() => {
    section.content = original;
  });
}

function search(value: string) {
  fireEvent.input(screen.getByPlaceholderText('Buscar en ajustes'), { target: { value } });
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

  it('lists the settings inside every submenu, with where each one lives', () => {
    renderShell();

    search('igualar volumen');

    const result = screen.getByRole('button', { name: /Igualar el volumen entre canciones/ });
    expect(result).toHaveTextContent('Reproducción');
    expect([...result.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
      'Igualar',
      'volumen',
    ]);
    // The grouped index gives way to the results.
    expect(screen.queryByRole('button', { name: /Cuenta/ })).toBeNull();
    expect(screen.getByText('1 resultado')).toBeInTheDocument();
  });

  it('says so when nothing matches', () => {
    renderShell();

    search('podcasts');

    expect(screen.getByText('Nada coincide con «podcasts»')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cuenta/ })).toBeNull();
  });

  it('opens the submenu a result lives in, aimed at its row', () => {
    const { section, setting, query } = renderShell();

    search('contraseña');
    fireEvent.click(screen.getByRole('button', { name: /Cambiar contraseña/ }));

    expect(section()).toBe('account');
    expect(setting()).toBe('change-password');
    // The search survives the trip, so coming back finds the results.
    expect(query()).toBe('contraseña');
  });

  it('opens the best result from the keyboard, and walks the list with the arrows', () => {
    const { section, setting } = renderShell();
    const field = screen.getByPlaceholderText('Buscar en ajustes');

    search('cuenta');
    const results = screen.getAllByRole('button').filter((button) => button.hasAttribute('data-settings-result'));
    expect(results.length).toBeGreaterThan(1);

    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(results[0]).toHaveFocus();
    fireEvent.keyDown(results[0], { key: 'ArrowDown' });
    expect(results[1]).toHaveFocus();
    fireEvent.keyDown(results[1], { key: 'ArrowUp' });
    fireEvent.keyDown(results[0], { key: 'ArrowUp' });
    expect(field).toHaveFocus();

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(section()).toBe('account');
    expect(setting()).toBeNull();
  });

  it('marks the row it landed on', () => {
    drawing('playback', () => <div data-setting="volume-leveling">Igualar el volumen</div>);
    renderShell('playback', 'volume-leveling');

    expect(screen.getByText('Igualar el volumen')).toHaveAttribute('data-setting-flash');
  });

  it('waits for a row that its submenu loads late', async () => {
    const [loaded, setLoaded] = createSignal(false);
    drawing('playback', () => (
      <Show when={loaded()}>
        <div data-setting="autoplay">Reproducción automática</div>
      </Show>
    ));
    renderShell('playback', 'autoplay');

    setLoaded(true);

    await waitFor(() =>
      expect(screen.getByText('Reproducción automática')).toHaveAttribute('data-setting-flash'),
    );
  });

  it('opens the disclosure that hides the row', () => {
    drawing('account', () => (
      <details data-setting="sign-out">
        <summary>Más</summary>
        Cerrar sesión
      </details>
    ));
    const view = renderShell('account', 'sign-out');

    expect(view.container.querySelector('details')).toHaveProperty('open', true);
  });

  it('ignores an anchor that is not there', () => {
    drawing('playback', () => <div data-setting="autoplay">Reproducción automática</div>);
    renderShell('playback', 'nope"]');

    expect(screen.getByText('Reproducción automática')).not.toHaveAttribute('data-setting-flash');
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

  it('keeps the results beside the submenu a result opened', () => {
    const { section } = renderShell();

    search('contraseña');
    fireEvent.click(screen.getByRole('button', { name: /Cambiar contraseña/ }));

    expect(section()).toBe('account');
    expect(screen.getByRole('button', { name: /Cambiar contraseña/ })).toHaveAttribute('aria-current', 'true');
  });

  it('puts focus on the control it landed on', () => {
    drawing('playback', () => (
      <div data-setting="volume-leveling">
        Igualar el volumen
        <button type="button" role="switch" aria-checked="false">interruptor</button>
      </div>
    ));
    renderShell('playback', 'volume-leveling');

    expect(screen.getByRole('switch')).toHaveFocus();
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
