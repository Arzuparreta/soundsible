import { batch, createSignal } from 'solid-js';
import { registerPlugin } from '@capacitor/core';
import { readCustomColors } from '../boot/customColors.js';
import { isTheme, loadTheme, type Theme, type ResolvedTheme } from '../boot/themes';
import { installAppearanceAutomation, paintTheme, persistTheme, type CustomColors } from '../lib/colorPreferences';
import { applyVisualPreferences, loadVisualPreferences, persistHighContrast, persistInterfaceSize, type InterfaceSize } from '../lib/visualPreferences';

interface AppearanceBridge { apply(options: { color: string }): Promise<void> }
interface SystemBarsBridge { setStyle(options: { style: 'LIGHT' | 'DARK' }): Promise<void> }
const native = registerPlugin<AppearanceBridge>('SoundsibleAppearance');
const systemBars = registerPlugin<SystemBarsBridge>('SystemBars');

/** Installation preference; never depends on the engine identity or audio stores. */
export function createNativeAppearance(notify: (theme: ResolvedTheme, color: string) => void | Promise<void> = async (theme, color) => {
  await systemBars.setStyle({ style: theme === 'light' ? 'LIGHT' : 'DARK' });
  await native.apply({ color });
}) {
  const [theme, setTheme] = createSignal(loadTheme());
  const [colors, setColors] = createSignal<CustomColors>(readCustomColors());
  const visual = loadVisualPreferences();
  const [interfaceSize, setInterfaceSize] = createSignal(visual.interfaceSize);
  const [highContrast, setHighContrast] = createSignal(visual.highContrast);
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
  let latest: ReturnType<typeof paintTheme> | undefined;
  let sending = false;
  let last = '';
  async function notifyNative() {
    if (sending) return;
    sending = true;
    try {
      while (latest) {
        const { scheme, color } = latest;
        latest = undefined;
        try { await notify(scheme, color); } catch { /* Browser preview has no native bars. */ }
      }
    } finally {
      sending = false;
    }
  }
  function apply(forceNative = false) {
    const paint = paintTheme(theme(), colors());
    applyVisualPreferences({ interfaceSize: interfaceSize(), highContrast: highContrast() });
    const stamp = paint.scheme + paint.color;
    if (!forceNative && stamp === last) return;
    last = stamp;
    latest = paint;
    void notifyNative();
  }
  function update(value: Theme, seeds = colors(), persist = true) {
    if (!isTheme(value)) return;
    batch(() => {
      setTheme(value);
      setColors(seeds);
    });
    if (persist) persistTheme(value, seeds);
    apply();
  }
  const removeAutomation = installAppearanceAutomation(() => ({ theme: theme(), colors: colors() }), update);
  // Android can reset its window chrome during a configuration change even
  // when an explicit palette leaves the WebView colors unchanged.
  const systemChanged = () => apply(true);
  const visible = () => { if (document.visibilityState === 'visible') apply(true); };
  media?.addEventListener('change', systemChanged);
  document.addEventListener('visibilitychange', visible);
  apply();
  return {
    theme, colors, interfaceSize, highContrast, setTheme: update,
    setInterfaceSize(value: InterfaceSize) { setInterfaceSize(value); persistInterfaceSize(value); apply(); },
    setHighContrast(value: boolean) { setHighContrast(value); persistHighContrast(value); apply(); },
    dispose() {
      latest = undefined;
      removeAutomation();
      media?.removeEventListener('change', systemChanged);
      document.removeEventListener('visibilitychange', visible);
    },
  };
}
