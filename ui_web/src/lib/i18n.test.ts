import { beforeEach, describe, expect, it } from 'vitest';
import { LOCALES, locale, setLocale, t } from './i18n';
import { en } from './i18n/en';

beforeEach(async () => {
  await setLocale('en');
});

describe('translation lookup', () => {
  it('resolves a dotted key from the active dictionary', () => {
    expect(t('nav.library')).toBe(en.nav.library);
  });

  it('returns the key itself when nothing matches', () => {
    expect(t('nav.doesNotExist')).toBe('nav.doesNotExist');
  });

  it('interpolates named parameters', () => {
    expect(t('nav.library', { unused: 1 })).toBe(en.nav.library);
  });
});

describe('on-demand dictionaries', () => {
  it('switches language once the chunk has loaded', async () => {
    await setLocale('es');

    expect(locale()).toBe('es');
    expect(t('nav.library')).not.toBe(en.nav.library);
  });

  it('falls back to English for a locale still in flight', () => {
    // Deliberately not awaited: the switch is immediate, the dictionary is not.
    void setLocale('zh');

    expect(locale()).toBe('zh');
    expect(t('nav.library')).toBe(en.nav.library);
  });

  it('serves every advertised locale', async () => {
    for (const { code } of LOCALES) {
      await setLocale(code);
      expect(locale()).toBe(code);
      // A loaded dictionary answers a known key with a real string, not the key.
      expect(t('nav.library')).not.toBe('nav.library');
    }
  });

  it('reuses an already loaded dictionary', async () => {
    await setLocale('es');
    const first = t('nav.library');
    await setLocale('en');
    await setLocale('es');

    expect(t('nav.library')).toBe(first);
  });
});

describe('keys the source asks for', () => {
  /* A key missing from the dictionary does not fail anything: `t` hands the key
   * back and the screen shows `common.nothingPlaying` where a sentence belongs.
   * Component tests mock `t` to echo keys, so they cannot notice either. This
   * reads every literal key the app passes to `t`/`tr` and looks it up. */
  it('finds every literal key in the English dictionary', () => {
    const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!./i18n/**'], {
      query: '?raw', import: 'default', eager: true,
    });
    const missing: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const [, key] of text.matchAll(/\b(?:t|tr)\(\s*['"]([a-zA-Z]\w*(?:\.\w+)+)['"]/g)) {
        const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
        if (typeof value !== 'string') missing.push(`${file}: ${key}`);
      }
    }
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
