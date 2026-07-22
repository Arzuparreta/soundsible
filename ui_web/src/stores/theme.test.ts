import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
