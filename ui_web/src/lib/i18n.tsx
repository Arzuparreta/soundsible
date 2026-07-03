import { createSignal } from 'solid-js';
import { en, type Dict } from './i18n/en';
import { es } from './i18n/es';
import { zh } from './i18n/zh';
import { fr } from './i18n/fr';

export type Locale = 'en' | 'es' | 'zh' | 'fr';

/** Locales offered in Settings, each with its own-language label so the picker
 * stays legible regardless of the active language. */
export const LOCALES: { code: Locale; label: string; native: string }[] = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'zh', label: 'Chinese', native: '中文' },
  { code: 'fr', label: 'French', native: 'Français' },
];

const dictionaries: Record<Locale, Dict> = { en, es, zh, fr };

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

/** One-time bootstrap: syncs <html lang> with the resolved initial locale. */
export function initLocale(): void {
  applyDocumentLocale(current());
}

/** Switch the active language, persisting it and updating <html lang>. */
export function setLocale(l: Locale): void {
  if (!VALID.includes(l) || l === current()) return;
  setCurrent(l);
  try {
    localStorage.setItem('lang', l);
  } catch {
    /* ignore */
  }
  applyDocumentLocale(l);
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
 * Translate a dotted key (e.g. `nav.home`) using the active locale, interpolating
 * `{name}` placeholders from `params`. Reactive: reading it in a tracking scope
 * re-runs when the locale changes. Falls back to the key itself if missing.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  return interpolate(resolve(dictionaries[current()], key), params);
}