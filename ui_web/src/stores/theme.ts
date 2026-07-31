/**
 * Appearance: the stored preference, what it resolves to, and keeping the
 * document in sync with the OS while it is `system`.
 *
 * Self-contained — it reads `state.theme` and writes to the document, nothing
 * else — which is why it is the first domain to leave `index.ts`.
 */

import { state } from './core';
import type { ResolvedTheme, Theme } from './core';

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve a stored preference to the concrete dark/light tokens to apply. */
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
    if (state.theme === 'system') applyResolvedTheme(resolveTheme('system'), true);
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
    if (state.theme === 'system') applyResolvedTheme(resolveTheme('system'), true);
  };
  document.addEventListener('visibilitychange', systemVisibilityListener);
}

/** Keep in sync with --dur-short in tokens.css (plus a little slack). */
const THEME_TRANSITION_MS = 260;
let themeTransitionTimer: ReturnType<typeof setTimeout> | null = null;

/** Paint the resolved theme and the mobile status-bar colour. `animate` arms the
 * `[data-theme-transition]` cross-fade in tokens.css; the boot paint leaves it off
 * so the first frame is never animated. */
function applyResolvedTheme(resolved: ResolvedTheme, animate = false): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.theme === resolved) return;

  if (animate) {
    root.dataset.themeTransition = '';
    // Flush styles so the transition rule is in effect *before* the tokens flip;
    // without it some engines coalesce both changes and skip the animation.
    void root.offsetWidth;
    if (themeTransitionTimer) clearTimeout(themeTransitionTimer);
    themeTransitionTimer = setTimeout(() => {
      delete root.dataset.themeTransition;
      themeTransitionTimer = null;
    }, THEME_TRANSITION_MS);
  }

  root.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f6f6f7' : '#0c0c0e');
}

/** Apply the theme to the document (token overrides live in tokens.css) and
 * sync the mobile status-bar colour. When `system`, follows prefers-color-scheme
 * and re-applies if the OS preference changes. */
export function applyTheme(theme: Theme, animate = false): void {
  applyResolvedTheme(resolveTheme(theme), animate);
  syncSystemThemeListener(theme);
}
