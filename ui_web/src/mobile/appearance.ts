import { createSignal } from 'solid-js';
import { registerPlugin } from '@capacitor/core';
import { isTheme, THEME_COLORS, type Theme, type ResolvedTheme } from '../boot/themes';
import { applyVisualPreferences, loadVisualPreferences, persistHighContrast, persistInterfaceSize, type InterfaceSize } from '../lib/visualPreferences';

interface AppearanceBridge { apply(options: { color: string }): Promise<void> }
interface SystemBarsBridge { setStyle(options: { style: 'LIGHT' | 'DARK' }): Promise<void> }
const native = registerPlugin<AppearanceBridge>('SoundsibleAppearance');
const systemBars = registerPlugin<SystemBarsBridge>('SystemBars');

/** Installation preference; never depends on the engine identity or audio stores. */
export function createNativeAppearance(notify: (theme: ResolvedTheme) => void = theme => {
  void systemBars.setStyle({ style: theme === 'light' ? 'LIGHT' : 'DARK' })
    .then(() => native.apply({ color: THEME_COLORS[theme] })).catch(() => {});
}) {
  let stored: unknown;
  try { stored = localStorage.getItem('theme'); } catch { /* Session preference remains usable. */ }
  const [theme, setTheme] = createSignal<Theme>(isTheme(stored) ? stored : 'system');
  const visual = loadVisualPreferences();
  const [interfaceSize, setInterfaceSize] = createSignal(visual.interfaceSize);
  const [highContrast, setHighContrast] = createSignal(visual.highContrast);
  let media: MediaQueryList | undefined;
  try { media = window.matchMedia('(prefers-color-scheme: dark)'); } catch { /* Dark is the fallback. */ }
  function apply() {
    const resolved = theme() === 'system' ? (media?.matches === false ? 'light' : 'dark') : theme() as ResolvedTheme;
    document.documentElement.dataset.theme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[resolved]);
    applyVisualPreferences({ interfaceSize: interfaceSize(), highContrast: highContrast() });
    notify(resolved);
  }
  const changed = () => apply();
  const visible = () => { if (document.visibilityState === 'visible') apply(); };
  media?.addEventListener('change', changed);
  document.addEventListener('visibilitychange', visible);
  apply();
  return {
    theme, interfaceSize, highContrast,
    setTheme(value: Theme) {
      if (!isTheme(value)) return;
      setTheme(value); try { localStorage.setItem('theme', value); } catch { /* Session only. */ } apply();
    },
    setInterfaceSize(value: InterfaceSize) { setInterfaceSize(value); persistInterfaceSize(value); apply(); },
    setHighContrast(value: boolean) { setHighContrast(value); persistHighContrast(value); apply(); },
    dispose() { media?.removeEventListener('change', changed); document.removeEventListener('visibilitychange', visible); },
  };
}
