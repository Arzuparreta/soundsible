/**
 * What the document has to know about themes before anything loads.
 *
 * The pre-paint boot script and the running app both stamp the mobile
 * status-bar colour, from opposite sides of hydration, so the palette lives
 * here — one table, imported by the store and inlined into the boot script by
 * the build. A new theme that reaches only one of them is a status bar that
 * changes colour a beat after launch.
 */

import type { ResolvedTheme, Theme } from '../stores/core';

/** Every preference the store will accept out of localStorage. */
export const THEMES: Theme[] = ['light', 'dark', 'system', 'slate', 'pure-black'];

/** --bg-base of each palette, as the mobile status bar paints it. */
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#f6f6f7',
  dark: '#0c0c0e',
  slate: '#252d38',
  'pure-black': '#000000',
};
