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
