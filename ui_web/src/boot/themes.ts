/**
 * What the document has to know about themes before anything loads.
 *
 * The pre-paint boot script and the running app both stamp the mobile
 * status-bar colour, from opposite sides of hydration, so the palette lives
 * here — one table, imported by the store and inlined into the boot script by
 * the build. A new theme that reaches only one of them is a status bar that
 * changes colour a beat after launch.
 *
 * It is also the one list of themes: the store validates against it, the
 * settings picker renders from it, the style suites iterate it, and the desktop
 * shell reads it to check it has a palette for every one. Nothing is imported
 * here, deliberately — that is what lets those callers reach it.
 */

/** The palettes the segmented control does not show, offered in a select. */
export const EXTRA_THEMES = ['slate', 'pure-black', 'forest-green'] as const;

/** Every preference the store will accept out of localStorage. */
export const THEMES = ['light', 'dark', 'system', ...EXTRA_THEMES] as const;

/** User preference: an explicit palette, or follow the OS via prefers-color-scheme. */
export type Theme = (typeof THEMES)[number];
/** Concrete appearance applied to the document (never `system`). */
export type ResolvedTheme = Exclude<Theme, 'system'>;

/** --bg-base of each palette, as the mobile status bar paints it. Keyed on
 *  ResolvedTheme, so a new theme does not compile until it has one. */
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#f6f6f7',
  dark: '#0c0c0e',
  slate: '#252d38',
  'pure-black': '#000000',
  'forest-green': '#0b110d',
};

/** Whether a stored string is a theme we still ship. */
export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}
