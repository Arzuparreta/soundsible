/** User theme preferences accepted by both the splash and the running app. */
export const THEMES = ['light', 'dark', 'system', 'custom'] as const;
export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = 'light' | 'dark';

/** Built-in canvas colors, also used before app styles arrive. */
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#f6f6f7',
  dark: '#0c0c0e',
};

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem('theme');
    if (isTheme(stored)) return stored;
  } catch { /* Storage may be unavailable before the app starts. */ }
  return 'system';
}
