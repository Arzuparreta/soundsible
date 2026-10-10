import { desktopBridge } from '../lib/desktopBridge';
/**
 * Appearance: the stored preference, what it resolves to, and keeping the
 * document in sync with the OS while it is `system`.
 *
 * Self-contained — it reads `state.theme` and writes to the document, nothing
 * else — which is why it is the first domain to leave `index.ts`.
 */

import { THEME_COLORS } from '../boot/themes';
import { api } from '../lib/api';
import { ownerToken } from '../lib/config';
import { state } from './core';
import type { ResolvedTheme, Theme } from './core';

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve a stored preference to the concrete palette tokens to apply. */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return theme;
}

let systemMediaQuery: MediaQueryList | null = null;
let systemMediaListener: ((event: MediaQueryListEvent) => void) | null = null;
let systemVisibilityListener: (() => void) | null = null;

/** Keep following OS changes while the preference is `system`; detach otherwise. */
function syncSystemThemeListener(theme: Theme): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

  if (systemMediaQuery && systemMediaListener) {
    if (typeof systemMediaQuery.removeEventListener === 'function') {
      systemMediaQuery.removeEventListener('change', systemMediaListener);
    } else {
      // Safari < 14
      systemMediaQuery.removeListener(systemMediaListener);
    }
  }
  if (systemVisibilityListener) {
    document.removeEventListener('visibilitychange', systemVisibilityListener);
  }
  systemMediaQuery = null;
  systemMediaListener = null;
  systemVisibilityListener = null;

  if (theme !== 'system') return;

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  systemMediaListener = () => {
    if (state.theme === 'system') applyResolvedTheme(resolveTheme('system'));
  };
  systemMediaQuery = mq;
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', systemMediaListener);
  } else {
    mq.addListener(systemMediaListener);
  }

  // Installed PWAs get frozen in the background, where a change event may be
  // dropped instead of queued. Re-reading the query on the way back to visible
  // catches an OS flip that happened while we were suspended; when nothing
  // changed, applyResolvedTheme is a no-op.
  systemVisibilityListener = () => {
    if (document.visibilityState !== 'visible') return;
    if (state.theme === 'system') applyResolvedTheme(resolveTheme('system'));
  };
  document.addEventListener('visibilitychange', systemVisibilityListener);
}

/** Paint the complete palette together, including the mobile status bar.
 * A document-wide transition leaves surfaces interpolating from the previous
 * palette while navigation can mount the next route. */
function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.theme === resolved) return;

  // Existing controls have their own hover/focus colour transitions. Disable
  // those just for this style commit so none retain the previous palette.
  root.dataset.themePaint = '';
  root.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved]);
  void root.offsetWidth;
  delete root.dataset.themePaint;
}

/**
 * Tell the desktop shell which palette to paint.
 *
 * The shell owns the window before the player does — first run, engine
 * starting, engine failed — and it lives at another origin, so it can see
 * neither this localStorage nor this document. The engine writes the answer to
 * a file both sides can reach. An owner token is only injected into
 * /player/desktop/, so its presence *is* "I am inside the shell"; everywhere
 * else this is a no-op.
 *
 * Best-effort on purpose: a preference the shell never hears about is a stale
 * splash screen, not a reason to refuse the theme the listener just chose.
 */
export function announceTheme(theme: Theme): void {
  const bridge = desktopBridge();
  if (bridge) { void bridge.appearance(theme, THEME_COLORS).catch(() => {}); return; }
  if (!ownerToken()) return;
  void api.setDesktopAppearance(theme, THEME_COLORS).catch(() => {});
}

/** Apply the theme to the document (token overrides live in tokens.css) and
 * sync the mobile status-bar colour. When `system`, follows prefers-color-scheme
 * and re-applies if the OS preference changes. */
export function applyTheme(theme: Theme): void {
  applyResolvedTheme(resolveTheme(theme));
  syncSystemThemeListener(theme);
}
