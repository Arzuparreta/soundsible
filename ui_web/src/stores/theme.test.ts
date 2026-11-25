import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { themeBootScript } from '../boot/plugin';
import { CUSTOM_COLORS_KEY, deriveCustomColors } from '../boot/customColors.js';
import { THEME_COLORS } from '../boot/themes';
import type { ResolvedTheme } from './core';

type Listener = (event: MediaQueryListEvent) => void;

/** Controllable prefers-color-scheme stub — jsdom ships no matchMedia at all. */
function installMatchMedia(prefersDark: boolean) {
  const listeners = new Set<Listener>();
  let matches = prefersDark;
  const mq = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: Listener) => void listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => void listeners.delete(fn),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mq),
  );
  return {
    listenerCount: () => listeners.size,
    /** Simulate the OS flipping its colour scheme. */
    set(next: boolean) {
      matches = next;
      for (const fn of [...listeners]) fn({ matches: next } as MediaQueryListEvent);
    },
  };
}

async function loadTheme(preference: string) {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('theme', preference);
  return import('./index');
}

beforeEach(() => {
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-custom-colors');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-transition');
  document.head.innerHTML = '<meta name="theme-color" content="#0c0c0e" />';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('system theme', () => {
  it('follows the OS preference at boot without animating the first paint', async () => {
    installMatchMedia(false);
    const { applyTheme } = await loadTheme('system');

    applyTheme('system');

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeTransition).toBeUndefined();
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#f6f6f7');
  });

  it('repaints with a cross-fade when the OS flips while running', async () => {
    vi.useFakeTimers();
    const os = installMatchMedia(false);
    const { applyTheme } = await loadTheme('system');
    applyTheme('system');

    os.set(true);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeTransition).toBe('');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#0c0c0e');

    vi.runAllTimers();
    expect(document.documentElement.dataset.themeTransition).toBeUndefined();
  });

  it('re-reads the OS preference when a suspended PWA becomes visible again', async () => {
    const os = installMatchMedia(false);
    const { applyTheme } = await loadTheme('system');
    applyTheme('system');

    // The OS flipped while backgrounded and the change event never landed.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    installMatchMedia(true);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(os.listenerCount()).toBe(1); // still attached to the original query
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('detaches the OS listener once an explicit theme is chosen', async () => {
    const os = installMatchMedia(false);
    const { applyTheme } = await loadTheme('system');
    applyTheme('system');
    expect(os.listenerCount()).toBe(1);

    applyTheme('dark');
    expect(os.listenerCount()).toBe(0);
    expect(document.documentElement.dataset.theme).toBe('dark');

    os.set(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});


describe('custom colors', () => {
  it.each(['slate', 'pure-black', 'forest-green'])('resets retired %s to system', async (mode) => {
    installMatchMedia(false);
    const { state } = await loadTheme(mode);
    new Function(themeBootScript())();
    expect(state.theme).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement).not.toHaveAttribute('data-custom-colors');
  });

  it('agrees before and after boot, ignores OS changes and clears its custom tokens on exit', async () => {
    const os = installMatchMedia(false);
    const { actions, applyTheme, state } = await loadTheme('custom');
    const colors = { canvas: '#201a5b', accent: '#ff6050' };
    actions.setTheme('custom', colors);
    expect(JSON.parse(localStorage.getItem(CUSTOM_COLORS_KEY)!)).toEqual(colors);
    const base = deriveCustomColors(colors).tokens['bg-base'];
    new Function(themeBootScript())();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('meta')?.getAttribute('content')).toBe(base);
    applyTheme(state.theme);
    expect(document.querySelector('meta')?.getAttribute('content')).toBe(base);
    expect(os.listenerCount()).toBe(0);
    os.set(true);
    actions.setTheme('system');
    expect(document.documentElement).not.toHaveAttribute('data-custom-colors');
    expect(document.documentElement.style.getPropertyValue('--custom-bg-base')).toBe('');
    expect(document.querySelector('meta')?.getAttribute('content')).toBe(THEME_COLORS.dark);
  });
});

describe('pre-paint boot script', () => {
  // One palette table, stamped from two sides of hydration: the inline script
  // before first paint and the store once Solid mounts. A theme that reaches
  // only one of them is a status bar that changes colour a beat after launch.
  it.each(Object.keys(THEME_COLORS) as ResolvedTheme[])('agrees with the running app on %s', async theme => {
    installMatchMedia(false);
    localStorage.setItem('theme', theme);

    new Function(themeBootScript())();
    const booted = document.querySelector('meta[name="theme-color"]')?.getAttribute('content');
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(booted).toBe(THEME_COLORS[theme]);

    const { applyTheme } = await loadTheme(theme);
    applyTheme(theme);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(booted);
  });
});


describe('telling the desktop shell', () => {
  /*
   * The shell is on screen before the player is, in another origin, painting
   * from a file the engine writes. This is the only moment that file is ever
   * written — and it must not fire in a browser, where there is no shell to
   * hear it and no owner token to authorise it.
   */
  async function loadWithApi(preference: string, token: string | null) {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem('theme', preference);
    const setDesktopAppearance = vi.fn().mockResolvedValue({ status: 'updated' });
    vi.doMock('../lib/config', async () => ({
      ...(await vi.importActual<object>('../lib/config')),
      ownerToken: () => token,
    }));
    vi.doMock('../lib/api', async () => {
      const actual = await vi.importActual<{ api: object }>('../lib/api');
      return { ...actual, api: { ...actual.api, setDesktopAppearance } };
    });
    return { store: await import('./index'), setDesktopAppearance };
  }

  afterEach(() => vi.doUnmock('../lib/api'));

  it('hands the shell the generated palette and resolves edits to the latest seeds', async () => {
    vi.useFakeTimers();
    installMatchMedia(false);
    const { store, setDesktopAppearance } = await loadWithApi('dark', 'owner-token');

    store.actions.setTheme('custom');

    const seeds = { canvas: '#ffffff', accent: '#000fff' };
    store.actions.setTheme('custom', seeds);
    await vi.runAllTimersAsync();
    const { tokens } = deriveCustomColors(seeds);
    expect(setDesktopAppearance).toHaveBeenCalledExactlyOnceWith('custom', {
      ...THEME_COLORS, ...tokens, 'custom-light': tokens['bg-base'],
    });
  });

  it('sends the preference, so the shell resolves `system` against its own desktop', async () => {
    installMatchMedia(false);
    const { store, setDesktopAppearance } = await loadWithApi('dark', 'owner-token');

    store.actions.setTheme('system');

    expect(setDesktopAppearance).toHaveBeenCalledWith('system', THEME_COLORS);
  });

  it('stays quiet in a browser, where there is no shell', async () => {
    installMatchMedia(false);
    const { store, setDesktopAppearance } = await loadWithApi('dark', null);

    store.actions.setTheme('custom');

    expect(setDesktopAppearance).not.toHaveBeenCalled();
  });

  it('still changes the theme when the engine refuses the news', async () => {
    vi.useFakeTimers();
    installMatchMedia(false);
    const { store, setDesktopAppearance } = await loadWithApi('dark', 'owner-token');
    setDesktopAppearance.mockRejectedValue(new Error('offline'));

    store.actions.setTheme('custom');

    expect(document.documentElement).toHaveAttribute('data-custom-colors');
    expect(localStorage.getItem('theme')).toBe('custom');
    await vi.runAllTimersAsync();
    expect(setDesktopAppearance).toHaveBeenCalledTimes(1);
  });
});
