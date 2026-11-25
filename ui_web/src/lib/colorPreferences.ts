import { CUSTOM_COLORS_KEY, deriveCustomColors, parseCustomColors, readCustomColors, stampCustomColors } from '../boot/customColors.js';
import { isTheme, loadTheme, THEME_COLORS, type ResolvedTheme, type Theme } from '../boot/themes';

export type CustomColors = NonNullable<ReturnType<typeof parseCustomColors>>;

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(theme: Theme, colors: CustomColors): ResolvedTheme {
  if (theme === 'custom') return deriveCustomColors(colors).scheme;
  return theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
}

export function paintTheme(theme: Theme, colors: CustomColors) {
  const palette = theme === 'custom' ? deriveCustomColors(colors) : null;
  const scheme = palette?.scheme ?? resolveTheme(theme, colors);
  const color = palette?.tokens['bg-base'] ?? THEME_COLORS[scheme];
  const root = document.documentElement;
  stampCustomColors(palette);
  if (root.dataset.theme !== scheme) root.dataset.theme = scheme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta?.getAttribute('content') !== color) meta?.setAttribute('content', color);
  return { scheme, color };
}

export function persistTheme(theme: Theme, colors: CustomColors): void {
  try {
    localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(colors));
    localStorage.setItem('theme', theme);
  } catch { /* The setting remains usable for this session. */ }
}

interface Appearance {
  theme: Theme;
  colors: CustomColors;
}

type SetAppearance = (theme: Theme, colors?: CustomColors, persist?: boolean) => void;
interface AppearanceAutomation {
  get(): Appearance;
  set(preference: unknown): Appearance;
}

declare global {
  interface Window { soundsibleAppearance?: AppearanceAutomation }
}

/** Device-local automation, with the same validation and live apply path as Settings. */
export function installAppearanceAutomation(read: () => Appearance, apply: SetAppearance): () => void {
  const get = () => {
    const { theme, colors } = read();
    return { theme, colors: { ...colors } };
  };
  const api: AppearanceAutomation = {
    get,
    set(preference) {
      const { theme, colors } = (preference ?? {}) as Partial<Appearance>;
      const seeds = colors === undefined ? undefined : parseCustomColors(colors);
      if (!isTheme(theme) || seeds === null) {
        throw new TypeError('Expected a theme and an optional pair of hex colors.');
      }
      apply(theme, seeds);
      return get();
    },
  };
  window.soundsibleAppearance = api;
  const sync = (event: StorageEvent) => {
    if (event.storageArea !== localStorage || (event.key !== null && event.key !== 'theme' && event.key !== CUSTOM_COLORS_KEY)) return;
    const theme = loadTheme();
    const colors = readCustomColors();
    const current = read();
    if (theme !== current.theme || colors.canvas !== current.colors.canvas || colors.accent !== current.colors.accent) {
      apply(theme, colors, false);
    }
  };
  window.addEventListener('storage', sync);
  return () => {
    if (window.soundsibleAppearance === api) delete window.soundsibleAppearance;
    window.removeEventListener('storage', sync);
  };
}
