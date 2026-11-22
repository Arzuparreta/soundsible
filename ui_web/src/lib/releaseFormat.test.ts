import { describe, expect, it } from 'vitest';
import { setLocale } from './i18n';
import { formatRecordType, formatReleaseDate, formatTotalDuration } from './releaseFormat';

describe('release metadata formatters', () => {
  it('formats total runtime in rounded minutes', () => {
    setLocale('en');
    expect(formatTotalDuration(3120)).toBe('52 min');
    expect(formatTotalDuration(20)).toBe('1 min');
    expect(formatTotalDuration(0)).toBe('');
    expect(formatTotalDuration(null)).toBe('');
  });

  it('formats localized ISO release dates and falls back to year', () => {
    setLocale('en');
    expect(formatReleaseDate('2020-05-14', 2020)).toContain('2020');
    expect(formatReleaseDate('2020-05-14', 2020)).toContain('14');
    expect(formatReleaseDate('', 2010)).toBe('2010');
    expect(formatReleaseDate('bad-date', 2010)).toBe('2010');
    expect(formatReleaseDate(undefined, null)).toBe('');
  });

  it('formats localized record types', () => {
    setLocale('en');
    expect(formatRecordType('album')).toBe('Album');
    expect(formatRecordType('single')).toBe('Single');
    expect(formatRecordType('ep')).toBe('EP');
    expect(formatRecordType('')).toBe('');
  });
});
