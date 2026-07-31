import { createSignal } from 'solid-js';
import { en, type Dict } from './i18n/en';

export type Locale = 'en' | 'es' | 'zh' | 'fr';

/** Locales offered in Settings, each with its own-language label so the picker
 * stays legible regardless of the active language. */
export const LOCALES: { code: Locale; label: string; native: string }[] = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'zh', label: 'Chinese', native: '中文' },
  { code: 'fr', label: 'French', native: 'Français' },
];

/**
 * `en` ships in the entry chunk because it is the fallback and the source of
 * the `Dict` type; the other three are fetched when they are first selected.
 * All four together were ~150 KB of the bundle, of which any one session reads
 * at most a quarter.
 */
const loaders: Record<Exclude<Locale, 'en'>, () => Promise<Dict>> = {
  es: () => import('./i18n/es').then((m) => m.es),
  zh: () => import('./i18n/zh').then((m) => m.zh),
  fr: () => import('./i18n/fr').then((m) => m.fr),
};

// Read by `t()`, so a dictionary arriving re-renders whatever displayed the
// English fallback in the meantime.
const [dictionaries, setDictionaries] = createSignal<Partial<Record<Locale, Dict>>>({ en });

const pending = new Map<Locale, Promise<void>>();

/** Fetch a locale's dictionary if it isn't loaded yet. Resolves when usable. */
function loadDictionary(l: Locale): Promise<void> {
  if (l === 'en' || dictionaries()[l]) return Promise.resolve();
  const inFlight = pending.get(l);
  if (inFlight) return inFlight;

  const task = loaders[l as Exclude<Locale, 'en'>]()
    .then((dict) => {
      setDictionaries((previous) => ({ ...previous, [l]: dict }));
    })
    .catch(() => {
      // A failed chunk fetch leaves the English fallback in place rather than
      // blanking the interface.
    })
    .finally(() => {
      pending.delete(l);
    });
  pending.set(l, task);
  return task;
}

const VALID: Locale[] = LOCALES.map((l) => l.code);

function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem('lang') as Locale | null;
    if (stored && VALID.includes(stored)) return stored;
  } catch {
    /* ignore */
  }
  return 'en';
}

const [current, setCurrent] = createSignal<Locale>(detectInitial());

/** Reactive current locale. Call inside a tracking scope to react to changes. */
export function locale(): Locale {
  return current();
}

function applyDocumentLocale(l: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = l;
}

/**
 * One-time bootstrap: syncs <html lang> and fetches the stored locale.
 *
 * Resolves once that dictionary is usable, so a caller that awaits it paints
 * in the right language instead of flashing English first.
 */
export function initLocale(): Promise<void> {
  applyDocumentLocale(current());
  return loadDictionary(current());
}

/**
 * Switch the active language, persisting it and updating <html lang>.
 *
 * Resolves when the new dictionary has loaded. The switch itself is immediate;
 * anything rendered before the chunk arrives shows English and re-renders.
 */
export function setLocale(l: Locale): Promise<void> {
  if (!VALID.includes(l) || l === current()) return Promise.resolve();
  setCurrent(l);
  try {
    localStorage.setItem('lang', l);
  } catch {
    /* ignore */
  }
  applyDocumentLocale(l);
  return loadDictionary(l);
}

function resolve(dict: Dict, path: string): string {
  let node: unknown = dict;
  for (const part of path.split('.')) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return path;
    }
  }
  return typeof node === 'string' ? node : path;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`,
  );
}

/**
 * Translate a dotted key (e.g. `nav.library`) using the active locale, interpolating
 * `{name}` placeholders from `params`. Reactive: reading it in a tracking scope
 * re-runs when the locale changes. Falls back to the key itself if missing.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = dictionaries()[current()] ?? en;
  return interpolate(resolve(dict, key), params);
}
